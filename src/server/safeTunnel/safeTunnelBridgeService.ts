import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  SafeTunnelCommandOutput,
  SafeTunnelConfigStatus,
  SafeTunnelLoginRequest,
  SafeTunnelLoginResponse,
  SafeTunnelOperationResponse,
  SafeTunnelRuntimeStatus,
  SafeTunnelStartRequest,
  SafeTunnelStartResponse,
  SafeTunnelStatusResponse,
  SafeTunnelStopResponse,
} from "../../shared/apiTypes.js";
import { SafeTunnelConnectorManager } from "./safeTunnelConnectorManager.js";

const connectorConfigDirectoryName = "pi-web-tunnel";
const connectorConfigFileName = "config.json";
const connectorPidFileName = "connector.pid";
const connectorLogFileName = "connector.log";
const connectorLogDirectoryMode = 0o700;
const connectorLogFileMode = 0o600;
const stopCommandTimeoutMs = 15_000;
const loginCommandTimeoutMs = 15 * 60_000;
const startCommandTimeoutMs = 0;
const maxCapturedOutputCharacters = 24_000;
const maxConnectorLogTailCharacters = 12_000;
const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

interface PathApi {
  dirname(path: string): string;
  join(...paths: string[]): string;
}

export interface SafeTunnelCommandInvocation {
  readonly args: readonly string[];
  readonly command: string;
}

export interface SafeTunnelCommandRunOptions {
  readonly maxOutputCharacters: number;
  readonly timeoutMs: number;
  readonly detached?: boolean;
  readonly logHeader?: string;
  readonly logPath?: string;
  readonly onProcessId?: (processId: number) => void;
  readonly onStderr?: (chunk: string) => void;
  readonly onStdout?: (chunk: string) => void;
}

export interface SafeTunnelCommandRunResult extends SafeTunnelCommandOutput {
  readonly timedOut: boolean;
}

export interface SafeTunnelCommandRunner {
  run(invocation: SafeTunnelCommandInvocation, options: SafeTunnelCommandRunOptions): Promise<SafeTunnelCommandRunResult>;
}

export interface SafeTunnelBridgeService {
  status(): Promise<SafeTunnelStatusResponse>;
  login(request: SafeTunnelLoginRequest): Promise<SafeTunnelLoginResponse>;
  operation(operationId: string): SafeTunnelOperationResponse | undefined;
  start(request: SafeTunnelStartRequest): Promise<SafeTunnelStartResponse>;
  stop(): Promise<SafeTunnelStopResponse>;
}

export interface SafeTunnelBridgeDependencies {
  readonly commandRunner: SafeTunnelCommandRunner;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fileExists: (path: string) => boolean;
  readonly homeDirectory: string;
  readonly now: () => Date;
  readonly platform: NodeJS.Platform;
}

interface SafeTunnelOperationState {
  readonly id: string;
  readonly kind: "login" | "start";
  readonly startedAt: string;
  status: "running" | "succeeded" | "failed";
  stdout: string;
  stderr: string;
  connectorProcessId?: number;
  error?: string;
  exitCode?: number | null;
  finishedAt?: string;
  logPath?: string;
  logTail?: string;
  logTailMaxCharacters?: number;
  publicUrl?: string;
  signal?: string;
  userCode?: string;
  verificationUriComplete?: string;
}

export class SafeTunnelBridgeError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export class DefaultSafeTunnelBridgeService implements SafeTunnelBridgeService {
  private activeOperation: SafeTunnelOperationState | undefined;
  private operationStartInFlight = false;
  private readonly connectorManager: SafeTunnelConnectorManager;
  private readonly operations = new Map<string, SafeTunnelOperationState>();

  constructor(private readonly dependencies: SafeTunnelBridgeDependencies) {
    this.connectorManager = new SafeTunnelConnectorManager({
      commandRunner: dependencies.commandRunner,
      cwd: dependencies.cwd,
      env: dependencies.env,
      fileExists: dependencies.fileExists,
      homeDirectory: dependencies.homeDirectory,
      platform: dependencies.platform,
    });
  }

