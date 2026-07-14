import type { ActiveAgentProfileDescriptor } from "./apiTypes.js";

export const ACTIVE_AGENT_PROFILE_SCHEMA_VERSION = 1 as const;

export function isPiCompanionCommand(command: string): boolean {
  const name = command.split(/[\\/]/u).at(-1)?.toLowerCase() ?? command.toLowerCase();
  return name.replace(/(?:\.[cm]?js|\.exe|\.cmd)$/iu, "") === "pi";
}

export function usesPiCodingAgentStateCompatibility(command: string): boolean {
  return !command.includes("/") && !command.includes("\\") && isPiCompanionCommand(command);
}

const ACTIVE_AGENT_PROFILE_FIELDS = new Set([
  "schemaVersion",
  "revision",
  "command",
  "dir",
  "sessionDirEnvKeys",
]);
const SHA256_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SAFE_BARE_AGENT_COMMAND_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/u;
const ACTIVE_SESSION_DIR_ENV_KEYS = new Set(["PI_WEB_AGENT_SESSION_DIR", "PI_CODING_AGENT_SESSION_DIR"]);

export function parseActiveAgentProfileDescriptor(value: unknown): ActiveAgentProfileDescriptor | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !ACTIVE_AGENT_PROFILE_FIELDS.has(key))) return undefined;

  const schemaVersion = value["schemaVersion"];
  const revision = value["revision"];
  const command = value["command"];
  const dir = value["dir"];
  const sessionDirEnvKeys = value["sessionDirEnvKeys"];
  if (schemaVersion !== ACTIVE_AGENT_PROFILE_SCHEMA_VERSION) return undefined;
  if (typeof revision !== "string" || !SHA256_REVISION_PATTERN.test(revision)) return undefined;
  if (typeof command !== "string" || !isPortableAgentCommand(command)) return undefined;
  if (typeof dir !== "string" || !isPortableAbsolutePath(dir)) return undefined;
  if (!isNonEmptyStringArray(sessionDirEnvKeys)) return undefined;
  if (new Set(sessionDirEnvKeys).size !== sessionDirEnvKeys.length) return undefined;
  if (sessionDirEnvKeys[0] !== "PI_WEB_AGENT_SESSION_DIR" || sessionDirEnvKeys.some((key) => !ACTIVE_SESSION_DIR_ENV_KEYS.has(key))) return undefined;

  return Object.freeze({
    schemaVersion,
    revision,
    command,
    dir,
    sessionDirEnvKeys: Object.freeze([...sessionDirEnvKeys]),
  });
}

function isPortableAgentCommand(value: string): boolean {
  if (value !== value.trim() || /[\s;&|`$<>]/u.test(value)) return false;
  if (isPortableAbsolutePath(value)) return !value.endsWith("/") && !value.endsWith("\\");
  return SAFE_BARE_AGENT_COMMAND_PATTERN.test(value);
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

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string" && entry !== "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
