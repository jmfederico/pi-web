#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, resolve as resolvePath, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { FrpcProcessManager } from "@jmfederico/pi-web-tunnel-frp-engine";

import {
  createDefaultConnectorConfig,
  readConnectorConfig,
  writeConnectorConfig,
  type ConnectorConfig,
  type ConnectorMachineCredentials,
} from "./config-storage.js";
import {
  applyConnectorLoginResultToConfig,
  connectorLoginClientVersion,
  runConnectorLoginFlow,
  type ConnectorLoginArgs,
} from "./connector-login.js";
import {
  createNodeConnectorRuntimeDependencies,
  resolveConnectorRuntimePaths,
  runConnectorStart,
  runConnectorStop,
  type ConnectorRuntimeDependencies,
  type ConnectorRuntimePaths,
  type FetchLike,
  type FetchLikeRequestInit,
} from "./connector-runtime.js";

export const connectorConfigDirectoryName = "pi-web-tunnel";
export const connectorConfigFileName = "config.json";
export const connectorLogFileName = "connector.log";
export const connectorStatusFormatVersion = 1;

const maxStatusLogTailCharacters = 12_000;
const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

type PathApi = Pick<typeof posix, "join">;

export interface ConfigPathDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
}

export type ConnectorConfigStatusState = "missing" | "unregistered" | "registered" | "invalid";
export type ConnectorRuntimeStatusState = "stopped" | "running" | "stale" | "unknown";

export interface ConnectorMachineStatus {
  readonly controlApiBaseUrl: string;
  readonly machineId: string;
  readonly machineSlug?: string;
  readonly publicUrl?: string;
}

export interface ConnectorConfigStatus {
  readonly path: string;
  readonly exists: boolean;
  readonly state: ConnectorConfigStatusState;
  readonly localPiWebUrl?: string;
  readonly frpcPathConfigured?: boolean;
  readonly machine?: ConnectorMachineStatus;
  readonly error?: string;
}

export interface ConnectorRuntimeStatus {
  readonly pidFilePath: string;
  readonly frpcConfigPath: string;
  readonly frpcConfigExists: boolean;
  readonly state: ConnectorRuntimeStatusState;
  readonly pid?: number;
  readonly error?: string;
}

export interface ConnectorLogStatus {
  readonly path: string;
  readonly exists: boolean;
  readonly tailMaxCharacters: number;
  readonly tail?: string;
  readonly error?: string;
}

export interface ConnectorStatus {
  readonly statusVersion: typeof connectorStatusFormatVersion;
  readonly config: ConnectorConfigStatus;
  readonly runtime: ConnectorRuntimeStatus;
  readonly log: ConnectorLogStatus;
}

export interface StatusDependencies {
  readonly configPath: string;
  readonly runtimePaths: ConnectorRuntimePaths;
  readonly logPath: string;
  readonly fileExists: (path: string) => boolean;
  readonly processExists: (pid: number) => boolean;
  readonly readConfig: (configPath: string) => ConnectorConfig;
  readonly readFile: (path: string) => string;
}

export interface OutputSink {
  write(chunk: string): void;
}

export interface CliDependencies extends ConfigPathDependencies {
  readonly argv: readonly string[];
  readonly createProcessManager: () => FrpcProcessManager;
  readonly fetch: FetchLike;
  readonly fileExists: (path: string) => boolean;
  readonly now: () => Date;
  readonly pid: number;
  readonly processExists: (pid: number) => boolean;
  readonly readConfig: (configPath: string) => ConnectorConfig;
  readonly registerSignalHandler: (signal: NodeJS.Signals, handler: () => void) => void;
  readonly runtime: ConnectorRuntimeDependencies;
  readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly writeConfig: (configPath: string, config: ConnectorConfig) => void;
  readonly stderr: OutputSink;
  readonly stdout: OutputSink;
}

export interface StartArgs {
  readonly frpcPath?: string;
}

export interface RegisterMachineArgs {
  readonly controlApiBaseUrl: string;
  readonly machineId: string;
  readonly machineToken: string;
  readonly localPiWebUrl?: string;
  readonly frpcPath?: string;
}

export interface StatusArgs {
  readonly json: boolean;
}

type CliCommand =
  | { readonly kind: "config-path" }
  | { readonly kind: "help" }
  | { readonly kind: "login"; readonly args: readonly string[] }
  | { readonly kind: "register-machine"; readonly args: readonly string[] }
  | { readonly kind: "start"; readonly args: readonly string[] }
  | { readonly kind: "stop"; readonly args: readonly string[] }
  | { readonly kind: "status"; readonly args: readonly string[] }
  | { readonly command: string; readonly kind: "unknown" };

