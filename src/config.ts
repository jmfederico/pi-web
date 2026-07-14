import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { PiWebAgentDirEnvSource, PiWebConfigValues } from "./shared/apiTypes.js";
import { isPiCompanionCommand, usesPiCodingAgentStateCompatibility } from "./shared/activeAgentProfile.js";
import { isPiWebPluginId, piWebPluginIdPattern } from "./shared/pluginIds.js";

export { isPiCompanionCommand };

export type PiWebConfig = PiWebConfigValues;

export interface LoadedPiWebConfig {
  path: string;
  exists: boolean;
  config: PiWebConfig;
}

export interface EffectivePiWebConfig extends Omit<PiWebConfig, "uploads" | "spawnSessions" | "subsessions" | "agent"> {
  uploads: NonNullable<PiWebConfig["uploads"]>;
  spawnSessions: boolean;
  subsessions: boolean;
  agent: Required<NonNullable<PiWebConfig["agent"]>>;
}

export interface LoadedEffectivePiWebConfig extends Omit<LoadedPiWebConfig, "config"> {
  config: EffectivePiWebConfig;
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function defaultPiWebConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdgConfigHome = env["XDG_CONFIG_HOME"];
  return join(xdgConfigHome !== undefined && xdgConfigHome !== "" ? xdgConfigHome : join(homedir(), ".config"), "pi-web", "config.json");
}

export function defaultPiWebDataDir(): string {
  return join(homedir(), ".pi-web");
}

