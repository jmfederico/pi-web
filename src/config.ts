import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { PiWebConfigValues, PiWebDeprecatedAgentInput } from "./shared/apiTypes.js";
import { isPiWebPluginId, piWebPluginIdPattern } from "./shared/pluginIds.js";
import { requireDefaultThemePreference } from "./shared/themePreference.js";
import { requireDefaultLocalization } from "./shared/defaultLocalization.js";
import { requireDefaultStreamingBehavior } from "./shared/streamingBehavior.js";
import { migrateSessionNamingConfig } from "./configSessionNamingMigration.js";
import { requireInstallationName } from "./shared/installationName.js";

import { PI_WEB_CONFIG_DEFINITIONS, overlayPiWebConfig, parsePiWebEnvBoolean, piWebConfigEnvName, piWebConfigNamespaceFields, piWebConfigSettingPointers } from "./shared/configResolution.js";
import { versionChecksDisabled } from "./shared/versionCheckPolicy.js";
export { overlayPiWebConfig } from "./shared/configResolution.js";

export type PiWebConfig = PiWebConfigValues;

export interface LoadedPiWebConfig {
  path: string;
  exists: boolean;
  config: PiWebConfig;
  /** Deployment-owned defaults, never included in writable config or saves. */
  defaultsConfig?: PiWebConfig;
  defaultsPath?: string;
  /** Deprecated agent-configuration inputs detected in `env` and the loaded file. */
  deprecatedAgentInputs: readonly DeprecatedAgentInput[];
}

