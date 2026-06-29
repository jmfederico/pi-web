import type { FastifyInstance } from "fastify";
import { effectiveAgentConfig, effectivePiWebConfig, hasAgentDirEnvOverride, hasAgentSessionDirEnvOverride, loadPiWebConfig, parseUploadsConfig, savePiWebConfig, type LoadOptions, type PiWebConfig } from "../config.js";
import type { PiWebConfigEnvOverrides, PiWebConfigResponse, PiWebConfigValues } from "../shared/apiTypes.js";
import { isPiWebPluginId } from "../shared/pluginIds.js";

export interface PiWebConfigService {
  read: () => PiWebConfigResponse | Promise<PiWebConfigResponse>;
  write: (config: PiWebConfigValues) => PiWebConfigResponse | Promise<PiWebConfigResponse>;
}

export function createFilePiWebConfigService(options: LoadOptions = {}): PiWebConfigService {
  return {
    read: () => currentPiWebConfigResponse(options),
    write: (config) => {
      savePiWebConfig(config, options);
      return currentPiWebConfigResponse(options);
    },
  };
}

export function currentPiWebConfigResponse(options: LoadOptions = {}): PiWebConfigResponse {
  const loaded = loadPiWebConfig(options);
  const effective = effectivePiWebConfig(options);
  const env = options.env ?? process.env;
  return {
    path: loaded.path,
    exists: loaded.exists,
    config: loaded.config,
    effectiveConfig: effective.config,
    envOverrides: piWebConfigEnvOverrides(env, loaded.config),
  };
}

