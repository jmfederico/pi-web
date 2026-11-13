import type { JsonValue } from "./pluginApiTypes.js";
import { cloneBoundedJson } from "./boundedJson.js";

/** Private native custom entries, never public session metadata. */
export const SESSION_STATE_CUSTOM_TYPE = "pi-web.session-state";
/** Fork boundary: historical entries remain transcript history, not live child state. */
export const SESSION_STATE_RESET_CUSTOM_TYPE = "pi-web.session-state-reset";
export const SESSION_STATE_MAX_BYTES = 64 * 1024;

export interface SessionStateData {
  readonly version: 1;
  readonly namespace: string;
  readonly value: JsonValue;
  readonly inherit: boolean;
}

export interface SessionStateEntry extends SessionStateData {
  readonly revision: string;
}

export interface SessionStateSnapshot {
  /** Missing when the namespace has never been written since the latest reset. */
  readonly value?: JsonValue;
  /** Native entry id; the empty string means absent. */
  readonly revision: string;
}

export interface SessionStateWrite {
  readonly value: JsonValue;
  readonly inherit: boolean;
  /** Required optimistic revision returned by read; empty string creates an absent namespace. */
  readonly revision: string;
}

export function validateSessionStateNamespace(namespace: string): void {
  if (typeof namespace !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(namespace)) {
    throw new Error("Invalid session state namespace");
  }
}

/** Detached bounded JSON envelope. Namespaces organize data, not authorization. */
export function createSessionStateData(namespace: string, value: unknown, inherit: boolean): SessionStateData {
  validateSessionStateNamespace(namespace);
  if (typeof inherit !== "boolean") throw new Error("Session state inheritance must be boolean");
  const detached = cloneBoundedJson(value, "Session state", SESSION_STATE_MAX_BYTES);
  const data: SessionStateData = { version: 1, namespace, value: detached, inherit };
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > SESSION_STATE_MAX_BYTES) throw new Error("Session state exceeds the byte limit");
  return data;
}

/** Ignore unrelated entries; reject malformed recognized state rather than revive older values. */
export function parseSessionStateEntry(entry: unknown): SessionStateEntry | undefined {
  if (!isRecord(entry) || entry["type"] !== "custom" || entry["customType"] !== SESSION_STATE_CUSTOM_TYPE) return undefined;
  const data = entry["data"];
  if (typeof entry["id"] !== "string" || entry["id"] === "" || !isRecord(data) || data["version"] !== 1
    || typeof data["namespace"] !== "string" || typeof data["inherit"] !== "boolean") throw new Error("Invalid native session state entry");
  return { ...createSessionStateData(data["namespace"], data["value"], data["inherit"]), revision: entry["id"] };
}

/** Read entries in native append order (getEntries), not only the current branch. */
export function latestSessionStateEntries(entries: readonly unknown[]): SessionStateEntry[] {
  const latest = new Map<string, SessionStateEntry>();
  for (const entry of entries) {
    if (isRecord(entry) && entry["type"] === "custom" && entry["customType"] === SESSION_STATE_RESET_CUSTOM_TYPE) {
      if (typeof entry["id"] !== "string" || entry["id"] === "" || !isRecord(entry["data"]) || entry["data"]["version"] !== 1) {
        throw new Error("Invalid native session state reset entry");
      }
      latest.clear();
      continue;
    }
    const parsed = parseSessionStateEntry(entry);
    if (parsed !== undefined) latest.set(parsed.namespace, parsed);
  }
  return [...latest.values()];
}

export function readSessionState(entries: readonly unknown[], namespace: string): SessionStateSnapshot {
  validateSessionStateNamespace(namespace);
  const entry = latestSessionStateEntries(entries).find((entry) => entry.namespace === namespace);
  return entry === undefined ? { revision: "" } : { value: entry.value, revision: entry.revision };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
