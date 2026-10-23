import { isRecord } from "./sessionFileFormat.js";

export interface PersistedParentSubsessionLink {
  spawnedBySessionId: string;
  spawnedSessionId: string;
  spawnedSessionFile?: string;
  cwd?: string;
}

export interface PersistedChildSubsessionLink {
  spawnedBySessionId: string;
  spawnedSessionId: string;
}

export function parsePersistedChildSubsessionLink(entry: unknown): PersistedChildSubsessionLink | undefined {
  return parseLink(entry, "pi-web.subsession.spawned");
}

export function parsePersistedParentSubsessionLink(entry: unknown): PersistedParentSubsessionLink | undefined {
  const link = parseLink(entry, "pi-web.subsession.link");
  if (link === undefined || !isRecord(entry) || !isRecord(entry["data"])) return undefined;
  const spawnedSessionFile = nonEmptyString(entry["data"]["spawnedSessionFile"]);
  const cwd = nonEmptyString(entry["data"]["cwd"]);
  return {
    ...link,
    ...(spawnedSessionFile === undefined ? {} : { spawnedSessionFile }),
    ...(cwd === undefined ? {} : { cwd }),
  };
}

function parseLink(entry: unknown, customType: string): PersistedChildSubsessionLink | undefined {
  if (!isRecord(entry) || entry["type"] !== "custom" || entry["customType"] !== customType || !isRecord(entry["data"])) return undefined;
  const spawnedBySessionId = nonEmptyString(entry["data"]["spawnedBySessionId"]);
  const spawnedSessionId = nonEmptyString(entry["data"]["spawnedSessionId"]);
  return spawnedBySessionId === undefined || spawnedSessionId === undefined ? undefined : { spawnedBySessionId, spawnedSessionId };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
