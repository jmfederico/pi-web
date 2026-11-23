import type { JsonValue } from "./pluginApiTypes.js";

const MAX_JSON_DEPTH = 64;

/** Shared JSON value boundary, independent of transport envelopes and host state. */
export function cloneBoundedJson(value: unknown, label: string, maxBytes: number): JsonValue {
  const cloned = cloneJsonValue(value, new Set<object>(), label, 0);
  if (utf8ByteLength(JSON.stringify(cloned)) > maxBytes) throw new Error(`${label} exceeds the ${String(maxBytes)} byte limit`);
  return cloned;
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
    return Object.freeze(output);
  }
  if (!isPlainRecord(value)) throw new Error(`${label} must contain only JSON values`);
  if (ancestors.has(value)) throw new Error(`${label} must not contain cycles`);
  ancestors.add(value);
  const output: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(output, key, { value: cloneJsonValue(child, ancestors, label, depth + 1), enumerable: true, configurable: true, writable: true });
  }
  ancestors.delete(value);
  return Object.freeze(output);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