  async status(): Promise<SafeTunnelStatusResponse> {
    const connectorProbe = await this.connectorManager.probeStatus();
    const connectorStatus = connectorProbe.statusJson === undefined
      ? fallbackConnectorStatusData("Connector status JSON is unavailable.", this.dependencies)
      : parseConnectorStatusData(connectorProbe.statusJson, this.dependencies);
    const activeOperation = this.activeOperation === undefined ? undefined : snapshotOperation(this.activeOperation);

    return {
      connector: connectorProbe.connector,
      config: connectorStatus.config,
      runtime: connectorStatus.runtime,
      ...(activeOperation === undefined ? {} : { activeOperation }),
    };
  }

  async login(request: SafeTunnelLoginRequest): Promise<SafeTunnelLoginResponse> {
    if (this.operationStartInFlight || this.activeOperation?.status === "running") {
      throw new SafeTunnelBridgeError("A Safe Tunnel operation is already running.", 409);
    }

    this.operationStartInFlight = true;
    try {
      const command = await this.connectorManager.ensureCommand();
      const operation = this.createLoginOperation();
      const invocation: SafeTunnelCommandInvocation = {
        command,
        args: loginArgs(request),
      };

      const completion = this.dependencies.commandRunner.run(invocation, {
        maxOutputCharacters: maxCapturedOutputCharacters,
        timeoutMs: loginCommandTimeoutMs,
        onStdout: (chunk) => {
          appendOperationStdout(operation, chunk);
        },
        onStderr: (chunk) => {
          appendOperationStderr(operation, chunk);
        },
      }).then(
        (result) => {
          this.finishOperation(operation, result);
        },
        (error: unknown) => {
          this.failOperation(operation, error);
        },
      );
      void completion;

      return {
        operation: snapshotOperation(operation),
        status: await this.status(),
      };
    } finally {
      this.operationStartInFlight = false;
    }
  }

  operation(operationId: string): SafeTunnelOperationResponse | undefined {
    const operation = this.operations.get(operationId);
    return operation === undefined ? undefined : snapshotOperation(operation);
  }

  async start(request: SafeTunnelStartRequest): Promise<SafeTunnelStartResponse> {
    if (this.operationStartInFlight || this.activeOperation?.status === "running") {
      throw new SafeTunnelBridgeError("A Safe Tunnel operation is already running.", 409);
    }

    this.operationStartInFlight = true;
    try {
      const currentStatus = await this.status();

      if (currentStatus.runtime.state === "running") {
        throw new SafeTunnelBridgeError("The PI WEB Safe Tunnel connector is already running.", 409);
      }

      if (currentStatus.config.state !== "registered") {
        throw new SafeTunnelBridgeError("Register or log in to PI WEB Safe Tunnels before starting the connector.", 409);
      }

      if (request.frpcPath === undefined && currentStatus.config.frpcPathConfigured !== true) {
        throw new SafeTunnelBridgeError("Configure an frpc executable path before starting the connector.", 400);
      }

      const command = await this.connectorManager.ensureCommand();
      const configDirectory = discoverConnectorConfigDirectory(this.dependencies);
      const invocation: SafeTunnelCommandInvocation = {
        command,
        args: startArgs(request),
      };
      const logHeader = createConnectorStartLogHeader(this.dependencies.now(), invocation);
      const logPath = currentStatus.runtime.logPath ?? pathApiForPlatform(this.dependencies.platform).join(configDirectory, connectorLogFileName);
      const operation = this.createStartOperation(logPath, logHeader);

      const completion = this.dependencies.commandRunner.run(invocation, {
        detached: true,
        logHeader,
        logPath,
        maxOutputCharacters: maxCapturedOutputCharacters,
        timeoutMs: startCommandTimeoutMs,
        onProcessId: (processId) => {
          operation.connectorProcessId = processId;
        },
        onStdout: (chunk) => {
          appendOperationStdout(operation, chunk);
          appendOperationLogTail(operation, chunk);
        },
        onStderr: (chunk) => {
          appendOperationStderr(operation, chunk);
          appendOperationLogTail(operation, chunk);
        },
      }).then(
        (result) => {
          this.finishOperation(operation, result);
        },
        (error: unknown) => {
          this.failOperation(operation, error);
        },
      );
      void completion;

      return {
        accepted: true,
        operation: snapshotOperation(operation),
        ...(operation.connectorProcessId === undefined ? {} : { connectorProcessId: operation.connectorProcessId }),
        status: await this.status(),
      };
    } finally {
      this.operationStartInFlight = false;
    }
  }

