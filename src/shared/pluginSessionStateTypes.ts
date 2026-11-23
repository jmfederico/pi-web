import type { PluginCapability } from "./pluginApiTypes.js";
import type { PluginSessionSelection } from "./pluginCatalogTypes.js";
import { createSessionStateData, validateSessionStateNamespace, type SessionStateSnapshot, type SessionStateWrite } from "./sessionState.js";
import { cloneBoundedJson } from "./boundedJson.js";
import { SESSION_STATE_MAX_BYTES } from "./sessionState.js";

export interface PluginSessionStateOptions {
  readonly signal?: AbortSignal;
}

/** Machine-local private state. Reads host saved sessions; no browser metadata or implicit broadcast. */
export interface PluginSessionStateV1 {
  readonly version: 1;
  readonly read: (selection: PluginSessionSelection, namespace: string, options?: PluginSessionStateOptions) => Promise<SessionStateSnapshot>;
  /** Archived sessions reject writes; stale revisions reject with code SESSION_STATE_CONFLICT. */
  readonly write: (selection: PluginSessionSelection, namespace: string, input: SessionStateWrite, options?: PluginSessionStateOptions) => Promise<SessionStateSnapshot>;
}

export const PI_WEB_HOST_SESSION_STATE_CAPABILITY: PluginCapability<PluginSessionStateV1, 1> = Object.freeze({
  pluginId: "pi-web.host", id: "session-state", version: 1, parse: snapshotCapability,
});

function snapshotCapability(value: unknown): PluginSessionStateV1 {
  if (typeof value !== "object" || value === null || Reflect.get(value, "version") !== 1) throw invalid();
  const read: unknown = Reflect.get(value, "read");
  const write: unknown = Reflect.get(value, "write");
  if (typeof read !== "function" || typeof write !== "function") throw invalid();
  return Object.freeze({
    version: 1,
    read: async (selection: PluginSessionSelection, namespace: string, options?: PluginSessionStateOptions) => {
      validateSessionStateNamespace(namespace);
      const result: unknown = await Reflect.apply(read, value, [snapshotSessionStateSelection(selection), namespace, options]);
      return snapshotResult(result);
    },
    write: async (selection: PluginSessionSelection, namespace: string, input: SessionStateWrite, options?: PluginSessionStateOptions) => {
      const data = createSessionStateData(namespace, input.value, input.inherit);
      if (typeof input.revision !== "string" || input.revision.length > 512) throw invalid();
      const result: unknown = await Reflect.apply(write, value, [snapshotSessionStateSelection(selection), namespace, { value: data.value, inherit: data.inherit, revision: input.revision }, options]);
      return snapshotResult(result);
    },
  });
}

function snapshotSessionStateSelection(value: unknown): PluginSessionSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const keys = ["projectId", "workspaceId", "sessionId"] as const;
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.some((allowed) => allowed === key))) throw invalid();
  const field = (key: typeof keys[number]): string => {
    const text: unknown = Reflect.get(value, key);
    if (typeof text !== "string" || text.trim() === "" || text.length > 512) throw invalid();
    return text;
  };
  return Object.freeze({ projectId: field("projectId"), workspaceId: field("workspaceId"), sessionId: field("sessionId") });
}

function snapshotResult(value: unknown): SessionStateSnapshot {
  if (typeof value !== "object" || value === null) throw invalid();
  const revision: unknown = Reflect.get(value, "revision");
  if (typeof revision !== "string" || revision.length > 512) throw invalid();
  if (!Object.hasOwn(value, "value")) {
    if (revision !== "") throw invalid();
    return Object.freeze({ revision });
  }
  if (revision === "") throw invalid();
  return Object.freeze({ revision, value: cloneBoundedJson(Reflect.get(value, "value"), "Session state", SESSION_STATE_MAX_BYTES) });
}

function invalid(): Error { return new Error("Invalid PI WEB host session state capability v1 data"); }
