import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface SessionNamingConfig {
  model?: string;
  maxTokens?: number;
  thinkingLevel?: ThinkingLevel;
  timeoutMs?: number;
}

export interface ResolvedSessionNamingConfig extends SessionNamingConfig {
  maxTokens: number;
  thinkingLevel: ThinkingLevel;
  timeoutMs: number;
}

// Compiled extensions must not resolve a second copy of the Pi SDK just to
// locate configuration. Pi exposes this profile directory through its public env contract.
export function sessionNamingAgentDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env["PI_CODING_AGENT_DIR"];
  if (configured === undefined || configured === "") return join(home, ".pi", "agent");
  if (configured === "~") return home;
  if (configured.startsWith("~/") || configured.startsWith("~\\")) return join(home, configured.slice(2));
  return configured;
}

export function sessionNamingConfigPath(agentDir: string): string {
  return join(agentDir, "session-naming", "config.json");
}

/** Shared by the extension and hosts migrating previously stored tuning. */
export function parseSessionNamingConfig(value: unknown): SessionNamingConfig {
  if (!isRecord(value)) {
    throw new Error("Session naming config must be an object");
  }
  const record = value;
  for (const key of Object.keys(record)) {
    if (!["model", "maxTokens", "thinkingLevel", "timeoutMs"].includes(key)) {
      throw new Error(`Unknown session naming config field: ${key}`);
    }
  }
  const { model, maxTokens, thinkingLevel, timeoutMs } = record;
  if (model !== undefined && (typeof model !== "string" || !/^[^/\s]+\/\S+$/.test(model))) {
    throw new Error("Session naming model must be an exact provider/model-id");
  }
  if (maxTokens !== undefined && (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 1)) {
    throw new Error("Session naming maxTokens must be a positive safe integer");
  }
  if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) {
    throw new Error("Session naming thinkingLevel must be a known thinking level");
  }
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)) {
    throw new Error("Session naming timeoutMs must be an integer from 1 to 2147483647");
  }
  return {
    ...(model !== undefined ? { model } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

/** Environment tuning overrides file tuning field by field; neither supports a toggle. */
export function resolveSessionNamingConfig(fileConfig: unknown = {}, overrideConfig: unknown = {}): ResolvedSessionNamingConfig {
  return {
    maxTokens: 24,
    thinkingLevel: "minimal",
    timeoutMs: 10_000,
    ...parseSessionNamingConfig(fileConfig),
    ...parseSessionNamingConfig(overrideConfig),
  };
}

export async function loadSessionNamingConfig(agentDir: string, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedSessionNamingConfig> {
  let file: unknown = {};
  try {
    file = JSON.parse(await readFile(sessionNamingConfigPath(agentDir), "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const override: unknown = env["PI_WEB_SESSION_NAMING"] === undefined ? {} : JSON.parse(env["PI_WEB_SESSION_NAMING"]);
  return resolveSessionNamingConfig(file, override);
}
