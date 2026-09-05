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
/** End-to-end sessiond deadline, including workspace re-resolution and validation. */
export const PLUGIN_BACKEND_DISPATCH_TIMEOUT_MS = 25_000;
/** Remote gateway deadline, including authoritative workspace re-resolution. */
export const PLUGIN_BACKEND_FEDERATION_TIMEOUT_MS = 30_000;
export const PLUGIN_BACKEND_OPERATION_MAX_LENGTH = 128;
export const PLUGIN_BACKEND_REVISION_MAX_LENGTH = 512;

/** Host-envelope allowance around the existing bounded request-sized channel open input. */
export const PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES = PLUGIN_BACKEND_JSON_MAX_BYTES + 4 * 1024;
/** Maximum JSON payload carried by one channel data envelope. */
export const PLUGIN_BACKEND_CHANNEL_DATA_JSON_MAX_BYTES = 64 * 1024;
/** Host-envelope allowance around one bounded channel data payload. */
export const PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES = PLUGIN_BACKEND_CHANNEL_DATA_JSON_MAX_BYTES + 4 * 1024;
export const PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES = 128;
/** Browser-to-server aggregate queue bound at each host hop. */
export const PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_BYTES = 1024 * 1024;
/** Server-to-browser bound accommodates Terminal's full worst-case escaped replay plus live output. */
export const PLUGIN_BACKEND_CHANNEL_SERVER_TO_BROWSER_QUEUE_MAX_BYTES = 1_280 * 1024;
/** Independent aggregate edge cap and authoritative sessiond global cap. */
export const PLUGIN_BACKEND_CHANNEL_MAX_TOTAL = 128;
/** Authoritative sessiond per-plugin admission cap. */
export const PLUGIN_BACKEND_CHANNEL_MAX_PER_PLUGIN = 32;
/** Authoritative sessiond per-plugin/workspace admission cap. */
export const PLUGIN_BACKEND_CHANNEL_MAX_PER_PLUGIN_WORKSPACE = 8;
export const PLUGIN_BACKEND_CHANNEL_CALLBACK_TIMEOUT_MS = 10_000;
/**
 * Shared duration for independently owned edge transport-connect and sessiond
 * plugin-open deadlines. An upstream OPEN cancels only the edge deadline.
 */
export const PLUGIN_BACKEND_CHANNEL_OPEN_TIMEOUT_MS = 10_000;
/** Maximum time a clean close may wait for already-accepted socket frames or callbacks. */
export const PLUGIN_BACKEND_CHANNEL_DRAIN_TIMEOUT_MS = 10_000;
/** Hard deadline before a non-cooperating peer is physically terminated. */
export const PLUGIN_BACKEND_CHANNEL_TEARDOWN_TIMEOUT_MS = 1_000;
export const PLUGIN_BACKEND_CHANNEL_MAX_LIFETIME_MS = 12 * 60 * 60_000;
export const PLUGIN_BACKEND_CHANNEL_CLOSE_REASON_MAX_BYTES = 120;
export const PLUGIN_BACKEND_CHANNEL_ERROR_MESSAGE_MAX_BYTES = 2_048;
export const PLUGIN_BACKEND_CHANNEL_ERROR_CODE_MAX_LENGTH = 64;
export const PLUGIN_BACKEND_CHANNEL_ROUTE_PATH = "/plugin-backends/:pluginId/projects/:projectId/workspaces/:workspaceId/channels/:operation";

const OPERATION_PATTERN = /^[a-z][a-z0-9.-]*$/u;
const CHANNEL_ERROR_CODE_PATTERN = /^[a-z][a-z0-9.-]*$/u;
const MAX_JSON_DEPTH = 64;

export interface PluginBackendRequestEnvelope {
  revision: string;
  input: JsonValue;
}

export interface PluginBackendChannelOpenEnvelope {
  readonly version: 1;
  readonly kind: "open";
  readonly revision: string;
  readonly input: JsonValue;
}

export interface PluginBackendChannelReadyEnvelope {
  readonly version: 1;
  readonly kind: "ready";
}

export interface PluginBackendChannelDataEnvelope {
  readonly version: 1;
  readonly kind: "data";
  readonly data: JsonValue;
}

export interface PluginBackendChannelErrorEnvelope {
  readonly version: 1;
  readonly kind: "error";
  readonly code: string;
  readonly message: string;
}

export type PluginBackendChannelClientEnvelope = PluginBackendChannelOpenEnvelope | PluginBackendChannelDataEnvelope;
export type PluginBackendChannelServerEnvelope = PluginBackendChannelReadyEnvelope | PluginBackendChannelDataEnvelope | PluginBackendChannelErrorEnvelope;

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

export function serializePluginBackendChannelOpenEnvelope(revision: unknown, input: unknown): string {
  return serializePluginBackendChannelEnvelope({
    version: 1,
    kind: "open",
    revision: requirePluginBackendRevision(revision),
    input: cloneBoundedPluginBackendJson(input, "Plugin backend channel open input", PLUGIN_BACKEND_JSON_MAX_BYTES),
  }, "Plugin backend channel open envelope", PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES);
}

export function serializePluginBackendChannelReadyEnvelope(): string {
  return JSON.stringify({ version: 1, kind: "ready" });
}

export function serializePluginBackendChannelDataEnvelope(data: unknown): string {
  return serializePluginBackendChannelEnvelope({
    version: 1,
    kind: "data",
    data: cloneBoundedPluginBackendJson(data, "Plugin backend channel data", PLUGIN_BACKEND_CHANNEL_DATA_JSON_MAX_BYTES),
  }, "Plugin backend channel data envelope", PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES);
}