export function createDefaultCliDependencies(argv: readonly string[]): CliDependencies {
  return {
    argv,
    createProcessManager: () => new FrpcProcessManager(),
    env: process.env,
    fetch: (input, init) => fetch(input, createFetchRequestInit(init)),
    fileExists: existsSync,
    homeDirectory: homedir(),
    now: () => new Date(),
    pid: process.pid,
    platform: process.platform,
    processExists: defaultProcessExists,
    readConfig: (configPath) => readConnectorConfig(configPath),
    registerSignalHandler: (signal, handler) => {
      process.once(signal, handler);
    },
    runtime: createNodeConnectorRuntimeDependencies(),
    signalProcess: (pid, signal) => {
      process.kill(pid, signal);
    },
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    writeConfig: (configPath, config) => {
      writeConnectorConfig(configPath, config);
    },
    stderr: process.stderr,
    stdout: process.stdout,
  };
}

export function discoverConnectorConfigDirectory(dependencies: ConfigPathDependencies): string {
  const homeDirectory = requireHomeDirectory(dependencies.homeDirectory);
  const pathApi = pathApiForPlatform(dependencies.platform);

  if (dependencies.platform === "win32") {
    const configRoot = nonEmptyString(dependencies.env["APPDATA"]) ?? pathApi.join(homeDirectory, "AppData", "Roaming");
    return pathApi.join(configRoot, connectorConfigDirectoryName);
  }

  const configRoot = nonEmptyString(dependencies.env["XDG_CONFIG_HOME"]) ?? pathApi.join(homeDirectory, ".config");
  return pathApi.join(configRoot, connectorConfigDirectoryName);
}

export function discoverConnectorConfigPath(dependencies: ConfigPathDependencies): string {
  const pathApi = pathApiForPlatform(dependencies.platform);
  return pathApi.join(discoverConnectorConfigDirectory(dependencies), connectorConfigFileName);
}

export function readConnectorStatus(dependencies: StatusDependencies): ConnectorStatus {
  return {
    statusVersion: connectorStatusFormatVersion,
    config: readConnectorConfigStatus(dependencies),
    runtime: readConnectorRuntimeStatus(dependencies),
    log: readConnectorLogStatus(dependencies),
  };
}

function readConnectorConfigStatus(dependencies: StatusDependencies): ConnectorConfigStatus {
  if (!dependencies.fileExists(dependencies.configPath)) {
    return { exists: false, path: dependencies.configPath, state: "missing" };
  }

  try {
    const config = dependencies.readConfig(dependencies.configPath);
    const status: ConnectorConfigStatus = {
      exists: true,
      path: dependencies.configPath,
      state: config.machine === undefined ? "unregistered" : "registered",
      localPiWebUrl: config.localPiWebUrl,
      frpcPathConfigured: config.frpcPath !== undefined,
    };

    return config.machine === undefined
      ? status
      : { ...status, machine: connectorMachineStatus(config.machine) };
  } catch (error) {
    return {
      exists: true,
      path: dependencies.configPath,
      state: "invalid",
      error: errorMessage(error),
    };
  }
}

function connectorMachineStatus(credentials: ConnectorMachineCredentials): ConnectorMachineStatus {
  return {
    controlApiBaseUrl: credentials.controlApiBaseUrl,
    machineId: credentials.machineId,
    ...(credentials.machineSlug === undefined ? {} : { machineSlug: credentials.machineSlug }),
    ...(credentials.publicUrl === undefined ? {} : { publicUrl: credentials.publicUrl }),
  };
}

function readConnectorRuntimeStatus(dependencies: StatusDependencies): ConnectorRuntimeStatus {
  const base = {
    pidFilePath: dependencies.runtimePaths.pidFilePath,
    frpcConfigPath: dependencies.runtimePaths.frpcConfigPath,
    frpcConfigExists: dependencies.fileExists(dependencies.runtimePaths.frpcConfigPath),
  };

  if (!dependencies.fileExists(dependencies.runtimePaths.pidFilePath)) {
    return { ...base, state: "stopped" };
  }

  try {
    const pid = parseConnectorPidFile(dependencies.readFile(dependencies.runtimePaths.pidFilePath));
    return dependencies.processExists(pid)
      ? { ...base, state: "running", pid }
      : { ...base, state: "stale", pid };
  } catch (error) {
    return { ...base, state: "unknown", error: errorMessage(error) };
  }
}