  async stop(): Promise<SafeTunnelStopResponse> {
    const command = await this.connectorManager.ensureCommand();
    const result = await this.dependencies.commandRunner.run({ command, args: ["stop"] }, {
      maxOutputCharacters: maxCapturedOutputCharacters,
      timeoutMs: stopCommandTimeoutMs,
    });

    return {
      command: commandOutput(result),
      status: await this.status(),
    };
  }

  private createLoginOperation(): SafeTunnelOperationState {
    return this.createOperation("login");
  }

  private createStartOperation(logPath: string, logHeader: string): SafeTunnelOperationState {
    return this.createOperation("start", {
      logPath,
      logTail: tailText(sanitizeConnectorLog(logHeader), maxConnectorLogTailCharacters),
      logTailMaxCharacters: maxConnectorLogTailCharacters,
    });
  }

  private createOperation(kind: SafeTunnelOperationState["kind"], initial: Partial<SafeTunnelOperationState> = {}): SafeTunnelOperationState {
    const operation: SafeTunnelOperationState = {
      id: randomUUID(),
      kind,
      startedAt: this.dependencies.now().toISOString(),
      status: "running",
      stdout: "",
      stderr: "",
      ...initial,
    };
    this.activeOperation = operation;
    this.operations.set(operation.id, operation);
    return operation;
  }

  private finishOperation(operation: SafeTunnelOperationState, result: SafeTunnelCommandRunResult): void {
    operation.stdout = result.stdout;
    operation.stderr = result.stderr;
    operation.exitCode = result.exitCode;
    operation.finishedAt = this.dependencies.now().toISOString();
    if (result.signal !== undefined) operation.signal = result.signal;
    updateOperationDerivedFields(operation);

    if (result.exitCode === 0 && !result.timedOut) {
      operation.status = "succeeded";
    } else {
      const label = operationErrorLabel(operation.kind);
      operation.status = "failed";
      operation.error = result.timedOut
        ? `${label} timed out.`
        : `${label} exited with code ${formatExitCode(result.exitCode)}.`;
    }

    if (this.activeOperation?.id === operation.id) {
      this.activeOperation = undefined;
    }
  }

  private failOperation(operation: SafeTunnelOperationState, error: unknown): void {
    operation.status = "failed";
    operation.error = errorMessage(error);
    operation.finishedAt = this.dependencies.now().toISOString();
    if (this.activeOperation?.id === operation.id) {
      this.activeOperation = undefined;
    }
  }
}

export function createDefaultSafeTunnelBridgeService(): SafeTunnelBridgeService {
  return new DefaultSafeTunnelBridgeService({
    commandRunner: createNodeSafeTunnelCommandRunner(),
    cwd: process.cwd(),
    env: process.env,
    fileExists: existsSync,
    homeDirectory: homedir(),
    now: () => new Date(),
    platform: process.platform,
  });
}

export function createNodeSafeTunnelCommandRunner(): SafeTunnelCommandRunner {
  return {
    run(invocation, options) {
      return runNodeCommand(invocation, options);
    },
  };
}

