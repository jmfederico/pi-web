import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { effectiveAttachmentsConfig, effectiveUploadsConfig, parseAttachmentsConfig, parsePathAccessConfig, parseUploadsConfig, type PiWebConfig } from "../../config.js";
import type { PiWebAttachmentsConfig, PiWebPathAccessConfig, PiWebUploadsConfig } from "../../shared/apiTypes.js";

export const PROJECT_PI_WEB_CONFIG_PATH = ".pi-web/config.json";

export interface ProjectPiWebConfig {
  version?: 1;
  pathAccess?: PiWebPathAccessConfig;
  uploads?: PiWebUploadsConfig;
  attachments?: PiWebAttachmentsConfig;
}

export interface LoadedProjectPiWebConfig {
  path: string;
  exists: boolean;
  config: ProjectPiWebConfig;
}

export async function loadProjectPiWebConfig(projectPath: string): Promise<LoadedProjectPiWebConfig> {
  const path = join(projectPath, PROJECT_PI_WEB_CONFIG_PATH);
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) throw new Error(`PI WEB project config must be a JSON object: ${path}`);
    return { path, exists: true, config: parseProjectPiWebConfig(parsed, path) };
  } catch (error) {
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
  };
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