export function serializePluginBackendChannelErrorEnvelope(code: unknown, message: unknown): string {
  const parsedCode = requirePluginBackendChannelErrorCode(code);
  const parsedMessage = requirePluginBackendChannelErrorMessage(message);
  return serializePluginBackendChannelEnvelope({ version: 1, kind: "error", code: parsedCode, message: parsedMessage }, "Plugin backend channel error envelope", PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES);
}

export function parsePluginBackendChannelClientEnvelope(text: string): PluginBackendChannelClientEnvelope {
  const value = parseChannelEnvelopeRecord(text, "Plugin backend channel client frame");
  requireChannelEnvelopeVersion(value);
  if (value["kind"] === "open") {
    requireFrameByteLimit(text, PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES, "Plugin backend channel open frame");
    return Object.freeze({
      version: 1,
      kind: "open",
      revision: requirePluginBackendRevision(value["revision"]),
      input: cloneBoundedPluginBackendJson(value["input"], "Plugin backend channel open input", PLUGIN_BACKEND_JSON_MAX_BYTES),
    });
  }
  if (value["kind"] === "data") return parseChannelDataEnvelope(value, text);
  throw new Error("Plugin backend channel client frame kind is invalid");
}

export function parsePluginBackendChannelServerEnvelope(text: string): PluginBackendChannelServerEnvelope {
  const value = parseChannelEnvelopeRecord(text, "Plugin backend channel server frame");
  requireChannelEnvelopeVersion(value);
  if (value["kind"] === "ready") {
    requireFrameByteLimit(text, PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES, "Plugin backend channel ready frame");
    return Object.freeze({ version: 1, kind: "ready" });
  }
  if (value["kind"] === "data") return parseChannelDataEnvelope(value, text);
  if (value["kind"] === "error") {
    requireFrameByteLimit(text, PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES, "Plugin backend channel error frame");
    return Object.freeze({
      version: 1,
      kind: "error",
      code: requirePluginBackendChannelErrorCode(value["code"]),
      message: requirePluginBackendChannelErrorMessage(value["message"]),
    });
  }
  throw new Error("Plugin backend channel server frame kind is invalid");
}

export function requirePluginBackendChannelCloseReason(value: unknown): string {
  if (typeof value !== "string") throw new Error("Plugin backend channel close reason must be a string");
  if (utf8ByteLength(value) > PLUGIN_BACKEND_CHANNEL_CLOSE_REASON_MAX_BYTES) {
    throw new Error(`Plugin backend channel close reason exceeds the ${String(PLUGIN_BACKEND_CHANNEL_CLOSE_REASON_MAX_BYTES)} byte limit`);
  }
  return value;
}

export function boundedPluginBackendChannelCloseReason(value: unknown): string {
  const input = typeof value === "string" ? value : String(value);
  if (utf8ByteLength(input) <= PLUGIN_BACKEND_CHANNEL_CLOSE_REASON_MAX_BYTES) return input;
  let output = "";
  for (const character of input) {
    if (utf8ByteLength(`${output}${character}`) > PLUGIN_BACKEND_CHANNEL_CLOSE_REASON_MAX_BYTES) break;
    output += character;
  }
  return output;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function serializePluginBackendChannelEnvelope(value: JsonValue, label: string, maxBytes: number): string {
  const serialized = JSON.stringify(value);
  requireFrameByteLimit(serialized, maxBytes, label);
  return serialized;
}

function parseChannelEnvelopeRecord(text: string, label: string): Record<string, unknown> {
  requireFrameByteLimit(text, PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES, label);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} must be valid JSON`, { cause: error });
  }
  if (!isPlainRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function parseChannelDataEnvelope(value: Record<string, unknown>, text: string): PluginBackendChannelDataEnvelope {
  requireFrameByteLimit(text, PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES, "Plugin backend channel data frame");
  return Object.freeze({
    version: 1,
    kind: "data",
    data: cloneBoundedPluginBackendJson(value["data"], "Plugin backend channel data", PLUGIN_BACKEND_CHANNEL_DATA_JSON_MAX_BYTES),
  });
}

function requireChannelEnvelopeVersion(value: Record<string, unknown>): void {
  if (value["version"] !== 1) throw new Error("Plugin backend channel frame version is unsupported");
}

function requirePluginBackendChannelErrorCode(value: unknown): string {
  if (typeof value !== "string" || value.length > PLUGIN_BACKEND_CHANNEL_ERROR_CODE_MAX_LENGTH || !CHANNEL_ERROR_CODE_PATTERN.test(value)) {
    throw new Error("Plugin backend channel error code is invalid");
  }
  return value;
}

function requirePluginBackendChannelErrorMessage(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("Plugin backend channel error message must be a non-empty string");
  if (utf8ByteLength(value) > PLUGIN_BACKEND_CHANNEL_ERROR_MESSAGE_MAX_BYTES) {
    throw new Error(`Plugin backend channel error message exceeds the ${String(PLUGIN_BACKEND_CHANNEL_ERROR_MESSAGE_MAX_BYTES)} byte limit`);
  }
  return value;
}

function requireFrameByteLimit(text: string, maxBytes: number, label: string): void {
  if (utf8ByteLength(text) > maxBytes) throw new Error(`${label} exceeds the ${String(maxBytes)} byte limit`);
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