/**
 * Default maximum HTTP body size (bytes) for the web/API and session daemon.
 * Generous headroom for base64 image attachments (well above pi's 4.5MB
 * per-image inline limit so several images fit in one request).
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export const DEFAULT_UPLOADS_FOLDER = ".pi-web/uploads";

export const DEFAULT_AGENT_COMMAND = "pi";
export const PI_WEB_AGENT_COMMAND_ENV = "PI_WEB_AGENT_COMMAND";
export const PI_WEB_AGENT_DIR_ENV = "PI_WEB_AGENT_DIR";
export const PI_WEB_AGENT_SESSION_DIR_ENV = "PI_WEB_AGENT_SESSION_DIR";
export const PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const PI_CODING_AGENT_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

export interface EffectivePiWebAgentConfig {
  command: string;
  dir: string;
  sessionDirEnvKeys: string[];
}

export function effectiveAgentConfig(env: NodeJS.ProcessEnv = process.env, config: Pick<PiWebConfig, "agent"> = {}): EffectivePiWebAgentConfig {
  const command = parseAgentCommand(envValue(env, PI_WEB_AGENT_COMMAND_ENV) ?? config.agent?.command ?? DEFAULT_AGENT_COMMAND, "agent.command", "environment", "current");
  const configuredDir = envValue(env, PI_WEB_AGENT_DIR_ENV) ?? (usesPiCodingAgentStateCompatibility(command) ? envValue(env, PI_CODING_AGENT_DIR_ENV) : undefined) ?? config.agent?.dir ?? defaultAgentDirForCommand(command, env);
  return {
    command,
    dir: resolveAgentDirPath(configuredDir, env, "agent.dir", "environment"),
    sessionDirEnvKeys: agentSessionDirEnvKeys(command),
  };
}

export function agentSessionDirEnvKeys(command = DEFAULT_AGENT_COMMAND): string[] {
  return uniqueStrings([
    PI_WEB_AGENT_SESSION_DIR_ENV,
    ...(usesPiCodingAgentStateCompatibility(command) ? [PI_CODING_AGENT_SESSION_DIR_ENV] : []),
  ]);
}

export function agentDirEnvSource(env: NodeJS.ProcessEnv): PiWebAgentDirEnvSource | undefined {
  if (isEnvSet(env[PI_WEB_AGENT_DIR_ENV])) return "pi-web";
  if (isEnvSet(env[PI_CODING_AGENT_DIR_ENV])) return "pi-compatibility";
  return undefined;
}

export function hasAgentDirEnvOverride(env: NodeJS.ProcessEnv, command = DEFAULT_AGENT_COMMAND): boolean {
  const source = agentDirEnvSource(env);
  return source === "pi-web" || (source === "pi-compatibility" && usesPiCodingAgentStateCompatibility(command));
}

export function hasAgentSessionDirEnvOverride(env: NodeJS.ProcessEnv, command = DEFAULT_AGENT_COMMAND): boolean {
  return agentSessionDirEnvKeys(command).some((key) => isEnvSet(env[key]));
}

export function effectiveUploadsConfig(config: Pick<PiWebConfig, "uploads"> = {}): NonNullable<PiWebConfig["uploads"]> {
  return { defaultFolder: config.uploads?.defaultFolder ?? DEFAULT_UPLOADS_FOLDER };
}

export function maxUploadBytes(env: NodeJS.ProcessEnv = process.env, config: PiWebConfig = {}): number {
  const fromEnv = env["PI_WEB_MAX_UPLOAD_BYTES"];
  if (fromEnv !== undefined && fromEnv !== "") {
    const parsed = Number(fromEnv);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  if (config.maxUploadBytes !== undefined) return config.maxUploadBytes;
  return DEFAULT_MAX_UPLOAD_BYTES;
}

export function piWebDataDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const configured = env["PI_WEB_DATA_DIR"];
  if (configured === undefined || configured === "") return defaultPiWebDataDir();
  return resolve(cwd, configured);
}

export function piWebConfigPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const configured = env["PI_WEB_CONFIG"];
  if (configured === undefined || configured === "") return defaultPiWebConfigPath(env);
  return resolve(cwd, configured);
}

export function loadPiWebConfig(options: LoadOptions = {}): LoadedPiWebConfig {
  const env = options.env ?? process.env;
  const path = piWebConfigPath(env, options.cwd ?? process.cwd());
  if (!existsSync(path)) return { path, exists: false, config: {} };

  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`PI WEB config must be a JSON object: ${path}`);

  return { path, exists: true, config: parsePiWebConfig(parsed, path) };
}

export function effectivePiWebConfig(options: LoadOptions = {}): LoadedEffectivePiWebConfig {
  return resolveEffectivePiWebConfig(loadPiWebConfig(options), options);
}

export function resolveEffectivePiWebConfig(loaded: LoadedPiWebConfig, options: LoadOptions = {}): LoadedEffectivePiWebConfig {
  const env = options.env ?? process.env;
  const host = env["PI_WEB_HOST"];
  const port = env["PI_WEB_PORT"] ?? env["PORT"];
  const allowedHosts = env["PI_WEB_ALLOWED_HOSTS"];
  const maxUpload = env["PI_WEB_MAX_UPLOAD_BYTES"];
  const agent = effectiveAgentConfig(env, loaded.config);
  return {
    ...loaded,
    config: {
      ...loaded.config,
      ...(host !== undefined && host !== "" ? { host } : {}),
      ...(port !== undefined && port !== "" ? { port: parsePort(port, "PI_WEB_PORT") } : {}),
      ...(allowedHosts !== undefined && allowedHosts !== "" ? { allowedHosts: parseAllowedHostsEnv(allowedHosts) } : {}),
      ...(maxUpload !== undefined && maxUpload !== "" ? { maxUploadBytes: parseMaxUploadBytes(maxUpload, "PI_WEB_MAX_UPLOAD_BYTES") } : {}),
      uploads: effectiveUploadsConfig(loaded.config),
      // Always resolved (on by default) so the effective config is the single
      // source of truth for the runtime state and the settings UI toggle.
      spawnSessions: spawnSessionsEnabled(env, loaded.config),
      // Beta capability, resolved off by default.
      subsessions: subsessionsEnabled(env, loaded.config),
      agent: { command: agent.command, dir: agent.dir },
    },
  };
}

export function savePiWebConfig(config: PiWebConfig, options: LoadOptions = {}): LoadedPiWebConfig {
  const env = options.env ?? process.env;
  const path = piWebConfigPath(env, options.cwd ?? process.cwd());
  const normalized = parsePiWebConfig(piWebConfigRecord(config), path);
  effectiveAgentConfig(env, normalized);
  const existing = readExistingConfigObject(path);
  if (existing["agent"] !== undefined) parseAgentConfig(existing["agent"], path);
  delete existing["host"];
  delete existing["port"];
  delete existing["allowedHosts"];
  delete existing["shortcuts"];
  delete existing["plugins"];
  delete existing["pathAccess"];
  delete existing["uploads"];
  delete existing["maxUploadBytes"];
  delete existing["spawnSessions"];
  delete existing["subsessions"];
  delete existing["agent"];
  const merged = { ...existing, ...piWebConfigRecord(normalized) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return { path, exists: true, config: normalized };
}

function readExistingConfigObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`PI WEB config must be a JSON object: ${path}`);
  return parsed;
}

function piWebConfigRecord(config: PiWebConfig): Record<string, unknown> {
  return {
    ...(config.host !== undefined ? { host: config.host } : {}),
    ...(config.port !== undefined ? { port: config.port } : {}),
    ...(config.allowedHosts !== undefined ? { allowedHosts: config.allowedHosts } : {}),
    ...(config.shortcuts !== undefined ? { shortcuts: config.shortcuts } : {}),
    ...(config.plugins !== undefined ? { plugins: config.plugins } : {}),
    ...(config.pathAccess !== undefined ? { pathAccess: config.pathAccess } : {}),
    ...(config.uploads !== undefined ? { uploads: config.uploads } : {}),
    ...(config.maxUploadBytes !== undefined ? { maxUploadBytes: config.maxUploadBytes } : {}),
    ...(config.spawnSessions !== undefined ? { spawnSessions: config.spawnSessions } : {}),
    ...(config.subsessions !== undefined ? { subsessions: config.subsessions } : {}),
    ...(config.agent !== undefined ? { agent: config.agent } : {}),
  };
}

function parsePiWebConfig(value: Record<string, unknown>, path: string): PiWebConfig {
  return {
    ...(value["host"] !== undefined ? { host: parseString(value["host"], "host", path) } : {}),
    ...(value["port"] !== undefined ? { port: parsePort(value["port"], "port", path) } : {}),
    ...(value["allowedHosts"] !== undefined ? { allowedHosts: parseAllowedHosts(value["allowedHosts"], path) } : {}),
    ...(value["shortcuts"] !== undefined ? { shortcuts: parseShortcuts(value["shortcuts"], path) } : {}),
    ...(value["plugins"] !== undefined ? { plugins: parsePlugins(value["plugins"], path) } : {}),
    ...(value["pathAccess"] !== undefined ? { pathAccess: parsePathAccessConfig(value["pathAccess"], path) } : {}),
    ...(value["uploads"] !== undefined ? { uploads: parseUploadsConfig(value["uploads"], path) } : {}),
    ...(value["maxUploadBytes"] !== undefined ? { maxUploadBytes: parseMaxUploadBytes(value["maxUploadBytes"], "maxUploadBytes", path) } : {}),
    ...(value["spawnSessions"] !== undefined ? { spawnSessions: parseSpawnSessions(value["spawnSessions"], path) } : {}),
    ...(value["subsessions"] !== undefined ? { subsessions: parseSubsessions(value["subsessions"], path) } : {}),
    ...(value["agent"] !== undefined ? { agent: parseAgentConfig(value["agent"], path) } : {}),
  };
}

function parseMaxUploadBytes(value: unknown, key: string, path = "environment"): number {
  const bytes = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN;
  if (!Number.isInteger(bytes) || bytes < 1) throw new Error(`PI WEB config ${key} must be a positive integer: ${path}`);
  return bytes;
}

function parseSpawnSessions(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`PI WEB config spawnSessions must be a boolean: ${path}`);
  return value;
}

/**
 * Whether LLMs may start new sessions via the spawn_session tool. On by default
 * (spawned sessions appear in the session list, so humans notice them); set the
 * env var `PI_WEB_SPAWN_SESSIONS` or the `spawnSessions` config key to `false`
 * to disable. The env var takes precedence over the config file.
 */
