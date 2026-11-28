import type { JsonObject } from "@jmfederico/pi-web/server-plugin-api";

export interface WatchSettings {
  /** `gh`-compatible executable; an absolute path selects a wrapper such as an App identity. */
  readonly ghCommand: string;
  readonly pollIntervalMs: number;
  readonly quietMs: number;
  readonly maxHoldMs: number;
  /** Reviewer logins whose activity wakes sessions. */
  readonly authors: readonly string[];
  readonly maxWakesPerHour: number;
  readonly maxAgeMs: number;
}

const KEYS = ["ghCommand", "pollIntervalSeconds", "quietSeconds", "maxHoldMinutes", "authors", "maxWakesPerHour", "maxAgeDays"];

/** Parses `plugins.pr-watch.settings`; invalid values fail activation rather than fall back silently. */
export function parseSettings(settings: JsonObject): WatchSettings {
  const unknown = Object.keys(settings).filter((key) => !KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown pr-watch settings: ${unknown.join(", ")}`);
  const ghCommand = settings["ghCommand"] ?? "gh";
  if (typeof ghCommand !== "string" || ghCommand.trim() === "") throw new Error("pr-watch ghCommand must be a non-empty string");
  const authors = settings["authors"] ?? ["coderabbitai[bot]"];
  if (!Array.isArray(authors) || authors.length === 0 || !authors.every((author) => typeof author === "string" && author !== "")) {
    throw new Error("pr-watch authors must be a non-empty array of GitHub logins");
  }
  return {
    ghCommand,
    authors: authors.filter((author) => typeof author === "string"),
    pollIntervalMs: integer(settings, "pollIntervalSeconds", 60, 15, 3600) * 1000,
    quietMs: integer(settings, "quietSeconds", 60, 0, 3600) * 1000,
    maxHoldMs: integer(settings, "maxHoldMinutes", 30, 1, 1440) * 60_000,
    maxWakesPerHour: integer(settings, "maxWakesPerHour", 12, 1, 120),
    maxAgeMs: integer(settings, "maxAgeDays", 14, 1, 365) * 86_400_000,
  };
}

function integer(settings: JsonObject, key: string, fallback: number, min: number, max: number): number {
  const value = settings[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`pr-watch ${key} must be an integer from ${String(min)} to ${String(max)}`);
  }
  return value;
}
