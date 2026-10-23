import type { JsonObject, JsonValue, SessionUiMetadata } from "../../shared/pluginApiTypes.js";
import { cloneBoundedPluginBackendJson } from "../../shared/pluginBackendProtocol.js";

/** Only this explicitly public entry type is projected to the browser. */
export const SESSION_UI_METADATA_CUSTOM_TYPE = "pi-web.session-ui-metadata";
export const SESSION_UI_METADATA_MAX_BYTES = 16 * 1024;
const NAMESPACE_PATTERN = /^[a-zA-Z0-9@][a-zA-Z0-9._:/@-]{0,127}$/u;

/** Validate and detach public metadata before any session creation or durable write. */
export function requireSessionUiMetadata(value: unknown): SessionUiMetadata {
  // Reuse the host's JSON snapshot boundary: rejects cycles, non-finite numbers,
  // non-JSON values and excessive depth, and safely copies arbitrary object keys.
  const cloned = cloneBoundedPluginBackendJson(value, "Session UI metadata", SESSION_UI_METADATA_MAX_BYTES);
  if (!isJsonObject(cloned)) throw new Error("Session UI metadata must be a namespaced object");
  const metadata: Record<string, JsonObject> = {};
  for (const [namespace, data] of Object.entries(cloned)) {
    if (!NAMESPACE_PATTERN.test(namespace)) throw new Error(`Invalid session UI metadata namespace: ${namespace}`);
    if (!isJsonObject(data)) throw new Error(`Session UI metadata namespace ${namespace} must contain an object`);
    Object.defineProperty(metadata, namespace, { value: data, enumerable: true });
  }
  return Object.freeze(metadata);
}

/** Malformed/unknown-version persisted entries never expose arbitrary custom data. */
export function sessionUiMetadataFromEntry(entry: unknown): SessionUiMetadata | undefined {
  if (!isObject(entry) || entry["type"] !== "custom" || entry["customType"] !== SESSION_UI_METADATA_CUSTOM_TYPE) return undefined;
  const data = entry["data"];
  if (!isObject(data) || data["version"] !== 1) return undefined;
  try {
    return requireSessionUiMetadata(data["metadata"]);
  } catch {
    // Corrupt session-file entries are skipped, like the other listing readers.
    return undefined;
  }
}

/** Session-level state, not branch-relative: the latest valid snapshot wins. */
export function readSessionUiMetadata(entries: readonly unknown[]): SessionUiMetadata | undefined {
  let metadata: SessionUiMetadata | undefined;
  for (const entry of entries) metadata = sessionUiMetadataFromEntry(entry) ?? metadata;
  return metadata;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return isObject(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
