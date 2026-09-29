import type { SessionDefaults, SessionDefaultsUpdate } from "./apiTypes.js";
import { isKnownThinkingLevel } from "./thinkingLevels.js";

/** Exactly one selector can be pinned per request; a model is always a pair. */
export function parseSessionDefaultsUpdate(value: Record<string, unknown>): SessionDefaultsUpdate {
  const { provider, modelId, thinkingLevel } = value;
  if (thinkingLevel !== undefined) {
    if (provider !== undefined || modelId !== undefined) throw new Error("Specify either provider/modelId or thinkingLevel");
    if (typeof thinkingLevel !== "string" || !isKnownThinkingLevel(thinkingLevel)) throw new Error("Invalid thinking level");
    return { thinkingLevel };
  }
  if (typeof provider !== "string" || provider.trim() === "" || typeof modelId !== "string" || modelId.trim() === "") {
    throw new Error("provider and modelId must both be non-empty strings");
  }
  return { provider, modelId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseSessionDefaults(value: unknown): SessionDefaults {
  if (!isRecord(value)) throw new Error("Invalid session defaults");
  const record = value;
  const result: SessionDefaults = {};
  for (const key of ["defaultProvider", "defaultModel"] as const) {
    const field = record[key];
    if (field === undefined) continue;
    if (typeof field !== "string") throw new Error(`Invalid ${key}`);
    result[key] = field;
  }
  const level = record["defaultThinkingLevel"];
  if (level !== undefined) {
    if (typeof level !== "string" || !isKnownThinkingLevel(level)) throw new Error("Invalid defaultThinkingLevel");
    result.defaultThinkingLevel = level;
  }
  return result;
}