function readConnectorLogStatus(dependencies: StatusDependencies): ConnectorLogStatus {
  const base = {
    path: dependencies.logPath,
    tailMaxCharacters: maxStatusLogTailCharacters,
  };

  if (!dependencies.fileExists(dependencies.logPath)) {
    return { ...base, exists: false };
  }

  try {
    const tail = tailText(
      sanitizeConnectorLog(dependencies.readFile(dependencies.logPath)),
      maxStatusLogTailCharacters,
    );

    return tail.length === 0
      ? { ...base, exists: true }
      : { ...base, exists: true, tail };
  } catch (error) {
    return { ...base, exists: true, error: errorMessage(error) };
  }
}

function parseConnectorPidFile(contents: string): number {
  const trimmed = contents.trim();

  if (!/^[1-9]\d*$/u.test(trimmed)) {
    throw new Error("Connector PID file is malformed.");
  }

  return Number.parseInt(trimmed, 10);
}

function sanitizeConnectorLog(contents: string): string {
  return contents.replace(ansiEscapePattern, "");
}

function tailText(contents: string, maxCharacters: number): string {
  if (contents.length <= maxCharacters) return contents;
  return contents.slice(contents.length - maxCharacters);
}

export function parseCliCommand(argv: readonly string[]): CliCommand {
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h") {
    return { kind: "help" };
  }

  if (command === "status") {
    return { args: argv.slice(1), kind: "status" };
  }

  if (command === "config-path") {
    return { kind: "config-path" };
  }

  if (command === "login") {
    return { args: argv.slice(1), kind: "login" };
  }

  if (command === "register-machine") {
    return { args: argv.slice(1), kind: "register-machine" };
  }

  if (command === "start") {
    return { args: argv.slice(1), kind: "start" };
  }

  if (command === "stop") {
    return { args: argv.slice(1), kind: "stop" };
  }

  return { command, kind: "unknown" };
}

export async function runCli(dependencies: CliDependencies): Promise<number> {
  try {
    return await runCliCommand(dependencies);
  } catch (error) {
    writeLine(dependencies.stderr, formatCliError(error));
    return 1;
  }
}

async function runCliCommand(dependencies: CliDependencies): Promise<number> {
  const command = parseCliCommand(dependencies.argv);

  switch (command.kind) {
    case "help":
      printHelp(dependencies.stdout);
      return 0;

    case "config-path":
      writeLine(dependencies.stdout, discoverConnectorConfigPath(dependencies));
      return 0;

    case "status": {
      const statusArgs = parseStatusArgs(command.args);
      const status = readCliConnectorStatus(dependencies);

      if (statusArgs.json) {
        printJsonStatus(dependencies.stdout, status);
      } else {
        printStatus(dependencies.stdout, status);
      }
      return 0;
    }

    case "login":
      return runLoginCommand(dependencies, command.args);

    case "register-machine":
      return runRegisterMachineCommand(dependencies, command.args);

    case "start":
      return runStartCommand(dependencies, command.args);

    case "stop":
      return runStopCommand(dependencies, command.args);

    case "unknown":
      writeLine(dependencies.stderr, `Unknown command: ${command.command}`);
      writeLine(dependencies.stderr, "Run `pi-web-tunnel --help` for usage.");
      return 2;
  }
}

async function runLoginCommand(dependencies: CliDependencies, args: readonly string[]): Promise<number> {
  const loginArgs = parseLoginArgs(args);
  const configPath = discoverConnectorConfigPath(dependencies);
  const existingConfig = dependencies.fileExists(configPath)
    ? dependencies.readConfig(configPath)
    : createDefaultConnectorConfig();
  const localPiWebUrl = loginArgs.localPiWebUrl ?? existingConfig.localPiWebUrl;
  const loginResult = await runConnectorLoginFlow({
    controlApiBaseUrl: loginArgs.controlApiBaseUrl,
    machineName: loginArgs.machineName,
    machineSlug: loginArgs.machineSlug,
    localPiWebUrl,
    connectorVersion: connectorLoginClientVersion,
    fetch: dependencies.fetch,
    now: dependencies.now,
    sleep: dependencies.sleep,
    stdout: dependencies.stdout,
  });
  const nextConfig = applyConnectorLoginResultToConfig(existingConfig, loginArgs, loginResult);

  dependencies.writeConfig(configPath, nextConfig);

  writeLine(dependencies.stdout, "Logged in and registered this machine for PI WEB Safe Tunnels.");
  writeLine(dependencies.stdout, `Machine id: ${loginResult.registeredMachine.machine.id}`);
  writeLine(dependencies.stdout, `Public URL: ${loginResult.registeredMachine.publicUrl}`);
  writeLine(dependencies.stdout, `Config path: ${configPath}`);
  return 0;
}