export function spawnSessionsEnabled(env: NodeJS.ProcessEnv = process.env, config: PiWebConfig = {}): boolean {
  const fromEnv = env["PI_WEB_SPAWN_SESSIONS"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv === "1" || fromEnv.toLowerCase() === "true";
  return config.spawnSessions ?? true;
}

function parseSubsessions(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`PI WEB config subsessions must be a boolean: ${path}`);
  return value;
}

/**
 * Beta: whether LLMs may start tracked child sessions via the spawn_subsession
 * family of tools. Off by default while the capability stabilizes, so it can
 * ship in main without affecting releases; enable with the env var
 * `PI_WEB_SUBSESSIONS` or the `subsessions` config key. The env var takes
 * precedence over the config file. Subsessions also require spawnSessions to be
 * enabled (they share the same project-scope resolver).
 */
export function subsessionsEnabled(env: NodeJS.ProcessEnv = process.env, config: PiWebConfig = {}): boolean {
  const fromEnv = env["PI_WEB_SUBSESSIONS"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv === "1" || fromEnv.toLowerCase() === "true";
  return config.subsessions ?? false;
}

function parseString(value: unknown, key: string, path: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`PI WEB config ${key} must be a non-empty string: ${path}`);
  return value;
}

const AGENT_CONFIG_KEYS = new Set(["command", "dir"]);
const SAFE_BARE_AGENT_COMMAND_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/u;