function runNodeCommand(
  invocation: SafeTunnelCommandInvocation,
  options: SafeTunnelCommandRunOptions,
): Promise<SafeTunnelCommandRunResult> {
  return new Promise((resolve, reject) => {
    let logFileDescriptor: number | undefined;

    try {
      logFileDescriptor = openConnectorLogFile(options);
      const child = spawn(invocation.command, [...invocation.args], {
        detached: options.detached === true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const timeout = options.timeoutMs > 0
        ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs)
        : undefined;

      if (child.pid !== undefined) options.onProcessId?.(child.pid);

      const closeLog = (): void => {
        closeFileDescriptor(logFileDescriptor);
        logFileDescriptor = undefined;
      };

      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        closeLog();
        finish();
      };

      const writeLogChunk = (chunk: string): void => {
        if (logFileDescriptor === undefined) return;
        try {
          writeSync(logFileDescriptor, chunk);
        } catch {
          closeLog();
        }
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = appendCapped(stdout, chunk, options.maxOutputCharacters);
        writeLogChunk(chunk);
        options.onStdout?.(chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = appendCapped(stderr, chunk, options.maxOutputCharacters);
        writeLogChunk(chunk);
        options.onStderr?.(chunk);
      });
      child.once("error", (error) => {
        settle(() => {
          reject(error);
        });
      });
      child.once("close", (exitCode, signal) => {
        settle(() => {
          resolve({
            exitCode,
            stdout,
            stderr,
            timedOut,
            ...(signal === null ? {} : { signal }),
          });
        });
      });
    } catch (error) {
      closeFileDescriptor(logFileDescriptor);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function loginArgs(request: SafeTunnelLoginRequest): string[] {
  return [
    "login",
    "--control-api-url",
    request.controlApiUrl,
    "--machine-name",
    request.machineName,
    "--machine-slug",
    request.machineSlug,
    ...optionalFlag("--local-pi-web-url", request.localPiWebUrl),
    ...optionalFlag("--frpc-path", request.frpcPath),
  ];
}

function startArgs(request: SafeTunnelStartRequest): string[] {
  return ["start", ...optionalFlag("--frpc-path", request.frpcPath)];
}

function createConnectorStartLogHeader(now: Date, invocation: SafeTunnelCommandInvocation): string {
  return `\n=== ${now.toISOString()} ${invocation.command} ${invocation.args.join(" ")} ===\n`;
}

function openConnectorLogFile(options: Pick<SafeTunnelCommandRunOptions, "logHeader" | "logPath">): number | undefined {
  if (options.logPath === undefined) return undefined;

  mkdirSync(dirname(options.logPath), { mode: connectorLogDirectoryMode, recursive: true });
  if (process.platform !== "win32") chmodSync(dirname(options.logPath), connectorLogDirectoryMode);

  // Start logs are per connector launch. Truncating here avoids an
  // append-only connector.log growing forever across normal UI start/stop
  // cycles while preserving current connector/frpc output for status tails.
  const fileDescriptor = openSync(options.logPath, "w", connectorLogFileMode);
  if (process.platform !== "win32") chmodSync(options.logPath, connectorLogFileMode);

  if (options.logHeader !== undefined) {
    writeSync(fileDescriptor, options.logHeader);
  }

  return fileDescriptor;
}

function closeFileDescriptor(fileDescriptor: number | undefined): void {
  if (fileDescriptor === undefined) return;
  closeSync(fileDescriptor);
}

function optionalFlag(flag: string, value: string | undefined): string[] {
  return value === undefined ? [] : [flag, value];
}

function discoverConnectorConfigDirectory(dependencies: Pick<SafeTunnelBridgeDependencies, "env" | "homeDirectory" | "platform">): string {
  const homeDirectory = requireHomeDirectory(dependencies.homeDirectory);
  const pathApi = pathApiForPlatform(dependencies.platform);

  if (dependencies.platform === "win32") {
    const configRoot = nonEmptyString(dependencies.env["APPDATA"]) ?? pathApi.join(homeDirectory, "AppData", "Roaming");
    return pathApi.join(configRoot, connectorConfigDirectoryName);
  }

  const configRoot = nonEmptyString(dependencies.env["XDG_CONFIG_HOME"]) ?? pathApi.join(homeDirectory, ".config");
  return pathApi.join(configRoot, connectorConfigDirectoryName);
}

interface ConnectorStatusData {
  readonly config: SafeTunnelConfigStatus;
  readonly runtime: SafeTunnelRuntimeStatus;
}

interface ConnectorStatusPaths {
  readonly configPath: string;
  readonly logPath: string;
  readonly pidFilePath: string;
}

interface ConnectorStructuredStatus {
  readonly statusVersion: 1;
  readonly config: ConnectorStructuredConfigStatus;
  readonly runtime: ConnectorStructuredRuntimeStatus;
  readonly log: ConnectorStructuredLogStatus;
}

interface ConnectorStructuredConfigStatus {
  readonly path: string;
  readonly exists: boolean;
  readonly state: SafeTunnelConfigStatus["state"];
  readonly localPiWebUrl?: string;
  readonly frpcPathConfigured?: boolean;
  readonly machine?: ConnectorStructuredMachineStatus;
  readonly error?: string;
}

interface ConnectorStructuredMachineStatus {
  readonly controlApiBaseUrl: string;
  readonly machineId: string;
  readonly machineSlug?: string;
  readonly publicUrl?: string;
}

interface ConnectorStructuredRuntimeStatus {
  readonly pidFilePath: string;
  readonly frpcConfigPath: string;
  readonly frpcConfigExists: boolean;
  readonly state: SafeTunnelRuntimeStatus["state"];
  readonly pid?: number;
  readonly error?: string;
}

interface ConnectorStructuredLogStatus {
  readonly path: string;
  readonly exists: boolean;
  readonly tailMaxCharacters: number;
  readonly tail?: string;
  readonly error?: string;
}

function parseConnectorStatusData(statusJson: string, dependencies: Pick<SafeTunnelBridgeDependencies, "env" | "fileExists" | "homeDirectory" | "platform">): ConnectorStatusData {
  try {
    return connectorStatusDataFromStructuredStatus(parseConnectorStructuredStatus(statusJson));
  } catch (error) {
    return fallbackConnectorStatusData(`Unable to parse pi-web-tunnel status --json: ${errorMessage(error)}`, dependencies, { forceError: true });
  }
}

function connectorStatusDataFromStructuredStatus(status: ConnectorStructuredStatus): ConnectorStatusData {
  return {
    config: safeTunnelConfigStatusFromConnectorStatus(status.config),
    runtime: safeTunnelRuntimeStatusFromConnectorStatus(status.runtime, status.log),
  };
}

function safeTunnelConfigStatusFromConnectorStatus(status: ConnectorStructuredConfigStatus): SafeTunnelConfigStatus {
  return {
    path: status.path,
    exists: status.exists,
    state: status.state,
    ...(status.localPiWebUrl === undefined ? {} : { localPiWebUrl: status.localPiWebUrl }),
    ...(status.frpcPathConfigured === undefined ? {} : { frpcPathConfigured: status.frpcPathConfigured }),
    ...(status.machine === undefined ? {} : { machine: safeTunnelMachineStatusFromConnectorStatus(status.machine) }),
    ...(status.error === undefined ? {} : { error: status.error }),
  };
}

function safeTunnelMachineStatusFromConnectorStatus(status: ConnectorStructuredMachineStatus): NonNullable<SafeTunnelConfigStatus["machine"]> {
  const publicHostname = status.publicUrl === undefined ? undefined : publicHostnameFromPublicUrl(status.publicUrl);

  return {
    controlApiBaseUrl: status.controlApiBaseUrl,
    machineId: status.machineId,
    ...(status.machineSlug === undefined ? {} : { machineSlug: status.machineSlug }),
    ...(publicHostname === undefined ? {} : { publicHostname }),
    ...(status.publicUrl === undefined ? {} : { publicUrl: status.publicUrl }),
  };
}

function publicHostnameFromPublicUrl(publicUrl: string): string | undefined {
  try {
    const parsed = new URL(publicUrl);
    return parsed.hostname.length === 0 ? undefined : parsed.hostname;
  } catch {
    return undefined;
  }
}

function safeTunnelRuntimeStatusFromConnectorStatus(
  runtime: ConnectorStructuredRuntimeStatus,
  log: ConnectorStructuredLogStatus,
): SafeTunnelRuntimeStatus {
  const logTail = log.tail === undefined
    ? undefined
    : tailText(sanitizeConnectorLog(log.tail), maxConnectorLogTailCharacters);

  return {
    pidFilePath: runtime.pidFilePath,
    frpcConfigPath: runtime.frpcConfigPath,
    frpcConfigExists: runtime.frpcConfigExists,
    state: runtime.state,
    ...(runtime.pid === undefined ? {} : { pid: runtime.pid }),
    ...(runtime.error === undefined ? {} : { error: runtime.error }),
    logPath: log.path,
    logExists: log.exists,
    logTailMaxCharacters: log.tailMaxCharacters,
    ...(log.error === undefined ? {} : { logError: log.error }),
    ...(logTail === undefined || logTail.length === 0 ? {} : { logTail }),
  };
}

function fallbackConnectorStatusData(
  reason: string,
  dependencies: Pick<SafeTunnelBridgeDependencies, "env" | "fileExists" | "homeDirectory" | "platform">,
  options: { readonly forceError?: boolean } = {},
): ConnectorStatusData {
  const paths = connectorStatusPaths(dependencies);
  const configExists = dependencies.fileExists(paths.configPath);
  const pidFileExists = dependencies.fileExists(paths.pidFilePath);
  const forceError = options.forceError === true;

  return {
    config: configExists || forceError
      ? { exists: configExists, path: paths.configPath, state: "invalid", error: reason }
      : { exists: false, path: paths.configPath, state: "missing" },
    runtime: {
      pidFilePath: paths.pidFilePath,
      state: pidFileExists || forceError ? "unknown" : "stopped",
      ...(pidFileExists || forceError ? { error: reason } : {}),
      logPath: paths.logPath,
    },
  };
}

function connectorStatusPaths(dependencies: Pick<SafeTunnelBridgeDependencies, "env" | "homeDirectory" | "platform">): ConnectorStatusPaths {
  const configDirectory = discoverConnectorConfigDirectory(dependencies);
  const pathApi = pathApiForPlatform(dependencies.platform);

  return {
    configPath: pathApi.join(configDirectory, connectorConfigFileName),
    logPath: pathApi.join(configDirectory, connectorLogFileName),
    pidFilePath: pathApi.join(configDirectory, connectorPidFileName),
  };
}

function parseConnectorStructuredStatus(contents: string): ConnectorStructuredStatus {
  const parsed: unknown = JSON.parse(contents);
  const record = requireRecord(parsed, "Connector status");
  const statusVersion = requireNumber(record, "statusVersion");

  if (statusVersion !== 1) {
    throw new Error(`Unsupported connector status version: ${statusVersion.toString()}.`);
  }

  return {
    statusVersion: 1,
    config: parseConnectorStructuredConfigStatus(record["config"]),
    runtime: parseConnectorStructuredRuntimeStatus(record["runtime"]),
    log: parseConnectorStructuredLogStatus(record["log"]),
  };
}

function parseConnectorStructuredConfigStatus(value: unknown): ConnectorStructuredConfigStatus {
  const record = requireRecord(value, "Connector status config");
  const localPiWebUrl = optionalNonEmptyString(record["localPiWebUrl"], "Connector status config.localPiWebUrl");
  const frpcPathConfigured = optionalBoolean(record["frpcPathConfigured"], "Connector status config.frpcPathConfigured");
  const machine = record["machine"] === undefined ? undefined : parseConnectorStructuredMachineStatus(record["machine"]);
  const error = optionalNonEmptyString(record["error"], "Connector status config.error");

  return {
    path: requireNonEmptyString(record["path"], "Connector status config.path"),
    exists: requireBoolean(record, "exists"),
    state: requireConnectorConfigState(record, "state"),
    ...(localPiWebUrl === undefined ? {} : { localPiWebUrl }),
    ...(frpcPathConfigured === undefined ? {} : { frpcPathConfigured }),
    ...(machine === undefined ? {} : { machine }),
    ...(error === undefined ? {} : { error }),
  };
}

function parseConnectorStructuredMachineStatus(value: unknown): ConnectorStructuredMachineStatus {
  const record = requireRecord(value, "Connector status machine");
  const machineSlug = optionalNonEmptyString(record["machineSlug"], "Connector status machine.machineSlug");
  const publicUrl = optionalNonEmptyString(record["publicUrl"], "Connector status machine.publicUrl");

  return {
    controlApiBaseUrl: requireNonEmptyString(record["controlApiBaseUrl"], "Connector status machine.controlApiBaseUrl"),
    machineId: requireNonEmptyString(record["machineId"], "Connector status machine.machineId"),
    ...(machineSlug === undefined ? {} : { machineSlug }),
    ...(publicUrl === undefined ? {} : { publicUrl }),
  };
}

function parseConnectorStructuredRuntimeStatus(value: unknown): ConnectorStructuredRuntimeStatus {
  const record = requireRecord(value, "Connector status runtime");
  const pid = optionalNumber(record["pid"], "Connector status runtime.pid");
  const error = optionalNonEmptyString(record["error"], "Connector status runtime.error");

  return {
    pidFilePath: requireNonEmptyString(record["pidFilePath"], "Connector status runtime.pidFilePath"),
    frpcConfigPath: requireNonEmptyString(record["frpcConfigPath"], "Connector status runtime.frpcConfigPath"),
    frpcConfigExists: requireBoolean(record, "frpcConfigExists"),
    state: requireConnectorRuntimeState(record, "state"),
    ...(pid === undefined ? {} : { pid }),
    ...(error === undefined ? {} : { error }),
  };
}

function parseConnectorStructuredLogStatus(value: unknown): ConnectorStructuredLogStatus {
  const record = requireRecord(value, "Connector status log");
  const tail = optionalString(record["tail"], "Connector status log.tail");
  const error = optionalNonEmptyString(record["error"], "Connector status log.error");

  return {
    path: requireNonEmptyString(record["path"], "Connector status log.path"),
    exists: requireBoolean(record, "exists"),
    tailMaxCharacters: requireNumber(record, "tailMaxCharacters"),
    ...(tail === undefined ? {} : { tail }),
    ...(error === undefined ? {} : { error }),
  };
}

function sanitizeConnectorLog(contents: string): string {
  return contents.replace(ansiEscapePattern, "");
}

function tailText(contents: string, maxCharacters: number): string {
  if (contents.length <= maxCharacters) return contents;
  return contents.slice(contents.length - maxCharacters);
}

function snapshotOperation(operation: SafeTunnelOperationState): SafeTunnelOperationResponse {
  return {
    id: operation.id,
    kind: operation.kind,
    startedAt: operation.startedAt,
    status: operation.status,
    stdout: operation.stdout,
    stderr: operation.stderr,
    ...(operation.connectorProcessId === undefined ? {} : { connectorProcessId: operation.connectorProcessId }),
    ...(operation.error === undefined ? {} : { error: operation.error }),
    ...(operation.exitCode === undefined ? {} : { exitCode: operation.exitCode }),
    ...(operation.finishedAt === undefined ? {} : { finishedAt: operation.finishedAt }),
    ...(operation.logPath === undefined ? {} : { logPath: operation.logPath }),
    ...(operation.logTail === undefined || operation.logTail.length === 0 ? {} : { logTail: operation.logTail }),
    ...(operation.logTailMaxCharacters === undefined ? {} : { logTailMaxCharacters: operation.logTailMaxCharacters }),
    ...(operation.publicUrl === undefined ? {} : { publicUrl: operation.publicUrl }),
    ...(operation.signal === undefined ? {} : { signal: operation.signal }),
    ...(operation.userCode === undefined ? {} : { userCode: operation.userCode }),
    ...(operation.verificationUriComplete === undefined ? {} : { verificationUriComplete: operation.verificationUriComplete }),
  };
}

function appendOperationStdout(operation: SafeTunnelOperationState, chunk: string): void {
  operation.stdout = appendCapped(operation.stdout, chunk, maxCapturedOutputCharacters);
  updateOperationDerivedFields(operation);
}

function appendOperationStderr(operation: SafeTunnelOperationState, chunk: string): void {
  operation.stderr = appendCapped(operation.stderr, chunk, maxCapturedOutputCharacters);
}

function appendOperationLogTail(operation: SafeTunnelOperationState, chunk: string): void {
  operation.logTail = tailText(sanitizeConnectorLog(`${operation.logTail ?? ""}${chunk}`), maxConnectorLogTailCharacters);
  operation.logTailMaxCharacters = maxConnectorLogTailCharacters;
}

function updateOperationDerivedFields(operation: SafeTunnelOperationState): void {
  const lines = operation.stdout.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    const previousLine = index === 0 ? "" : (lines[index - 1]?.trim() ?? "");

    if (previousLine === "Open this URL to authorize the connector:" && line.length > 0) {
      operation.verificationUriComplete = line;
      continue;
    }

    if (line.startsWith("User code:")) {
      operation.userCode = line.slice("User code:".length).trim();
      continue;
    }

    if (line.startsWith("Public URL:")) {
      operation.publicUrl = line.slice("Public URL:".length).trim();
    }
  }
}

function commandOutput(result: SafeTunnelCommandRunResult): SafeTunnelCommandOutput {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.signal === undefined ? {} : { signal: result.signal }),
  };
}

function appendCapped(existing: string, chunk: string, maxCharacters: number): string {
  const next = `${existing}${chunk}`;
  if (next.length <= maxCharacters) return next;
  return next.slice(next.length - maxCharacters);
}

function pathApiForPlatform(platform: NodeJS.Platform): PathApi {
  return platform === "win32" ? win32 : posix;
}

function requireRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be a JSON object.`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean.`);
  }
  return value;
}

function optionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean.`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number.`);
  }
  return value;
}

function optionalNumber(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number.`);
  }
  return value;
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string.`);
  }
  return value;
}

function requireConnectorConfigState(record: Record<string, unknown>, key: string): SafeTunnelConfigStatus["state"] {
  const value = requireNonEmptyString(record[key], `Connector status config.${key}`);
  if (value !== "missing" && value !== "unregistered" && value !== "registered" && value !== "invalid") {
    throw new Error(`Connector status config.${key} is invalid.`);
  }
  return value;
}

function requireConnectorRuntimeState(record: Record<string, unknown>, key: string): SafeTunnelRuntimeStatus["state"] {
  const value = requireNonEmptyString(record[key], `Connector status runtime.${key}`);
  if (value !== "stopped" && value !== "running" && value !== "stale" && value !== "unknown") {
    throw new Error(`Connector status runtime.${key} is invalid.`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, fieldName);
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function requireHomeDirectory(homeDirectory: string): string {
  const normalized = nonEmptyString(homeDirectory);
  if (normalized === undefined) {
    throw new Error("Unable to discover a home directory for the PI WEB Safe Tunnel connector config.");
  }
  return normalized;
}

function nonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function formatExitCode(exitCode: number | null): string {
  return exitCode === null ? "unknown" : exitCode.toString();
}

function operationErrorLabel(kind: SafeTunnelOperationState["kind"]): string {
  return kind === "login" ? "Safe Tunnel login" : "Safe Tunnel start";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
