import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { effectiveAttachmentsConfig, effectiveUploadsConfig, parseAttachmentsConfig, parsePathAccessConfig, parseUploadsConfig, type PiWebConfig } from "../../config.js";
import type { JsonObject, JsonValue, PiWebAttachmentsConfig, PiWebPathAccessConfig, PiWebUploadsConfig } from "../../shared/apiTypes.js";
import { isPiWebPluginId, piWebPluginIdPattern } from "../../shared/pluginIds.js";

export const PROJECT_PI_WEB_CONFIG_PATH = ".pi-web/config.json";

export interface ProjectPiWebConfig {
  version?: 1;
  pathAccess?: PiWebPathAccessConfig;
  uploads?: PiWebUploadsConfig;
  attachments?: PiWebAttachmentsConfig;
  plugins?: Readonly<Record<string, ProjectPluginConfig>>;
}

export interface ProjectPluginConfig {
  readonly settings?: JsonObject;
}

export interface LoadedProjectPiWebConfig {
  path: string;
  exists: boolean;
  config: ProjectPiWebConfig;
}

export async function loadProjectPiWebConfig(projectPath: string, signal?: AbortSignal): Promise<LoadedProjectPiWebConfig> {
  const path = join(projectPath, PROJECT_PI_WEB_CONFIG_PATH);
  try {
    signal?.throwIfAborted();
    // Follow symlinks, but reject devices/directories/FIFOs before opening them.
    if (!(await stat(path)).isFile()) throw new Error(`PI WEB project config must be a regular file: ${path}`);
    signal?.throwIfAborted();
    // A path can change after stat. Nonblocking open prevents a replacement FIFO
    // from occupying a worker; validate and read only this same descriptor.
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      signal?.throwIfAborted();
      if (!(await handle.stat()).isFile()) throw new Error(`PI WEB project config must be a regular file: ${path}`);
      signal?.throwIfAborted();
      const content = await handle.readFile({ encoding: "utf8", signal });
      signal?.throwIfAborted();
      const parsed: unknown = JSON.parse(content);
      if (!isRecord(parsed)) throw new Error(`PI WEB project config must be a JSON object: ${path}`);
      return { path, exists: true, config: parseProjectPiWebConfig(parsed, path) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (isNodeErrorWithCode(error, "ENOENT")) return { path, exists: false, config: {} };
    throw error;
  }
}

export async function loadEffectiveProjectPathAccess(projectPath: string, globalConfig: PiWebConfig): Promise<PiWebPathAccessConfig | undefined> {
  const projectConfig = await loadProjectPiWebConfig(projectPath);
  return mergePathAccessConfigs(globalConfig.pathAccess, projectConfig.config.pathAccess);
}

export async function loadEffectiveProjectUploadsConfig(projectPath: string, globalConfig: PiWebConfig): Promise<PiWebUploadsConfig> {
  const projectConfig = await loadProjectPiWebConfig(projectPath);
  return effectiveUploadsConfig({ uploads: { ...(globalConfig.uploads ?? {}), ...(projectConfig.config.uploads ?? {}) } });
}

export async function loadEffectiveProjectAttachmentsConfig(projectPath: string, globalConfig: PiWebConfig): Promise<PiWebAttachmentsConfig> {
  const projectConfig = await loadProjectPiWebConfig(projectPath);
  return effectiveAttachmentsConfig({ attachments: { ...(globalConfig.attachments ?? {}), ...(projectConfig.config.attachments ?? {}) } });
}

export function mergePathAccessConfigs(...configs: (PiWebPathAccessConfig | undefined)[]): PiWebPathAccessConfig | undefined {
  const allowedPaths = dedupe(configs.flatMap((config) => config?.allowedPaths ?? []));
  return allowedPaths.length === 0 ? undefined : { allowedPaths };
}

function parseProjectPiWebConfig(value: Record<string, unknown>, path: string): ProjectPiWebConfig {
  const version = value["version"];
  return {
    ...(version !== undefined ? { version: parseProjectConfigVersion(version, path) } : {}),
    ...(value["pathAccess"] !== undefined ? { pathAccess: parsePathAccessConfig(value["pathAccess"], path) } : {}),
    ...(value["uploads"] !== undefined ? { uploads: parseUploadsConfig(value["uploads"], path) } : {}),
    ...(value["attachments"] !== undefined ? { attachments: parseAttachmentsConfig(value["attachments"], path) } : {}),
    ...(value["plugins"] !== undefined ? { plugins: parseProjectPlugins(value["plugins"], path) } : {}),
  };
}

function parseProjectPlugins(value: unknown, path: string): NonNullable<ProjectPiWebConfig["plugins"]> {
  if (!isRecord(value)) throw new Error(`PI WEB project config plugins must be an object: ${path}`);
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([pluginId, config]) => {
    if (!isPiWebPluginId(pluginId)) throw new Error(`PI WEB project config plugin ids must match ${piWebPluginIdPattern.source}: ${path}`);
    if (!isRecord(config)) throw new Error(`PI WEB project config plugin entries must be objects: ${path}`);
    if (Object.hasOwn(config, "enabled")) {
      throw new Error(`PI WEB project config plugins.${pluginId}.enabled is not supported; plugin activation is global: ${path}`);
    }
    const settings = config["settings"];
    return [pluginId, Object.freeze(settings === undefined ? {} : {
      settings: snapshotPluginSettings(settings, `PI WEB project config plugins.${pluginId}.settings: ${path}`),
    })];
  })));
}

/** Validates only JSON shape; setting meanings belong to the owning plugin. */
export function snapshotPluginSettings(value: unknown, label: string): JsonObject {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a JSON object`);
  return snapshotJsonRecord(value, new Set<object>(), label);
}

function snapshotJsonRecord(value: Record<string, unknown>, ancestors: Set<object>, label: string): JsonObject {
  if (ancestors.has(value)) throw new Error(`${label} must not contain cycles`);
  ancestors.add(value);
  const output = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotJsonValue(item, ancestors, label)]));
  ancestors.delete(value);
  return Object.freeze(output);
}

function snapshotJsonValue(value: unknown, ancestors: Set<object>, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error(`${label} must not contain cycles`);
    ancestors.add(value);
    const output: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new Error(`${label} must not contain sparse arrays`);
      output[index] = snapshotJsonValue(value[index], ancestors, label);
    }
    ancestors.delete(value);
    return Object.freeze(output);
  }
  if (isPlainRecord(value)) return snapshotJsonRecord(value, ancestors, label);
  throw new Error(`${label} must contain only JSON values`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseProjectConfigVersion(value: unknown, path: string): 1 {
  if (value !== 1) throw new Error(`PI WEB project config version must be 1: ${path}`);
  return 1;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