export type AgentPathHost = "current" | "portable";

export function parseAgentConfig(value: unknown, path: string, pathHost: AgentPathHost = "current"): NonNullable<PiWebConfig["agent"]> {
  if (!isRecord(value)) throw new Error(`PI WEB config agent must be an object: ${path}`);
  const unknownKey = Object.keys(value).find((key) => !AGENT_CONFIG_KEYS.has(key));
  if (unknownKey !== undefined) throw new Error(`PI WEB config agent contains unknown key ${JSON.stringify(unknownKey)}: ${path}`);
  const command = value["command"];
  const dir = value["dir"];
  return {
    ...(command !== undefined ? { command: parseAgentCommand(command, "agent.command", path, pathHost) } : {}),
    ...(dir !== undefined ? { dir: parseAgentDir(dir, "agent.dir", path, pathHost) } : {}),
  };
}

function parseAgentCommand(value: unknown, key: string, path: string, pathHost: AgentPathHost): string {
  const command = parseString(value, key, path).trim();
  if (!isSafeAgentCommand(command, pathHost)) {
    const absoluteLabel = pathHost === "current" ? "host-absolute" : "absolute";
    throw new Error(`PI WEB config ${key} must be a safe bare executable name or ${absoluteLabel} executable path: ${path}`);
  }
  return command;
}

function parseAgentDir(value: unknown, key: string, path: string, pathHost: AgentPathHost): string {
  const dir = parseString(value, key, path).trim();
  const isAbsoluteDir = pathHost === "current" ? isHostAbsoluteAgentDir(dir) : isPortableAbsoluteAgentPath(dir);
  if (!isAbsoluteDir && !isHomePath(dir, pathHost)) {
    const absoluteLabel = pathHost === "current" ? "a host-absolute" : "an absolute";
    throw new Error(`PI WEB config ${key} must be ${absoluteLabel} path or start with ~: ${path}`);
  }
  return dir;
}

function resolveAgentDirPath(value: string, env: NodeJS.ProcessEnv, key: string, path: string): string {
  const parsed = parseAgentDir(value, key, path, "current");
  const expanded = expandHomePath(parsed, env);
  if (!isHostAbsoluteAgentDir(expanded)) {
    throw new Error(`PI WEB config ${key} must resolve to a host-absolute path: ${path}`);
  }
  return normalize(expanded);
}

export function isSafeAgentCommandForHost(value: string): boolean {
  return isSafeAgentCommand(value, "current");
}

function isSafeAgentCommand(value: string, pathHost: AgentPathHost): boolean {
  if (value === "" || value !== value.trim() || value.includes("\0") || /[\s;&|`$<>]/u.test(value)) return false;
  if (SAFE_BARE_AGENT_COMMAND_PATTERN.test(value)) return true;
  if (pathHost === "current") return isAbsolute(value) && basename(value) !== "";
  return isAbsoluteLike(value) && value.split(/[\\/]/u).at(-1) !== "";
}

export function isHostAbsoluteAgentDir(value: string): boolean {
  return isSafeAgentDirPath(value) && isAbsolute(value);
}

function isPortableAbsoluteAgentPath(value: string): boolean {
  return isSafeAgentDirPath(value) && isAbsoluteLike(value);
}

function isSafeAgentDirPath(value: string): boolean {
  return value !== "" && value === value.trim() && !hasControlCharacter(value);
}

function parsePort(value: unknown, key: string, path = "environment"): number {
  const port = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PI WEB config ${key} must be an integer from 1 to 65535: ${path}`);
  return port;
}

function parseAllowedHosts(value: unknown, path: string): string[] | true {
  if (value === true) return true;
  if (!isNonEmptyStringArray(value)) {
    throw new Error(`PI WEB config allowedHosts must be true or an array of non-empty strings: ${path}`);
  }
  return value;
}

function parseAllowedHostsEnv(value: string): string[] | true {
  if (value === "true") return true;
  return value.split(",").map((host) => host.trim()).filter((host) => host !== "");
}

export function parsePathAccessConfig(value: unknown, path: string): NonNullable<PiWebConfigValues["pathAccess"]> {
  if (!isRecord(value)) throw new Error(`PI WEB config pathAccess must be an object: ${path}`);
  const allowedPaths = value["allowedPaths"];
  return {
    ...(allowedPaths !== undefined ? { allowedPaths: parseAllowedPaths(allowedPaths, path) } : {}),
  };
}

function parseAllowedPaths(value: unknown, path: string): string[] {
  if (!isNonEmptyStringArray(value)) throw new Error(`PI WEB config pathAccess.allowedPaths must be an array of non-empty strings: ${path}`);
  return value;
}

export function parseUploadsConfig(value: unknown, path: string): NonNullable<PiWebConfigValues["uploads"]> {
  if (!isRecord(value)) throw new Error(`PI WEB config uploads must be an object: ${path}`);
  const defaultFolder = value["defaultFolder"];
  return {
    ...(defaultFolder !== undefined ? { defaultFolder: parseWorkspaceRelativeFolder(defaultFolder, "uploads.defaultFolder", path) } : {}),
  };
}

function parseWorkspaceRelativeFolder(value: unknown, key: string, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`PI WEB config ${key} must be a non-empty workspace-relative path: ${path}`);
  if (isAbsoluteLike(value)) throw new Error(`PI WEB config ${key} must be workspace-relative: ${path}`);
  const parts = value.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) throw new Error(`PI WEB config ${key} must be a non-empty workspace-relative path: ${path}`);
  if (parts.some((part) => part === "..")) throw new Error(`PI WEB config ${key} must not contain path traversal: ${path}`);
  return parts.join("/");
}


