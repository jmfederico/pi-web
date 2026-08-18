import type { ActiveAgentProfileDescriptor } from "./apiTypes.js";

export const ACTIVE_AGENT_PROFILE_SCHEMA_VERSION = 2 as const;

const ACTIVE_AGENT_PROFILE_FIELDS = new Set([
  "schemaVersion",
  "dir",
]);

export function parseActiveAgentProfileDescriptor(value: unknown): ActiveAgentProfileDescriptor | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !ACTIVE_AGENT_PROFILE_FIELDS.has(key))) return undefined;

  const schemaVersion = value["schemaVersion"];
  const dir = value["dir"];
  if (schemaVersion !== ACTIVE_AGENT_PROFILE_SCHEMA_VERSION) return undefined;
  if (typeof dir !== "string" || !isPortableAbsolutePath(dir)) return undefined;

  return Object.freeze({
    schemaVersion: ACTIVE_AGENT_PROFILE_SCHEMA_VERSION,
    dir,
  });
}

function isPortableAbsolutePath(value: string): boolean {
  if (value === "" || value !== value.trim() || hasControlCharacter(value)) return false;
  const withForwardSlashes = value.replace(/\\/g, "/");
  return withForwardSlashes.startsWith("/") || /^[A-Za-z]:\//u.test(withForwardSlashes);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
