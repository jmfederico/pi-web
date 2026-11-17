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
export declare const PI_WEB_HOST_SESSION_LIFECYCLE_V2_CAPABILITY: PluginCapability<PluginSessionLifecycleV2, 2>;
export declare const PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY: PluginCapability<PluginSessionLifecycleV1, 1>;
