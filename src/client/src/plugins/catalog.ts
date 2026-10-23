import type { PluginCatalog } from "../../../plugin-api";
import { PI_WEB_HOST_CATALOG_CAPABILITY, type PluginCatalogReadOptions, type PluginSessionSelection, type PluginWorkspaceSelection } from "../../../shared/pluginCatalogTypes";
import { request } from "../api/http";

export type PluginCatalogRequester = (path: string, options?: RequestInit) => Promise<unknown>;

/** Each callback captures its machine; retained reads never follow browser selection. */
export function createPluginCatalog(
  machineId: string,
  lifetimeSignal?: AbortSignal,
  requester: PluginCatalogRequester = (path, options) => request(path, (value) => value, options),
): PluginCatalog {
  if (machineId === "") throw new Error("Catalog machine id is required");
  const prefix = `api/machines/${encodeURIComponent(machineId)}/plugin-catalog/projects`;
  const projectPath = (projectId: string) => `${prefix}/${encodeURIComponent(projectId)}`;
  const workspacePath = ({ projectId, workspaceId }: PluginWorkspaceSelection) => `${projectPath(projectId)}/workspaces/${encodeURIComponent(workspaceId)}`;
  const read = async (path: string, options?: PluginCatalogReadOptions): Promise<unknown> => {
    const signal = lifetimeSignal === undefined ? options?.signal
      : options?.signal === undefined ? lifetimeSignal : AbortSignal.any([lifetimeSignal, options.signal]);
    signal?.throwIfAborted();
    const result = await requester(path, { cache: "no-store", ...(signal === undefined ? {} : { signal }) });
    signal?.throwIfAborted();
    return result;
  };
  const catalog = PI_WEB_HOST_CATALOG_CAPABILITY.parse({
    version: 1,
    projects: {
      list: (options?: PluginCatalogReadOptions) => read(prefix, options),
      get: (projectId: string, options?: PluginCatalogReadOptions) => read(projectPath(projectId), options),
    },
    workspaces: {
      list: (projectId: string, options?: PluginCatalogReadOptions) => read(`${projectPath(projectId)}/workspaces`, options),
      get: (selection: PluginWorkspaceSelection, options?: PluginCatalogReadOptions) => read(workspacePath(selection), options),
    },
    sessions: {
      list: (selection: PluginWorkspaceSelection, options?: PluginCatalogReadOptions) => read(`${workspacePath(selection)}/sessions`, options),
      get: (selection: PluginSessionSelection, options?: PluginCatalogReadOptions) => read(`${workspacePath(selection)}/sessions/${encodeURIComponent(selection.sessionId)}`, options),
    },
  });
  return Object.freeze({ ...catalog, machineId });
}
