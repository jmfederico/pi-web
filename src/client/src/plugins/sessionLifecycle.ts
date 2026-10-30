import type { PluginSessionLifecycle } from "../../../plugin-api";
import type { PluginSessionSelection } from "../../../shared/pluginCatalogTypes";
import { PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY, type PluginSessionLifecycleOptions } from "../../../shared/pluginSessionLifecycleTypes";
import { request } from "../api/http";

export type PluginSessionLifecycleRequester = (path: string, options?: RequestInit) => Promise<unknown>;

/** Retained operations capture their machine and never follow browser selection. */
export function createPluginSessionLifecycle(
  machineId: string,
  lifetimeSignal?: AbortSignal,
  requester: PluginSessionLifecycleRequester = (path, options) => request(path, (value) => value, options),
): PluginSessionLifecycle {
  if (machineId === "") throw new Error("Session lifecycle machine id is required");
  const prefix = `api/machines/${encodeURIComponent(machineId)}/plugin-sessions/projects`;
  const sessionPath = ({ projectId, workspaceId, sessionId }: PluginSessionSelection) =>
    `${prefix}/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`;
  const invoke = async (path: string, method: string, options?: PluginSessionLifecycleOptions): Promise<unknown> => {
    const signal = lifetimeSignal === undefined ? options?.signal
      : options?.signal === undefined ? lifetimeSignal : AbortSignal.any([lifetimeSignal, options.signal]);
    signal?.throwIfAborted();
    const result = await requester(path, { method, cache: "no-store", ...(signal === undefined ? {} : { signal }) });
    signal?.throwIfAborted();
    return result;
  };
  const lifecycle = PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY.parse({
    version: 1,
    get: (selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions) => invoke(sessionPath(selection), "GET", options),
    pin: (selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions) => invoke(`${sessionPath(selection)}/pin`, "POST", options),
    unpin: (selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions) => invoke(`${sessionPath(selection)}/unpin`, "POST", options),
    archive: (selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions) => invoke(`${sessionPath(selection)}/archive`, "POST", options),
    restore: (selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions) => invoke(`${sessionPath(selection)}/restore`, "POST", options),
    delete: (selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions) => invoke(sessionPath(selection), "DELETE", options),
  });
  return Object.freeze({ ...lifecycle, machineId });
}