export interface EffectivePiWebConfig extends Omit<PiWebConfig, "uploads" | "attachments" | "spawnSessions" | "sessionMessages" | "subsessions" | "askUser" | "dockerEnvironmentFacts" | "agent" | "extensionDialogsTimeoutMs"> {
  uploads: NonNullable<PiWebConfig["uploads"]>;
  attachments: NonNullable<PiWebConfig["attachments"]>;
  spawnSessions: boolean;
  sessionMessages: boolean;
  subsessions: boolean;
  askUser: boolean;
  environmentFacts: boolean;
  extensionDialogsTimeoutMs: number;
  agent: EffectivePiWebAgentConfig;
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

/**
 * Default workspace-relative folder used when saving pasted/dropped prompt
 * attachments for the agent to read with its own tools.
 */
export const DEFAULT_ATTACHMENT_FOLDER = ".pi-web/attachments";

/**
 * Default auto-cancel delay for extension dialogs whose extension set no
 * `timeout` of its own: five minutes. `extensionDialogsTimeoutMs: 0` waits
 * forever. Tunes the unattended-dialog safety valve only; dialogs are always
 * enabled.
 */
export const DEFAULT_EXTENSION_DIALOGS_TIMEOUT_MS = 300_000;
const MAX_TIMER_TIMEOUT_MS = 2_147_483_647;

export const PI_WEB_AGENT_COMMAND_ENV = "PI_WEB_AGENT_COMMAND";
export const PI_WEB_AGENT_DIR_ENV = "PI_WEB_AGENT_DIR";
export const PI_WEB_AGENT_SESSION_DIR_ENV = "PI_WEB_AGENT_SESSION_DIR";
export const PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const PI_CODING_AGENT_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

/**
 * Session storage override env keys in precedence order: the deprecated
 * `PI_WEB_` alias first so it keeps winning when both are set (today's
 * precedence, preserved for the deprecation window), then the canonical pi
 * SDK name.
 */
export const AGENT_SESSION_DIR_ENV_KEYS = [PI_WEB_AGENT_SESSION_DIR_ENV, PI_CODING_AGENT_SESSION_DIR_ENV] as const;

export interface EffectivePiWebAgentConfig {
  dir: string;
}

/**
 * Resolve the pi agent state directory. PI WEB runs sessions on the bundled pi
 * SDK only, so there is no command abstraction: the directory comes from the
 * deprecated `PI_WEB_AGENT_DIR` alias, then the canonical `PI_CODING_AGENT_DIR`,
 * then the deprecated `agent.dir` config alias, then the pi SDK default
 * (`~/.pi/agent`, mirrored from the SDK's `getAgentDir()`). The session daemon
 * exports the resolved value as `PI_CODING_AGENT_DIR` at startup, so the
 * embedded SDK's own `getAgentDir()` observes the same directory and pi-web
 * cannot drift from pi.
 */
export function effectiveAgentConfig(env: NodeJS.ProcessEnv = process.env, config: Pick<PiWebConfig, "agent"> = {}): EffectivePiWebAgentConfig {
  const sources: readonly (readonly [string, string | undefined])[] = [
    [PI_WEB_AGENT_DIR_ENV, envValue(env, PI_WEB_AGENT_DIR_ENV)],
    [PI_CODING_AGENT_DIR_ENV, envValue(env, PI_CODING_AGENT_DIR_ENV)],
    ["agent.dir", config.agent?.dir],
  ];
  const configured = sources.find((source): source is readonly [string, string] => source[1] !== undefined);
  const [sourceName, configuredDir] = configured ?? ["the agent directory default", defaultAgentDir(env)];
  return { dir: resolveAgentDirPath(configuredDir, env, sourceName, "environment") };
}

/** The session storage override from the environment, in `AGENT_SESSION_DIR_ENV_KEYS` precedence order. */
export function agentSessionDirEnvOverride(env: Readonly<NodeJS.ProcessEnv>): string | undefined {
  for (const key of AGENT_SESSION_DIR_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/**
 * A deprecated agent-configuration input detected in a process environment or
 * config file; the canonical wire shape lives in `shared/apiTypes.ts` so the
 * runtime/status pipeline reports exactly what the loader detects.
 */
export type DeprecatedAgentInput = PiWebDeprecatedAgentInput;

export function detectDeprecatedAgentInputs(env: Readonly<NodeJS.ProcessEnv>, config: Pick<PiWebConfig, "agent"> = {}): DeprecatedAgentInput[] {
  const inputs: DeprecatedAgentInput[] = [];
  if (isEnvSet(env[PI_WEB_AGENT_COMMAND_ENV])) inputs.push({ source: "environment", name: PI_WEB_AGENT_COMMAND_ENV });
  if (isEnvSet(env[PI_WEB_AGENT_DIR_ENV])) inputs.push({ source: "environment", name: PI_WEB_AGENT_DIR_ENV, replacement: PI_CODING_AGENT_DIR_ENV });
  if (isEnvSet(env[PI_WEB_AGENT_SESSION_DIR_ENV])) inputs.push({ source: "environment", name: PI_WEB_AGENT_SESSION_DIR_ENV, replacement: PI_CODING_AGENT_SESSION_DIR_ENV });
  if (config.agent?.command !== undefined) inputs.push({ source: "config", name: "agent.command" });
  if (config.agent?.dir !== undefined) inputs.push({ source: "config", name: "agent.dir", replacement: PI_CODING_AGENT_DIR_ENV });
  return inputs;
}

export function effectiveUploadsConfig(config: Pick<PiWebConfig, "uploads"> = {}): NonNullable<PiWebConfig["uploads"]> {
  return { defaultFolder: config.uploads?.defaultFolder ?? DEFAULT_UPLOADS_FOLDER };
}

export function effectiveAttachmentsConfig(config: Pick<PiWebConfig, "attachments"> = {}): NonNullable<PiWebConfig["attachments"]> {
  return { defaultFolder: config.attachments?.defaultFolder ?? DEFAULT_ATTACHMENT_FOLDER };
}

export function maxUploadBytes(env: NodeJS.ProcessEnv = process.env, config: PiWebConfig = {}): number {
  const fromEnv = env["PI_WEB_MAX_UPLOAD_BYTES"];
  if (fromEnv !== undefined && fromEnv !== "") return parseMaxUploadBytes(fromEnv, "PI_WEB_MAX_UPLOAD_BYTES");
  if (config.maxUploadBytes !== undefined) return config.maxUploadBytes;
  return DEFAULT_MAX_UPLOAD_BYTES;
}

export function piWebDataDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const configured = env["PI_WEB_DATA_DIR"];
  if (configured === undefined || configured === "") return defaultPiWebDataDir();
  return resolve(cwd, configured);
}

/** Resolve new archive destinations without changing the archive index location. */
export function sessionArchiveDirectory(env: NodeJS.ProcessEnv = process.env, config: Pick<PiWebConfig, "sessionArchive"> = {}, cwd = process.cwd()): string {
  const fromEnv = env["PI_WEB_SESSION_ARCHIVE_DIR"];
  const configured = fromEnv !== undefined && fromEnv !== "" ? fromEnv : config.sessionArchive?.directory;
  return configured === undefined ? join(piWebDataDir(env, cwd), "archived-sessions") : resolve(cwd, configured);
}

export function piWebConfigPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const configured = env["PI_WEB_CONFIG"];
  if (configured === undefined || configured === "") return defaultPiWebConfigPath(env);
  return resolve(cwd, configured);
}

export function loadPiWebConfig(options: LoadOptions = {}): LoadedPiWebConfig {
  const env = options.env ?? process.env;
  const path = piWebConfigPath(env, options.cwd ?? process.cwd());
  const defaultsSelector = envValue(env, "PI_WEB_DEFAULTS_CONFIG");
  const defaultsPath = defaultsSelector === undefined ? undefined : resolve(options.cwd ?? process.cwd(), defaultsSelector);
  // A selected defaults file is deployment policy: a missing or corrupt file fails visibly.
  const defaultsRecord = defaultsPath === undefined ? undefined : readConfigObject(defaultsPath);
  const defaultsConfig = defaultsRecord === undefined ? undefined : parseFileConfig(defaultsRecord, defaultsPath ?? path);
  const exists = existsSync(path);
  const record = exists ? readConfigObject(path) : {};
  const config = parseFileConfig(record, path);
  if (Object.hasOwn(record, "sessionNaming") || (defaultsRecord !== undefined && Object.hasOwn(defaultsRecord, "sessionNaming"))) {
    migrateSessionNamingConfig({
      agentDir: effectiveAgentConfig(env, overlayPiWebConfig(defaultsConfig ?? {}, config)).dir,
      saved: { path, record },
      ...(defaultsPath !== undefined && defaultsRecord !== undefined ? { defaults: { path: defaultsPath, record: defaultsRecord } } : {}),
      cleanup: () => {
        if (defaultsPath !== undefined && realpathSync(path) === realpathSync(defaultsPath)) {
          throw new Error(`Writable config selects deployment defaults; remove obsolete sessionNaming manually: ${path}`);
        }
        const current = readConfigObject(path);
        if (JSON.stringify(current["sessionNaming"]) !== JSON.stringify(record["sessionNaming"])) {
          throw new Error(`sessionNaming changed during migration: ${path}`);
        }
        Reflect.deleteProperty(current, "sessionNaming");
        writeWritableConfig(path, current);
      },
    });
  }
  return {
    path, exists, config,
    ...(defaultsPath !== undefined && defaultsConfig !== undefined ? { defaultsPath, defaultsConfig } : {}),
    deprecatedAgentInputs: detectDeprecatedAgentInputs(env, overlayPiWebConfig(defaultsConfig ?? {}, config)),
  };
}

export function effectivePiWebConfig(options: LoadOptions = {}): LoadedEffectivePiWebConfig {
  return resolveEffectivePiWebConfig(loadPiWebConfig(options), options);
}

export function resolveEffectivePiWebConfig(loaded: LoadedPiWebConfig, options: LoadOptions = {}): LoadedEffectivePiWebConfig {
  const env = options.env ?? process.env;
  // These bootstrap policy aliases are not file settings, but invalid explicit
  // values must fail startup rather than be discovered during a background check.
  versionChecksDisabled(env);
  const config = applyPiWebConfigEnv(overlayPiWebConfig(loaded.defaultsConfig ?? {}, loaded.config), env);
  const agent = effectiveAgentConfig(env, config);
  return {
    ...loaded,
    config: {
      ...config,
      uploads: effectiveUploadsConfig(config),
      attachments: effectiveAttachmentsConfig(config),
      // Always resolved (on by default) so the effective config is the single
      // source of truth for the runtime state and the settings UI toggle.
      spawnSessions: spawnSessionsEnabled({}, config),
      sessionMessages: sessionMessagesEnabled({}, config),
      // Resolved on by default like the other capabilities,
      // so the effective config is the single source of truth for the runtime
      // state and the settings UI toggle.
      subsessions: subsessionsEnabled({}, config),
      // Always resolved (on by default); the user is present for every ask.
      askUser: askUserEnabled({}, config),
      // Always resolved (on by default); inert outside Docker deployments.
      environmentFacts: environmentFactsEnabled({}, config),
      // Always resolved; the unattended-dialog safety valve, not a gate.
      extensionDialogsTimeoutMs: config.extensionDialogsTimeoutMs ?? DEFAULT_EXTENSION_DIALOGS_TIMEOUT_MS,
      agent,
    },
  };
}

export function savePiWebConfig(config: PiWebConfig, options: LoadOptions = {}): LoadedPiWebConfig {
  rejectRetiredSessionNaming(config, "save request");
  const env = options.env ?? process.env;
  const path = piWebConfigPath(env, options.cwd ?? process.cwd());
  const defaultsSelector = envValue(env, "PI_WEB_DEFAULTS_CONFIG");
  if (defaultsSelector !== undefined) {
    const defaultsPath = resolve(options.cwd ?? process.cwd(), defaultsSelector);
    const canonicalPath = (candidate: string): string => existsSync(candidate) ? realpathSync(candidate) : resolve(candidate);
    if (canonicalPath(path) === canonicalPath(defaultsPath)) throw new Error("PI_WEB_CONFIG must not select the PI_WEB_DEFAULTS_CONFIG file");
    // Validate deployment policy before touching the writable file.
    parseFileConfig(readConfigObject(defaultsPath), defaultsPath);
  }
  const normalized = parsePiWebConfig(piWebConfigRecord(config), path);
  effectiveAgentConfig(env, normalized);
  const existing = readExistingConfigObject(path);
  if (existing["agent"] !== undefined) parseAgentConfig(existing["agent"], path);
  for (const key of [...Object.keys(PI_WEB_CONFIG_DEFINITIONS), "agent", "respectProjectTrust"]) Reflect.deleteProperty(existing, key);
  const merged = { ...existing, ...piWebConfigRecord(normalized) };
  writeWritableConfig(path, merged);
  return loadPiWebConfig(options);
}

/** Replace the resolved target atomically, preserving config symlinks and permissions. */
function writeWritableConfig(path: string, config: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const destination = existsSync(path) ? realpathSync(path) : path;
  const mode = existsSync(destination) ? statSync(destination).mode & 0o777 : 0o600;
  const temporary = join(dirname(destination), `.${basename(destination)}.${String(process.pid)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode, flag: "wx" });
    chmodSync(temporary, mode);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readConfigObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`PI WEB config must be a JSON object: ${path}`);
  return parsed;
}

function parseFileConfig(record: Record<string, unknown>, path: string): PiWebConfig {
  const sanitized = { ...record };
  Reflect.deleteProperty(sanitized, "sessionNaming");
  return parsePiWebConfig(sanitized, path);
}

function rejectRetiredSessionNaming(value: object, path: string): void {
  if (Object.hasOwn(value, "sessionNaming")) throw new Error(`PI WEB config sessionNaming is retired; use the Session naming Pi package config: ${path}`);
}

function parseEnvJson(value: string, source: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch (error) {
    throw new Error(`${source} must contain valid JSON`, { cause: error });
  }
}

function piWebConfigEnvOverrides(env: NodeJS.ProcessEnv): { config: PiWebConfig; enforced: Record<string, string> } {
  let config: PiWebConfig = {};
  const enforced: Record<string, string> = {};
  for (const [key, kind] of Object.entries(PI_WEB_CONFIG_DEFINITIONS)) {
    const canonicalName = piWebConfigEnvName(key);
    const name = key === "port" && env[canonicalName] === undefined ? "PORT" : canonicalName;
    const value = env[name];
    if (value === undefined) continue;
    // Existing scalar overrides treat empty as unset; new strings (notably
    // installationName) retain meaningful empty values. Booleans are strict.
    if (value === "" && ["host", "port", "allowedHosts", "maxUploadBytes"].includes(key)) continue;
    let parsed: unknown;
    if (kind === "json") parsed = parseEnvJson(value, name);
    else if (kind === "boolean") parsed = parsePiWebEnvBoolean(value, name);
    else if (kind === "number") parsed = value === "" ? NaN : Number(value);
    else if (kind === "allowedHosts") parsed = parseAllowedHostsEnv(value);
    else parsed = value;
    if (key === "plugins" && isRecord(parsed)) {
      for (const [id, plugin] of Object.entries(parsed)) {
        if (isRecord(plugin)) requireKnownConfigKeys(plugin, ["enabled", "settings"], `plugins.${id}`, name);
      }
    }
    const override = parsePiWebConfig({ [key]: parsed }, name);
    config = overlayPiWebConfig(config, override);
    for (const pointer of piWebConfigSettingPointers(override)) enforced[pointer] = name;
  }
  const archiveDir = envValue(env, "PI_WEB_SESSION_ARCHIVE_DIR");
  if (archiveDir !== undefined) {
    config = overlayPiWebConfig(config, { sessionArchive: parseSessionArchiveConfig({ directory: archiveDir }, "PI_WEB_SESSION_ARCHIVE_DIR") });
    enforced["/sessionArchive/directory"] = "PI_WEB_SESSION_ARCHIVE_DIR";
  }
  return { config, enforced };
}

/** Apply after project participation as well as machine overlays. Does not mutate inputs. */
export function applyPiWebConfigEnv(config: PiWebConfig, env: NodeJS.ProcessEnv): PiWebConfig {
  return overlayPiWebConfig(config, piWebConfigEnvOverrides(env).config);
}

/** JSON-pointer setting identifiers mapped to the controlling environment variable. */
export function piWebConfigEnforcedSettings(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return piWebConfigEnvOverrides(env).enforced;
}

/** Sources describe explicit settings only; omitted entries inherit built-in/feature defaults. */
export function piWebConfigSources(loaded: LoadedPiWebConfig, options: LoadOptions = {}): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const pointer of piWebConfigSettingPointers(loaded.defaultsConfig ?? {})) sources[pointer] = "defaults";
  for (const pointer of piWebConfigSettingPointers(loaded.config)) sources[pointer] = "config";
  Object.assign(sources, piWebConfigEnforcedSettings(options.env ?? process.env));
  return sources;
}

function readExistingConfigObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`PI WEB config must be a JSON object: ${path}`);
  return parsed;
}

function piWebConfigRecord(config: PiWebConfig): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([key, value]) => value !== undefined && (Object.hasOwn(PI_WEB_CONFIG_DEFINITIONS, key) || key === "agent")));
}

function requireKnownConfigKeys(value: Record<string, unknown>, allowed: readonly string[], key: string, path: string): void {
  const unknown = Object.keys(value).find((name) => !allowed.includes(name));
  if (unknown !== undefined) throw new Error(`PI WEB config ${key} has unknown key ${JSON.stringify(unknown)}: ${path}`);
}

function requireNamespaceKeys(value: Record<string, unknown>, key: string, path: string): void {
  requireKnownConfigKeys(value, piWebConfigNamespaceFields(key) ?? [], key, path);
}

export function parsePiWebConfig(value: Record<string, unknown>, path = "request", pathHost: AgentPathHost = "current"): PiWebConfig {
  rejectRetiredSessionNaming(value, path);
  return {
    ...(value["installationName"] !== undefined ? { installationName: requireInstallationName(value["installationName"], `PI WEB config installationName: ${path}`) } : {}),
    ...(value["host"] !== undefined ? { host: parseString(value["host"], "host", path) } : {}),
    ...(value["port"] !== undefined ? { port: parsePort(value["port"], "port", path) } : {}),
    ...(value["allowedHosts"] !== undefined ? { allowedHosts: parseAllowedHosts(value["allowedHosts"], path) } : {}),
    ...(value["shortcuts"] !== undefined ? { shortcuts: parseShortcuts(value["shortcuts"], path) } : {}),
    ...(value["defaultTheme"] !== undefined ? { defaultTheme: requireDefaultThemePreference(value["defaultTheme"], path) } : {}),
    ...(value["defaultLocalization"] !== undefined ? { defaultLocalization: requireDefaultLocalization(value["defaultLocalization"], path) } : {}),
    ...(value["defaultStreamingBehavior"] !== undefined ? { defaultStreamingBehavior: requireDefaultStreamingBehavior(value["defaultStreamingBehavior"], path) } : {}),
    ...(value["quietMode"] !== undefined ? { quietMode: parseBooleanKey(value["quietMode"], "quietMode", path) } : {}),
    ...(value["plugins"] !== undefined ? { plugins: parsePlugins(value["plugins"], path) } : {}),
    ...(value["basePaths"] !== undefined ? { basePaths: parseBasePaths(value["basePaths"], path) } : {}),
    ...(value["pathAccess"] !== undefined ? { pathAccess: parsePathAccessConfig(value["pathAccess"], path) } : {}),
    ...(value["uploads"] !== undefined ? { uploads: parseUploadsConfig(value["uploads"], path) } : {}),
    ...(value["attachments"] !== undefined ? { attachments: parseAttachmentsConfig(value["attachments"], path) } : {}),
    ...(value["maxUploadBytes"] !== undefined ? { maxUploadBytes: parseMaxUploadBytes(value["maxUploadBytes"], "maxUploadBytes", path) } : {}),
    ...(value["sessionArchive"] !== undefined ? { sessionArchive: parseSessionArchiveConfig(value["sessionArchive"], path) } : {}),
    ...(value["spawnSessions"] !== undefined ? { spawnSessions: parseSpawnSessions(value["spawnSessions"], path) } : {}),
    ...(value["sessionMessages"] !== undefined ? { sessionMessages: parseBooleanKey(value["sessionMessages"], "sessionMessages", path) } : {}),
    ...(value["subsessions"] !== undefined ? { subsessions: parseSubsessions(value["subsessions"], path) } : {}),
    ...(value["askUser"] !== undefined ? { askUser: parseAskUser(value["askUser"], path) } : {}),
    ...(value["environmentFacts"] !== undefined ? { environmentFacts: parseBooleanKey(value["environmentFacts"], "environmentFacts", path) } : {}),
    ...(value["extensionDialogsTimeoutMs"] !== undefined ? { extensionDialogsTimeoutMs: parseExtensionDialogsTimeoutMs(value["extensionDialogsTimeoutMs"], path) } : {}),
    ...(value["agent"] !== undefined ? { agent: parseAgentConfig(value["agent"], path, pathHost) } : {}),
  };
}

export function parseSessionArchiveConfig(value: unknown, path: string): NonNullable<PiWebConfigValues["sessionArchive"]> {
  if (!isRecord(value)) throw new Error(`PI WEB config sessionArchive must be an object: ${path}`);
  requireNamespaceKeys(value, "sessionArchive", path);
  const directory = value["directory"];
  if (directory === undefined) return {};
  if (typeof directory !== "string" || directory.trim() === "" || directory.includes("\u0000")) {
    throw new Error(`PI WEB config sessionArchive.directory must be a non-empty path: ${path}`);
  }
  return { directory };
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
  if (fromEnv !== undefined) return parsePiWebEnvBoolean(fromEnv, "PI_WEB_SPAWN_SESSIONS");
  return config.spawnSessions ?? true;
}

/** Whether LLMs may send messages to other sessions, independently of spawning. */
export function sessionMessagesEnabled(env: NodeJS.ProcessEnv = process.env, config: PiWebConfig = {}): boolean {
  const fromEnv = env["PI_WEB_SESSION_MESSAGES"];
  if (fromEnv !== undefined) return parsePiWebEnvBoolean(fromEnv, "PI_WEB_SESSION_MESSAGES");
  return config.sessionMessages ?? true;
}

function parseSubsessions(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`PI WEB config subsessions must be a boolean: ${path}`);
  return value;
}

/**
 * Whether LLMs may start tracked child sessions via the spawn_subsession
 * family of tools. On by default; set the env var `PI_WEB_SUBSESSIONS` or the
 * `subsessions` config key to `false` to disable. The env var takes precedence
 * over the config file. Subsessions also require spawnSessions to be enabled
 * (they share the same project-scope resolver).
 */
export function subsessionsEnabled(env: NodeJS.ProcessEnv = process.env, config: PiWebConfig = {}): boolean {
  const fromEnv = env["PI_WEB_SUBSESSIONS"];
  if (fromEnv !== undefined) return parsePiWebEnvBoolean(fromEnv, "PI_WEB_SUBSESSIONS");
  return config.subsessions ?? true;
}

function parseAskUser(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`PI WEB config askUser must be a boolean: ${path}`);
  return value;
}

function parseExtensionDialogsTimeoutMs(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_TIMER_TIMEOUT_MS) {
    throw new Error(`PI WEB config extensionDialogsTimeoutMs must be a non-negative integer no greater than ${String(MAX_TIMER_TIMEOUT_MS)}: ${path}`);
  }
  return value;
}

/**
 * Whether LLMs may post a question set to the browser via the ask_user tool. On
 * by default: the questions land in the session the user is already watching and
 * nothing happens without them acting. Set the env var `PI_WEB_ASK_USER` or the
 * `askUser` config key to `false` to remove the tool. The env var takes
 * precedence over the config file.
 */
export function askUserEnabled(env: NodeJS.ProcessEnv = process.env, config: PiWebConfig = {}): boolean {
  const fromEnv = env["PI_WEB_ASK_USER"];
  if (fromEnv !== undefined) return parsePiWebEnvBoolean(fromEnv, "PI_WEB_ASK_USER");
  return config.askUser ?? true;
}

function parseBooleanKey(value: unknown, key: string, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`PI WEB config ${key} must be a boolean: ${path}`);
  return value;
}

/**
 * Whether PI WEB appends deployment environment facts to session system
 * prompts. On by default; set the env var `PI_WEB_ENVIRONMENT_FACTS` or the
 * `environmentFacts` config key to `false` to leave the system prompt
 * untouched. The env var takes precedence over the config file.
 *
 * The facts describe the pi-web session nesting every session runs in; Docker
 * deployments append container facts on top. The env var deliberately avoids
 * the `PI_WEB_DOCKER_` prefix, which agent processes inherit for
 * `pi-web-docker`.
 */
export function environmentFactsEnabled(env: NodeJS.ProcessEnv = process.env, config: PiWebConfig = {}): boolean {
  const fromEnv = env["PI_WEB_ENVIRONMENT_FACTS"];
  if (fromEnv !== undefined) return parsePiWebEnvBoolean(fromEnv, "PI_WEB_ENVIRONMENT_FACTS");
  return config.environmentFacts ?? true;
}

const OFFLINE_ENV_KEYS = ["PI_WEB_OFFLINE", "PI_OFFLINE"] as const;

/**
 * Whether the operator asked PI WEB (or pi itself) to stay offline, meaning
 * background network access must be skipped. Both aliases use strict boolean
 * parsing; false/0 no longer enable offline mode.
 *
 * Deliberately narrower than `piWebStatus`'s update-check suppression: the
 * `*_SKIP_VERSION_CHECK` keys only silence release lookups, while these keys ask
 * for no background network at all.
 */
export function offlineModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Validate every supplied alias, even if another alias already enables offline mode.
  const values = OFFLINE_ENV_KEYS.map((key) => {
    const value = env[key];
    return value === undefined ? false : parsePiWebEnvBoolean(value, key);
  });
  return values.some(Boolean);
}

function parseString(value: unknown, key: string, path: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`PI WEB config ${key} must be a non-empty string: ${path}`);
  return value;
}

/**
 * Keys still accepted under `agent` during the deprecation window: `command`
 * is parsed only so the file round-trips and the deprecation detector can name
 * it (the concept is gone), and `dir` remains honored as a deprecated alias.
 * The section has no live schema — every accepted key is deprecated — so any
 * other key fails loudly, naming the deprecated survivors.
 */
const DEPRECATED_AGENT_CONFIG_KEYS = new Set(["command", "dir"]);

export type AgentPathHost = "current" | "portable";

export function parseAgentConfig(value: unknown, path: string, pathHost: AgentPathHost = "current"): NonNullable<PiWebConfig["agent"]> {
  if (!isRecord(value)) throw new Error(`PI WEB config agent must be an object: ${path}`);
  const unknownKey = Object.keys(value).find((key) => !DEPRECATED_AGENT_CONFIG_KEYS.has(key));
  if (unknownKey !== undefined) throw new Error(`PI WEB config agent accepts only the deprecated keys "command" and "dir"; unknown key ${JSON.stringify(unknownKey)}: ${path}`);
  const command = value["command"];
  const dir = value["dir"];
  return {
    // `agent.command` is deprecated and ignored (the multi-CLI abstraction is
    // gone): it is parsed only so the file round-trips faithfully and the
    // deprecation detector can name it. `agent.dir` is still honored as a
    // deprecated alias during the deprecation window, so it keeps validation.
    ...(command !== undefined ? { command: parseString(command, "agent.command", path) } : {}),
    ...(dir !== undefined ? { dir: parseAgentDir(dir, "agent.dir", path, pathHost) } : {}),
  };
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
  if (value.trim() === "true") return true;
  if (["[", "{", "\"", "]"].some((prefix) => value.trimStart().startsWith(prefix)) || /^(false|null)$/.test(value.trim())) {
    return parseAllowedHosts(parseEnvJson(value, "PI_WEB_ALLOWED_HOSTS"), "PI_WEB_ALLOWED_HOSTS");
  }
  return value.split(",").map((host) => host.trim()).filter((host) => host !== "");
}

export function parsePathAccessConfig(value: unknown, path: string): NonNullable<PiWebConfigValues["pathAccess"]> {
  if (!isRecord(value)) throw new Error(`PI WEB config pathAccess must be an object: ${path}`);
  requireNamespaceKeys(value, "pathAccess", path);
  const allowedPaths = value["allowedPaths"];
  return {
    ...(allowedPaths !== undefined ? { allowedPaths: parseAllowedPaths(allowedPaths, path) } : {}),
  };
}

function parseBasePaths(value: unknown, path = "request"): string[] {
  if (!isNonEmptyStringArray(value)) throw new Error(`PI WEB config basePaths must be an array of non-empty strings: ${path}`);
  return value;
}

function parseAllowedPaths(value: unknown, path: string): string[] {
  if (!isNonEmptyStringArray(value)) throw new Error(`PI WEB config pathAccess.allowedPaths must be an array of non-empty strings: ${path}`);
  return value;
}

export function parseUploadsConfig(value: unknown, path: string): NonNullable<PiWebConfigValues["uploads"]> {
  if (!isRecord(value)) throw new Error(`PI WEB config uploads must be an object: ${path}`);
  requireNamespaceKeys(value, "uploads", path);
  const defaultFolder = value["defaultFolder"];
  return {
    ...(defaultFolder !== undefined ? { defaultFolder: parseWorkspaceRelativeFolder(defaultFolder, "uploads.defaultFolder", path) } : {}),
  };
}

export function parseAttachmentsConfig(value: unknown, path: string): NonNullable<PiWebConfigValues["attachments"]> {
  if (!isRecord(value)) throw new Error(`PI WEB config attachments must be an object: ${path}`);
  requireNamespaceKeys(value, "attachments", path);
  const defaultFolder = value["defaultFolder"];
  return {
    ...(defaultFolder !== undefined ? { defaultFolder: parseWorkspaceRelativeFolder(defaultFolder, "attachments.defaultFolder", path) } : {}),
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

// Exact mirror of the pi SDK default (`getAgentDir()`: `~/.pi/agent`) rather
// than a delegation, so the injected `env` stays authoritative; if the bundled
// SDK is ever swapped for a fork whose default moves, this mirror must move
// with it or the two resolutions drift.
function defaultAgentDir(env: NodeJS.ProcessEnv): string {
  return expandHomePath("~/.pi/agent", env);
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value !== undefined && value !== "" ? value : undefined;
}

function isEnvSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
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