export function registerConfigRoutes(app: FastifyInstance, service: PiWebConfigService = createFilePiWebConfigService()): void {
  app.get("/api/config", async (_request, reply) => {
    try {
      return await service.read();
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Body: { config?: unknown } | undefined }>("/api/config", async (request, reply) => {
    try {
      return await service.write(parseConfigRequest(request.body?.config));
    } catch (error) {
      const status = isConfigValidationError(error) ? 400 : 500;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });
}

function parseConfigRequest(value: unknown): PiWebConfig {
  if (!isRecord(value)) throw new Error("PI WEB config update must include a config object");
  const config: PiWebConfig = {};
  const host = value["host"];
  const port = value["port"];
  const allowedHosts = value["allowedHosts"];
  const shortcuts = value["shortcuts"];
  const plugins = value["plugins"];
  const pathAccess = value["pathAccess"];
  const uploads = value["uploads"];
  const maxUploadBytes = value["maxUploadBytes"];
  const spawnSessions = value["spawnSessions"];
  const subsessions = value["subsessions"];
  const agent = value["agent"];
  if (host !== undefined) {
    if (typeof host !== "string") throw new Error("PI WEB config host must be a string");
    config.host = host;
  }
  if (port !== undefined) {
    if (typeof port !== "number") throw new Error("PI WEB config port must be a number");
    config.port = port;
  }
  if (allowedHosts !== undefined) config.allowedHosts = parseAllowedHostsRequest(allowedHosts);
  if (shortcuts !== undefined) config.shortcuts = parseShortcutsRequest(shortcuts);
  if (plugins !== undefined) config.plugins = parsePluginsRequest(plugins);
  if (pathAccess !== undefined) config.pathAccess = parsePathAccessRequest(pathAccess);
  if (uploads !== undefined) config.uploads = parseUploadsConfig(uploads, "request");
  if (maxUploadBytes !== undefined) config.maxUploadBytes = parseMaxUploadBytesRequest(maxUploadBytes);
  if (spawnSessions !== undefined) {
    if (typeof spawnSessions !== "boolean") throw new Error("PI WEB config spawnSessions must be a boolean");
    config.spawnSessions = spawnSessions;
  }
  if (subsessions !== undefined) {
    if (typeof subsessions !== "boolean") throw new Error("PI WEB config subsessions must be a boolean");
    config.subsessions = subsessions;
  }
  if (agent !== undefined) config.agent = parseAgentRequest(agent);
  return config;
}

function parseAllowedHostsRequest(value: unknown): string[] | true {
  if (value === true) return true;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("PI WEB config allowedHosts must be true or an array of strings");
  }
  return value;
}

function parseShortcutsRequest(value: unknown): Record<string, string | null> {
  if (!isRecord(value)) throw new Error("PI WEB config shortcuts must be an object");
  return Object.fromEntries(Object.entries(value).map(([actionId, shortcut]) => {
    if (shortcut !== null && (typeof shortcut !== "string" || shortcut === "")) throw new Error("PI WEB config shortcut values must be non-empty strings or null");
    return [actionId, shortcut];
  }));
}

function parsePathAccessRequest(value: unknown): NonNullable<PiWebConfig["pathAccess"]> {
  if (!isRecord(value)) throw new Error("PI WEB config pathAccess must be an object");
  const allowedPaths = value["allowedPaths"];
  return {
    ...(allowedPaths === undefined ? {} : { allowedPaths: parseAllowedPathsRequest(allowedPaths) }),
  };
}

function parseAllowedPathsRequest(value: unknown): string[] {
  if (!isNonEmptyStringArray(value)) {
    throw new Error("PI WEB config pathAccess.allowedPaths must be an array of non-empty strings");
  }
  return value;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");
}

function parseMaxUploadBytesRequest(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error("PI WEB config maxUploadBytes must be a positive integer");
  return value;
}

function parseAgentRequest(value: unknown): NonNullable<PiWebConfig["agent"]> {
  if (!isRecord(value)) throw new Error("PI WEB config agent must be an object");
  const command = value["command"];
  const dir = value["dir"];
  return {
    ...(command === undefined ? {} : { command: parseAgentCommandRequest(command) }),
    ...(dir === undefined ? {} : { dir: parseAgentDirRequest(dir) }),
  };
}

function parseAgentCommandRequest(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("PI WEB config agent.command must be a non-empty string");
  const command = value.trim();
  if (/[\s;&|`$<>]/u.test(command)) throw new Error("PI WEB config agent.command must be a single command name or path without shell metacharacters");
  return command;
}

function parseAgentDirRequest(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("PI WEB config agent.dir must be a non-empty string");
  const dir = value.trim();
  if (!isAbsoluteOrHomePath(dir)) throw new Error("PI WEB config agent.dir must be an absolute path or start with ~");
  return dir;
}

function parsePluginsRequest(value: unknown): NonNullable<PiWebConfig["plugins"]> {
  if (!isRecord(value) || Array.isArray(value)) throw new Error("PI WEB config plugins must be an object");
  return Object.fromEntries(Object.entries(value).map(([pluginId, config]) => {
    if (!isPiWebPluginId(pluginId)) throw new Error("PI WEB config plugin ids are invalid");
    if (!isRecord(config) || Array.isArray(config)) throw new Error("PI WEB config plugin entries must be objects");
    const enabled = config["enabled"];
    if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("PI WEB config plugin enabled values must be booleans");
    const settings = config["settings"];
    if (settings !== undefined && (!isRecord(settings) || Array.isArray(settings))) throw new Error("PI WEB config plugin settings must be objects");
    return [pluginId, config];
  }));
}

function piWebConfigEnvOverrides(env: NodeJS.ProcessEnv, config: PiWebConfig = {}): PiWebConfigEnvOverrides {
  const agent = effectiveAgentConfig(env, config);
  return {
    host: isEnvSet(env["PI_WEB_HOST"]),
    port: isEnvSet(env["PI_WEB_PORT"]) || isEnvSet(env["PORT"]),
    allowedHosts: isEnvSet(env["PI_WEB_ALLOWED_HOSTS"]),
    spawnSessions: isEnvSet(env["PI_WEB_SPAWN_SESSIONS"]),
    subsessions: isEnvSet(env["PI_WEB_SUBSESSIONS"]),
    agentCommand: isEnvSet(env["PI_WEB_AGENT_COMMAND"]),
    agentDir: hasAgentDirEnvOverride(env, agent.command),
    agentSessionDir: hasAgentSessionDirEnvOverride(env, agent.command),
  };
}

function isEnvSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

function isConfigValidationError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("PI WEB config");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbsoluteOrHomePath(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\") || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
