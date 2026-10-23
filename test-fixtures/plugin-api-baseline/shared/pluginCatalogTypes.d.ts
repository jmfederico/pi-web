import type { PluginCapability, SessionUiMetadata, WorkspaceProviderMetadata, WorkspaceRemovalPresentation } from "./pluginApiTypes.js";
export interface PluginCatalogProject {
    readonly id: string;
    readonly name: string;
    readonly path: string;
}
export interface PluginCatalogWorkspace {
    readonly id: string;
    readonly projectId: string;
    readonly path: string;
    readonly label: string;
    readonly isMain: boolean;
    readonly provider?: WorkspaceProviderMetadata;
    readonly removal?: WorkspaceRemovalPresentation;
}
export interface PluginSessionSnapshot {
    readonly id: string;
    readonly cwd: string;
    readonly name?: string;
    readonly metadata?: SessionUiMetadata;
    readonly archived: boolean;
    readonly runtime: "not-hosted" | "idle" | "busy";
}
export interface PluginWorkspaceSelection {
    readonly projectId: string;
    readonly workspaceId: string;
}
export interface PluginSessionSelection extends PluginWorkspaceSelection {
    readonly sessionId: string;
}
export interface PluginCatalogReadOptions {
    readonly signal?: AbortSignal;
}
export interface PluginCatalogV1 {
    readonly version: 1;
    readonly projects: {
        readonly list: (options?: PluginCatalogReadOptions) => Promise<readonly PluginCatalogProject[]>;
        readonly get: (projectId: string, options?: PluginCatalogReadOptions) => Promise<PluginCatalogProject>;
    };
    readonly workspaces: {
        readonly list: (projectId: string, options?: PluginCatalogReadOptions) => Promise<readonly PluginCatalogWorkspace[]>;
        readonly get: (selection: PluginWorkspaceSelection, options?: PluginCatalogReadOptions) => Promise<PluginCatalogWorkspace>;
    };
    readonly sessions: {
        readonly list: (selection: PluginWorkspaceSelection, options?: PluginCatalogReadOptions) => Promise<readonly PluginSessionSnapshot[]>;
        readonly get: (selection: PluginSessionSelection, options?: PluginCatalogReadOptions) => Promise<PluginSessionSnapshot>;
    };
}
export declare const PI_WEB_HOST_CATALOG_CAPABILITY: PluginCapability<PluginCatalogV1, 1>;
