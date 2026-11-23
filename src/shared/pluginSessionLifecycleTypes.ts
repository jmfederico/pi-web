import type { PluginCapability } from "./pluginApiTypes.js";
import type { PluginSessionSelection } from "./pluginCatalogTypes.js";

export interface PluginSessionLifecycleOptions {
  readonly signal?: AbortSignal;
}

export interface PluginSessionLifecycleState {
  readonly sessionId: string;
  /** True if any retained workspace pin protects this identity from cleanup. */
  readonly pinned: boolean;
  readonly archived: boolean;
}

/** Explicit, machine-local operations. Pins protect cleanup, not deliberate lifecycle commands. */
export interface PluginSessionLifecycleV1 {
  readonly version: 1;
  readonly get: (selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions) => Promise<PluginSessionLifecycleState>;
  readonly pin: (selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions) => Promise<void>;
  /** Remove the target workspace's pin; pins in other scopes remain in effect. */
  readonly unpin: (selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions) => Promise<void>;
  readonly archive: (selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions) => Promise<void>;
  readonly restore: (selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions) => Promise<void>;
  /** Permanent deletion; the target must already be archived and have no active work. */
  readonly delete: (selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions) => Promise<void>;
}

/** Explicit runtime control in addition to the existing saved-session lifecycle. */
export interface PluginSessionLifecycleV2 extends Omit<PluginSessionLifecycleV1, "version"> {
  readonly version: 2;
  /** Interrupt current work and clear queued prompts without closing the runtime.
   * Does not open saved sessions, cancel pending startup, stop descendants, or prevent later wake-ups.
   */
  readonly abort: (selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions) => Promise<void>;
  /** Stop work and dispose the runtime, discarding hosted-only unused sessions.
   * Saved conversations remain discoverable; this does not archive/delete them, stop descendants, or prevent reopening.
   */
  readonly close: (selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions) => Promise<void>;
}

export const PI_WEB_HOST_SESSION_LIFECYCLE_V2_CAPABILITY: PluginCapability<PluginSessionLifecycleV2, 2> = Object.freeze({
  pluginId: "pi-web.host",
  id: "session-lifecycle",
  version: 2,
  parse: snapshotLifecycleV2,
});

export const PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY: PluginCapability<PluginSessionLifecycleV1, 1> = Object.freeze({
  pluginId: "pi-web.host",
  id: "session-lifecycle",
  version: 1,
  parse: snapshotLifecycle,
});

function snapshotLifecycle(value: unknown): PluginSessionLifecycleV1 {
  return Object.freeze({ version: 1, ...snapshotLifecycleMethods(requireVersion(value, 1)) });
}

function snapshotLifecycleV2(value: unknown): PluginSessionLifecycleV2 {
  const owner = requireVersion(value, 2);
  return Object.freeze({ version: 2, ...snapshotLifecycleMethods(owner), abort: mutation(owner, "abort"), close: mutation(owner, "close") });
}

function requireVersion(value: unknown, version: 1 | 2): object {
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== version) throw invalid();
  return value;
}

function method(owner: object, name: Exclude<keyof PluginSessionLifecycleV2, "version">) {
  const fn: unknown = Reflect.get(owner, name);
  if (typeof fn !== "function") throw invalid();
  return async (selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions): Promise<unknown> => {
    const result: unknown = Reflect.apply(fn, owner, [snapshotSelection(selection), options]);
    return await Promise.resolve(result);
  };
}

function mutation(owner: object, name: Exclude<keyof PluginSessionLifecycleV2, "version" | "get">) {
  const invoke = method(owner, name);
  return async (selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions): Promise<void> => { await invoke(selection, options); };
}

function snapshotLifecycleMethods(owner: object): Omit<PluginSessionLifecycleV1, "version"> {
  const get = method(owner, "get");
  return {
    get: async (selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions) => {
      const requested = snapshotSelection(selection);
      const result = await get(requested, options);
      if (typeof result !== "object" || result === null || !("sessionId" in result) || result.sessionId !== requested.sessionId
        || !("pinned" in result) || typeof result.pinned !== "boolean" || !("archived" in result) || typeof result.archived !== "boolean") throw invalid();
      return Object.freeze({ sessionId: requested.sessionId, pinned: result.pinned, archived: result.archived });
    },
    pin: mutation(owner, "pin"),
    unpin: mutation(owner, "unpin"),
    archive: mutation(owner, "archive"),
    restore: mutation(owner, "restore"),
    delete: mutation(owner, "delete"),
  };
}

function snapshotSelection(value: unknown): PluginSessionSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const keys = ["projectId", "workspaceId", "sessionId"] as const;
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.some((allowed) => key === allowed))) throw invalid();
  const text = (key: typeof keys[number]): string => {
    const field: unknown = Reflect.get(value, key);
    if (typeof field !== "string" || field.trim() === "" || field.length > 512) throw invalid();
    return field;
  };
  return Object.freeze({ projectId: text("projectId"), workspaceId: text("workspaceId"), sessionId: text("sessionId") });
}

function invalid(): Error { return new Error("Invalid PI WEB host session lifecycle capability data"); }
