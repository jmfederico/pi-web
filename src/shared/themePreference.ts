import type { PiWebThemePreference } from "./apiTypes.js";

const qualifiedThemeIdPattern = /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/u;

/** Parse data only: theme availability is resolved after browser plugins load. */
export function parseThemePreference(value: unknown): PiWebThemePreference | undefined {
  if (!isRecord(value)) return undefined;
  const record = value;
  const themeId = record["themeId"];
  const auto = record["auto"];
  if (typeof themeId !== "string" || !qualifiedThemeIdPattern.test(themeId) || typeof auto !== "boolean") return undefined;
  return { themeId, auto };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireDefaultThemePreference(value: unknown, source: string): PiWebThemePreference {
  const preference = parseThemePreference(value);
  if (preference === undefined) {
    throw new Error(`PI WEB config defaultTheme must contain a qualified themeId and a boolean auto: ${source}`);
  }
  return preference;
}