async function runStartCommand(dependencies: CliDependencies, args: readonly string[]): Promise<number> {
  const startArgs = parseStartArgs(args);
  const configPath = discoverConnectorConfigPath(dependencies);

  if (!dependencies.fileExists(configPath)) {
    writeLine(
      dependencies.stderr,
      "No connector config found. Run `pi-web-tunnel login` or `pi-web-tunnel register-machine` first.",
    );
    return 1;
  }

  const config = dependencies.readConfig(configPath);
  const paths = resolveConnectorRuntimePaths(
    discoverConnectorConfigDirectory(dependencies),
    dependencies.platform,
  );

  return runConnectorStart({
    ...dependencies.runtime,
    config,
    fetch: dependencies.fetch,
    paths,
    pid: dependencies.pid,
    processManager: dependencies.createProcessManager(),
    registerSignalHandler: dependencies.registerSignalHandler,
    stdout: dependencies.stdout,
    ...(startArgs.frpcPath !== undefined ? { frpcPathOverride: startArgs.frpcPath } : {}),
  });
}

function runStopCommand(dependencies: CliDependencies, args: readonly string[]): number {
  parseNoArgs(args, "stop");
  const paths = resolveConnectorRuntimePaths(
    discoverConnectorConfigDirectory(dependencies),
    dependencies.platform,
  );

  return runConnectorStop({
    ...dependencies.runtime,
    paths,
    signalProcess: dependencies.signalProcess,
    stdout: dependencies.stdout,
  });
}

function readCliConnectorStatus(dependencies: CliDependencies): ConnectorStatus {
  const configDirectory = discoverConnectorConfigDirectory(dependencies);
  const pathApi = pathApiForPlatform(dependencies.platform);

  return readConnectorStatus({
    configPath: pathApi.join(configDirectory, connectorConfigFileName),
    runtimePaths: resolveConnectorRuntimePaths(configDirectory, dependencies.platform),
    logPath: pathApi.join(configDirectory, connectorLogFileName),
    fileExists: dependencies.fileExists,
    processExists: dependencies.processExists,
    readConfig: dependencies.readConfig,
    readFile: dependencies.runtime.readFile,
  });
}

export function parseLoginArgs(args: readonly string[]): ConnectorLoginArgs {
  let controlApiBaseUrl: string | undefined;
  let machineName: string | undefined;
  let machineSlug: string | undefined;
  let localPiWebUrl: string | undefined;
  let frpcPath: string | undefined;
  let index = 0;

  while (index < args.length) {
    const flag = args[index];

    switch (flag) {
      case undefined:
        throw new Error("Unexpected missing login argument.");

      case "--control-api-url":
        controlApiBaseUrl = readFlagValue(args, index, flag);
        index += 2;
        break;

      case "--machine-name":
        machineName = readFlagValue(args, index, flag);
        index += 2;
        break;

      case "--machine-slug":
        machineSlug = readFlagValue(args, index, flag);
        index += 2;
        break;

      case "--local-pi-web-url":
        localPiWebUrl = readFlagValue(args, index, flag);
        index += 2;
        break;

      case "--frpc-path":
        frpcPath = readFlagValue(args, index, flag);
        index += 2;
        break;

      default:
        throw new Error(`Unknown login option: ${flag}`);
    }
  }

  if (controlApiBaseUrl === undefined) {
    throw new Error("login requires --control-api-url <url>.");
  }

  if (machineName === undefined) {
    throw new Error("login requires --machine-name <name>.");
  }

  if (machineSlug === undefined) {
    throw new Error("login requires --machine-slug <slug>.");
  }

  const base: ConnectorLoginArgs = { controlApiBaseUrl, machineName, machineSlug };

  if (localPiWebUrl !== undefined && frpcPath !== undefined) {
    return { ...base, localPiWebUrl, frpcPath };
  }

  if (localPiWebUrl !== undefined) {
    return { ...base, localPiWebUrl };
  }

  if (frpcPath !== undefined) {
    return { ...base, frpcPath };
  }

  return base;
}

