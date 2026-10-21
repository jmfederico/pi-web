import type { PluginCapability } from "./pluginApiTypes.js";
import type { PluginCatalogReadOptions, PluginSessionSelection } from "./pluginCatalogTypes.js";
export interface PluginSessionHistoryPageRequest {
    readonly before?: number;
    readonly limit?: number;
    readonly allowPartialTurn?: boolean;
}
export interface PluginSessionHistoryPage {
    readonly messages: readonly unknown[];
    readonly start: number;
    readonly total: number;
}
export interface PluginSessionHistoryV1 {
    readonly version: 1;
    /** Bounded observational transcript read. The host never opens a cold runtime. */
    readonly readMessages: (selection: PluginSessionSelection, page?: PluginSessionHistoryPageRequest, options?: PluginCatalogReadOptions) => Promise<PluginSessionHistoryPage>;
}
export declare const PI_WEB_HOST_PI_SESSION_HISTORY_CAPABILITY: PluginCapability<PluginSessionHistoryV1, 1>;
