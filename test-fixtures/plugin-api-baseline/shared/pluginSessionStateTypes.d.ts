import type { PluginCapability } from "./pluginApiTypes.js";
import type { PluginSessionSelection } from "./pluginCatalogTypes.js";
import { type SessionStateSnapshot, type SessionStateWrite } from "./sessionState.js";
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
export declare const PI_WEB_HOST_SESSION_STATE_CAPABILITY: PluginCapability<PluginSessionStateV1, 1>;