function isHomePath(value: string, pathHost: AgentPathHost): boolean {
  return value === "~" || value.startsWith("~/") || ((pathHost === "portable" || process.platform === "win32") && value.startsWith("~\\"));
}

function expandHomePath(value: string, env: NodeJS.ProcessEnv): string {
  const home = env["HOME"] !== undefined && env["HOME"] !== "" ? env["HOME"] : homedir();
  if (value === "~") return home;
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) return join(home, value.slice(2));
  return value;
}

function defaultAgentDirForCommand(command: string, env: NodeJS.ProcessEnv): string {
  if (usesPiCodingAgentStateCompatibility(command)) return expandHomePath("~/.pi/agent", env);
  throw new Error(`PI WEB config agent.dir or ${PI_WEB_AGENT_DIR_ENV} is required when agent.command is ${JSON.stringify(command)}`);
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value !== undefined && value !== "" ? value : undefined;
}

function isEnvSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function isAbsoluteLike(value: string): boolean {
  const withForwardSlashes = value.replace(/\\/g, "/");
  return isAbsolute(value) || withForwardSlashes.startsWith("/") || /^[A-Za-z]:\//.test(withForwardSlashes);
}

function parseShortcuts(value: unknown, path: string): Record<string, string | null> {
  if (!isRecord(value)) throw new Error(`PI WEB config shortcuts must be an object: ${path}`);
  return Object.fromEntries(Object.entries(value).map(([actionId, shortcut]) => {
    if (shortcut !== null && (typeof shortcut !== "string" || shortcut === "")) {
      throw new Error(`PI WEB config shortcut values must be non-empty strings or null: ${path}`);
    }
    return [actionId, shortcut];
  }));
}

function parsePlugins(value: unknown, path: string): NonNullable<PiWebConfigValues["plugins"]> {
  if (!isRecord(value) || Array.isArray(value)) throw new Error(`PI WEB config plugins must be an object: ${path}`);
  return Object.fromEntries(Object.entries(value).map(([pluginId, config]) => {
    if (!isPiWebPluginId(pluginId)) throw new Error(`PI WEB config plugin ids must match ${piWebPluginIdPattern.source}: ${path}`);
    if (!isRecord(config) || Array.isArray(config)) throw new Error(`PI WEB config plugin entries must be objects: ${path}`);
    const enabled = config["enabled"];
    if (enabled !== undefined && typeof enabled !== "boolean") throw new Error(`PI WEB config plugin enabled values must be booleans: ${path}`);
    const settings = config["settings"];
    if (settings !== undefined && (!isRecord(settings) || Array.isArray(settings))) throw new Error(`PI WEB config plugin settings must be objects: ${path}`);
    return [pluginId, config];
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");
}

export function examplePiWebConfig(config: PiWebConfig = {}): string {
  return `${JSON.stringify({ host: config.host ?? "127.0.0.1", port: config.port ?? 8504, allowedHosts: config.allowedHosts ?? [] }, null, 2)}\n`;
}