export function parseStatusArgs(args: readonly string[]): StatusArgs {
  let json = false;
  let index = 0;

  while (index < args.length) {
    const flag = args[index];

    if (flag === "--json") {
      json = true;
      index += 1;
      continue;
    }

    throw new Error(`Unknown status option: ${flag ?? ""}`);
  }

  return { json };
}

export function parseStartArgs(args: readonly string[]): StartArgs {
  let frpcPath: string | undefined;
  let index = 0;

  while (index < args.length) {
    const flag = args[index];

    if (flag === "--frpc-path") {
      frpcPath = readFlagValue(args, index, flag);
      index += 2;
      continue;
    }

    throw new Error(`Unknown start option: ${flag ?? ""}`);
  }

  return frpcPath !== undefined ? { frpcPath } : {};
}

function parseNoArgs(args: readonly string[], command: string): void {
  const first = args[0];

  if (first !== undefined) {
    throw new Error(`Unknown ${command} option: ${first}`);
  }
}

function runRegisterMachineCommand(dependencies: CliDependencies, args: readonly string[]): number {
  const registerArgs = parseRegisterMachineArgs(args);
  const configPath = discoverConnectorConfigPath(dependencies);
  const existingConfig = dependencies.fileExists(configPath)
    ? dependencies.readConfig(configPath)
    : createDefaultConnectorConfig();
  const nextConfig = applyRegisterMachineArgs(existingConfig, registerArgs);

  dependencies.writeConfig(configPath, nextConfig);

  writeLine(dependencies.stdout, "Registered machine credentials for PI WEB Safe Tunnels.");
  writeLine(dependencies.stdout, `Machine id: ${nextConfig.machine?.machineId ?? registerArgs.machineId}`);
  writeLine(dependencies.stdout, `Control API: ${registerArgs.controlApiBaseUrl}`);
  writeLine(dependencies.stdout, `Config path: ${configPath}`);
  return 0;
}

export function parseRegisterMachineArgs(args: readonly string[]): RegisterMachineArgs {
  let controlApiBaseUrl: string | undefined;
  let machineId: string | undefined;
  let machineToken: string | undefined;
  let localPiWebUrl: string | undefined;
  let frpcPath: string | undefined;
  let index = 0;

  while (index < args.length) {
    const flag = args[index];

    switch (flag) {
      case undefined:
        throw new Error("Unexpected missing register-machine argument.");

      case "--control-api-url":
        controlApiBaseUrl = readFlagValue(args, index, flag);
        index += 2;
        break;

      case "--machine-id":
        machineId = readFlagValue(args, index, flag);
        index += 2;
        break;

      case "--machine-token":
        machineToken = readFlagValue(args, index, flag);
        index += 2;
        break;

      case "--local-pi-web-url":
        localPiWebUrl = readFlagValue(args, index, flag);
        index += 2;
        break;

      case "--frpc-path":
        frpcPath = readFlagValue(args, index, flag);
        index += 2;
        break;

      default:
        throw new Error(`Unknown register-machine option: ${flag}`);
    }
  }

  if (controlApiBaseUrl === undefined) {
    throw new Error("register-machine requires --control-api-url <url>.");
  }

  if (machineId === undefined) {
    throw new Error("register-machine requires --machine-id <id>.");
  }

  if (machineToken === undefined) {
    throw new Error("register-machine requires --machine-token <token>.");
  }

  const base: RegisterMachineArgs = { controlApiBaseUrl, machineId, machineToken };

  if (localPiWebUrl !== undefined && frpcPath !== undefined) {
    return { ...base, localPiWebUrl, frpcPath };
  }

  if (localPiWebUrl !== undefined) {
    return { ...base, localPiWebUrl };
  }

  if (frpcPath !== undefined) {
    return { ...base, frpcPath };
  }

  return base;
}

function applyRegisterMachineArgs(existing: ConnectorConfig, args: RegisterMachineArgs): ConnectorConfig {
  const next: ConnectorConfig = {
    localPiWebUrl: args.localPiWebUrl ?? existing.localPiWebUrl,
    schemaVersion: existing.schemaVersion,
    machine: {
      controlApiBaseUrl: args.controlApiBaseUrl,
      machineId: args.machineId,
      machineToken: args.machineToken,
    },
  };

  const frpcPath = args.frpcPath ?? existing.frpcPath;

  if (frpcPath !== undefined) {
    return { ...next, frpcPath };
  }

  return next;
}

