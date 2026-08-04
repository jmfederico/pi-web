import type { JsonValue } from "./apiTypes.js";

/** Maximum UTF-8 JSON input accepted from a browser plugin. */
export const PLUGIN_BACKEND_JSON_MAX_BYTES = 256 * 1024;
/** Bounded result allowance demonstrated by Git's existing 2 MiB command-output limit. */
export const PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES = 8 * 1024 * 1024;
/** Envelope allowance for the active backend revision and JSON field names. */
export const PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES = PLUGIN_BACKEND_JSON_MAX_BYTES + 4 * 1024;
/** Allowance for an attributed error envelope around a bounded result. */
export const PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES = PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES + 4 * 1024;
/** Bounded provider callback deadline inside sessiond. */
export const PLUGIN_BACKEND_REQUEST_TIMEOUT_MS = 10_000;
/** End-to-end sessiond deadline, including owner re-resolution and validation. */
export const PLUGIN_BACKEND_DISPATCH_TIMEOUT_MS = 25_000;
/** Remote gateway deadline, including workspace owner re-resolution. */
export const PLUGIN_BACKEND_FEDERATION_TIMEOUT_MS = 30_000;
export const PLUGIN_BACKEND_OPERATION_MAX_LENGTH = 128;
export const PLUGIN_BACKEND_REVISION_MAX_LENGTH = 512;

const OPERATION_PATTERN = /^[a-z][a-z0-9.-]*$/u;
const MAX_JSON_DEPTH = 64;

export interface PluginBackendRequestEnvelope {
  revision: string;
  input: JsonValue;
}

export function isPluginBackendOperation(value: string): boolean {
  return value.length <= PLUGIN_BACKEND_OPERATION_MAX_LENGTH && OPERATION_PATTERN.test(value);
}

export function requirePluginBackendOperation(value: string): string {
  if (!isPluginBackendOperation(value)) {
    throw new Error(`Plugin backend operation must match ${String(OPERATION_PATTERN)} and be at most ${String(PLUGIN_BACKEND_OPERATION_MAX_LENGTH)} characters`);
  }
  return value;
}

export function requirePluginBackendRevision(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.length > PLUGIN_BACKEND_REVISION_MAX_LENGTH) {
    throw new Error(`Plugin backend revision must be a non-empty string of at most ${String(PLUGIN_BACKEND_REVISION_MAX_LENGTH)} characters`);
  }
  return value;
}

/** Clone and freeze a runtime value after enforcing the JSON and byte contract. */
export function cloneBoundedPluginBackendJson(
  value: unknown,
  label: string,
  maxBytes = PLUGIN_BACKEND_JSON_MAX_BYTES,
): JsonValue {
  const cloned = cloneJsonValue(value, new Set<object>(), label, 0);
  const serialized = JSON.stringify(cloned);
  if (utf8ByteLength(serialized) > maxBytes) {
    throw new Error(`${label} exceeds the ${String(maxBytes)} byte limit`);
  }
  return cloned;
}

export function serializeBoundedPluginBackendJson(
  value: unknown,
  label: string,
  maxBytes = PLUGIN_BACKEND_JSON_MAX_BYTES,
): string {
  return JSON.stringify(cloneBoundedPluginBackendJson(value, label, maxBytes));
}

export function parseBoundedPluginBackendJson(
  text: string,
  label: string,
  maxBytes = PLUGIN_BACKEND_JSON_MAX_BYTES,
): JsonValue {
  if (utf8ByteLength(text) > maxBytes) {
    throw new Error(`${label} exceeds the ${String(maxBytes)} byte limit`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} must be valid JSON`, { cause: error });
  }
  return cloneBoundedPluginBackendJson(value, label, maxBytes);
}

export function parsePluginBackendRequestEnvelope(value: unknown): PluginBackendRequestEnvelope {
  if (!isPlainRecord(value)) throw new Error("Plugin backend request body must be an object");
  return Object.freeze({
    revision: requirePluginBackendRevision(value["revision"]),
    input: cloneBoundedPluginBackendJson(value["input"], "Plugin backend request input"),
  });
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function cloneJsonValue(value: unknown, ancestors: Set<object>, label: string, depth: number): JsonValue {
  if (depth > MAX_JSON_DEPTH) throw new Error(`${label} exceeds the maximum JSON depth of ${String(MAX_JSON_DEPTH)}`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error(`${label} must not contain cycles`);
    ancestors.add(value);
    const output = value.map((child) => cloneJsonValue(child, ancestors, label, depth + 1));
    ancestors.delete(value);
    Object.freeze(output);
    return output;
  }
  if (!isPlainRecord(value)) throw new Error(`${label} must contain only JSON values`);
  if (ancestors.has(value)) throw new Error(`${label} must not contain cycles`);
  ancestors.add(value);
  const output: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    defineJsonProperty(output, key, cloneJsonValue(child, ancestors, label, depth + 1));
  }
  ancestors.delete(value);
  return Object.freeze(output);
}

function defineJsonProperty(record: Record<string, JsonValue>, key: string, value: JsonValue): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
