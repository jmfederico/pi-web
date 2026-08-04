import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { piWebConfigPath } from "./config.js";
import { isPiWebPluginId } from "./shared/pluginIds.js";

export type ServerPluginSafeStart = "bundled-only" | "none";

export interface ServerPluginRecoveryConfig {
  path: string;
  exists: boolean;
  /** Effective level. Malformed configured state resolves to `none`. */
  safeStart?: ServerPluginSafeStart;
  safeStartDiagnostic?: string;
}

interface ResolvedServerPluginSafeStart {
  safeStart?: ServerPluginSafeStart;
  safeStartDiagnostic?: string;
}

export interface ServerPluginRecoveryConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  configPath?: string;
}

const SERVER_PLUGINS_CONFIG_KEY = "serverPlugins";
const SAFE_START_CONFIG_KEY = "safeStart";

/**
 * Reads only host-owned recovery state. It neither discovers plugins nor needs
 * a running session daemon, so it is safe to use before any server import.
 */
export function loadServerPluginRecoveryConfig(
  options: ServerPluginRecoveryConfigOptions = {},
): ServerPluginRecoveryConfig {
  const path = recoveryConfigPath(options);
  if (!existsSync(path)) return { path, exists: false };
  const root = readConfigObject(path);
  return {
    path,
    exists: true,
    ...resolveSafeStart(root, path),
  };
}

/** Offline recovery mutation that preserves settings and unrelated config. */
export function disableServerPlugin(
  pluginId: string,
  options: ServerPluginRecoveryConfigOptions = {},
): ServerPluginRecoveryConfig {
  if (!isPiWebPluginId(pluginId)) throw new Error(`Invalid PI WEB plugin id: ${pluginId}`);
  return mutateRecoveryConfig(options, (root, path) => {
    const configuredPlugins = root["plugins"];
    if (configuredPlugins !== undefined && !isRecord(configuredPlugins)) {
      throw new Error(`PI WEB config plugins must be an object: ${path}`);
    }
    const plugins = configuredPlugins ?? {};
    const configuredPlugin = Object.hasOwn(plugins, pluginId) ? plugins[pluginId] : undefined;
    if (configuredPlugin !== undefined && !isRecord(configuredPlugin)) {
      throw new Error(`PI WEB config plugin ${pluginId} must be an object: ${path}`);
    }
    root["plugins"] = {
      ...plugins,
      [pluginId]: { ...(configuredPlugin ?? {}), enabled: false },
    };
  });
}

/** Set a persistent safe-start level, or clear it by passing undefined. */
export function setServerPluginSafeStart(
  safeStart: ServerPluginSafeStart | undefined,
  options: ServerPluginRecoveryConfigOptions = {},
): ServerPluginRecoveryConfig {
  return mutateRecoveryConfig(options, (root) => {
    const configuredServerPlugins = root[SERVER_PLUGINS_CONFIG_KEY];
    if (configuredServerPlugins !== undefined && !isRecord(configuredServerPlugins)) {
      if (safeStart === undefined) {
        Reflect.deleteProperty(root, SERVER_PLUGINS_CONFIG_KEY);
      } else {
        root[SERVER_PLUGINS_CONFIG_KEY] = { [SAFE_START_CONFIG_KEY]: safeStart };
      }
      return;
    }

    const serverPlugins = { ...(configuredServerPlugins ?? {}) };
    if (safeStart === undefined) {
      Reflect.deleteProperty(serverPlugins, SAFE_START_CONFIG_KEY);
    } else {
      serverPlugins[SAFE_START_CONFIG_KEY] = safeStart;
    }
    if (Object.keys(serverPlugins).length === 0) {
      Reflect.deleteProperty(root, SERVER_PLUGINS_CONFIG_KEY);
    } else {
      root[SERVER_PLUGINS_CONFIG_KEY] = serverPlugins;
    }
  });
}

function recoveryConfigPath(options: ServerPluginRecoveryConfigOptions): string {
  const cwd = options.cwd ?? process.cwd();
  return options.configPath === undefined
    ? piWebConfigPath(options.env ?? process.env, cwd)
    : resolve(cwd, options.configPath);
}

function mutateRecoveryConfig(
  options: ServerPluginRecoveryConfigOptions,
  mutate: (root: Record<string, unknown>, path: string) => void,
): ServerPluginRecoveryConfig {
  const path = recoveryConfigPath(options);
  const root = existsSync(path) ? readConfigObject(path) : {};
  mutate(root, path);
  const safeStart = resolveSafeStart(root, path);
  writeConfigObject(path, root);
  return {
    path,
    exists: true,
    ...safeStart,
  };
}

function readConfigObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`PI WEB config must be a JSON object: ${path}`);
  return parsed;
}

function resolveSafeStart(root: Record<string, unknown>, path: string): ResolvedServerPluginSafeStart {
  const configuredServerPlugins = root[SERVER_PLUGINS_CONFIG_KEY];
  if (configuredServerPlugins === undefined) return {};
  if (!isRecord(configuredServerPlugins)) {
    return invalidSafeStart(`PI WEB config ${SERVER_PLUGINS_CONFIG_KEY} must be an object: ${path}`);
  }
  const safeStart = configuredServerPlugins[SAFE_START_CONFIG_KEY];
  if (safeStart === undefined) return {};
  if (safeStart !== "bundled-only" && safeStart !== "none") {
    return invalidSafeStart(`PI WEB config ${SERVER_PLUGINS_CONFIG_KEY}.${SAFE_START_CONFIG_KEY} must be "bundled-only" or "none": ${path}`);
  }
  return { safeStart };
}

function invalidSafeStart(message: string): ResolvedServerPluginSafeStart {
  return {
    safeStart: "none",
    safeStartDiagnostic: `${message}. No server plugins will be loaded until safe start is repaired.`,
  };
}

function writeConfigObject(path: string, root: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const destinationPath = existsSync(path) ? realpathSync(path) : path;
  const mode = existingMode(destinationPath);
  const temporaryPath = join(dirname(destinationPath), `.${basename(destinationPath)}.${String(process.pid)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(root, null, 2)}\n`, { encoding: "utf8", mode });
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, destinationPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function existingMode(path: string): number {
  if (!existsSync(path)) return 0o600;
  return statSync(path).mode & 0o777;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