function readFlagValue(args: readonly string[], flagIndex: number, flagName: string): string {
  const value = args[flagIndex + 1];

  if (value === undefined) {
    throw new Error(`${flagName} requires a value.`);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error(`${flagName} must not be blank.`);
  }

  return trimmed;
}

function printHelp(stdout: OutputSink): void {
  writeLine(stdout, "Usage: pi-web-tunnel <command>");
  writeLine(stdout, "");
  writeLine(stdout, "Commands:");
  writeLine(stdout, "  login             Authenticate and register this machine with the hosted service.");
  writeLine(stdout, "  register-machine  Persist bootstrap-issued machine credentials locally.");
  writeLine(stdout, "  start             Start the PI WEB Safe Tunnel connector.");
  writeLine(stdout, "  status [--json]   Show connector status and the discovered config path.");
  writeLine(stdout, "  stop              Stop the PI WEB Safe Tunnel connector.");
  writeLine(stdout, "  config-path       Print the discovered connector config path.");
}

function printStatus(stdout: OutputSink, status: ConnectorStatus): void {
  writeLine(stdout, "PI WEB Safe Tunnel connector");
  writeLine(stdout, `Status: ${formatConfigStatusLabel(status.config.state)}`);
  writeLine(stdout, `Config path: ${status.config.path}`);
  writeLine(stdout, `Runtime: ${formatRuntimeStatus(status.runtime)}`);

  if (status.config.localPiWebUrl !== undefined) {
    writeLine(stdout, `Local target: ${status.config.localPiWebUrl}`);
  }

  if (status.config.frpcPathConfigured !== undefined) {
    writeLine(stdout, `frpc path configured: ${status.config.frpcPathConfigured ? "yes" : "no"}`);
  }

  if (status.config.machine !== undefined) {
    writeLine(stdout, `Machine id: ${status.config.machine.machineId}`);
    if (status.config.machine.machineSlug !== undefined) {
      writeLine(stdout, `Machine slug: ${status.config.machine.machineSlug}`);
    }
    if (status.config.machine.publicUrl !== undefined) {
      writeLine(stdout, `Public URL: ${status.config.machine.publicUrl}`);
    }
  }

  if (status.config.error !== undefined) {
    writeLine(stdout, `Config error: ${status.config.error}`);
  }

  if (status.runtime.error !== undefined) {
    writeLine(stdout, `Runtime error: ${status.runtime.error}`);
  }
}

function printJsonStatus(stdout: OutputSink, status: ConnectorStatus): void {
  writeLine(stdout, JSON.stringify(status, null, 2));
}

function formatConfigStatusLabel(state: ConnectorConfigStatusState): string {
  if (state === "missing") return "not configured";
  return state;
}

function formatRuntimeStatus(status: ConnectorRuntimeStatus): string {
  if (status.pid === undefined) {
    return status.state;
  }

  return `${status.state} (pid ${status.pid.toString()})`;
}

function formatCliError(error: unknown): string {
  if (error instanceof Error) {
    return `pi-web-tunnel: ${error.message}`;
  }

  return "pi-web-tunnel: unexpected non-error failure";
}

function createFetchRequestInit(init: FetchLikeRequestInit | undefined): RequestInit | undefined {
  if (init === undefined) {
    return undefined;
  }

  const requestInit: RequestInit = {};

  if (init.method !== undefined) {
    requestInit.method = init.method;
  }

  if (init.body !== undefined) {
    requestInit.body = init.body;
  }

  if (init.headers !== undefined) {
    requestInit.headers = { ...init.headers };
  }

  return requestInit;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function nonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return trimmed;
}

function requireHomeDirectory(homeDirectory: string): string {
  const normalizedHomeDirectory = nonEmptyString(homeDirectory);

  if (normalizedHomeDirectory === undefined) {
    throw new Error("Unable to discover a home directory for the PI WEB tunnel connector config.");
  }

  return normalizedHomeDirectory;
}

function pathApiForPlatform(platform: NodeJS.Platform): PathApi {
  if (platform === "win32") {
    return win32;
  }

  return posix;
}

function writeLine(sink: OutputSink, line: string): void {
  sink.write(`${line}\n`);
}

function isCliEntryPoint(moduleUrl: string, executablePath: string | undefined): boolean {
  if (executablePath === undefined) {
    return false;
  }

  return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolvePath(executablePath));
}

if (isCliEntryPoint(import.meta.url, process.argv[1])) {
  void runCli(createDefaultCliDependencies(process.argv.slice(2))).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
