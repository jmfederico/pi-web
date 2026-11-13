import type { PluginCapability } from "./pluginApiTypes.js";
import type { PluginWorkspaceSelection } from "./pluginCatalogTypes.js";
/** Explicit saved/default Pi project trust, without auto-trusting resource-free workspaces. */
export interface PluginProjectTrustV1 {
    readonly version: 1;
    readonly get: (selection: PluginWorkspaceSelection) => Promise<boolean>;
}
export declare const PI_WEB_HOST_PROJECT_TRUST_CAPABILITY: PluginCapability<PluginProjectTrustV1, 1>;
