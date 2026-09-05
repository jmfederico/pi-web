import type { JsonValue, Workspace } from "../api";
import {
  openPluginBackendChannel,
  requestPluginBackend,
  type PluginBackendChannel,
  type PluginBackendChannelOptions,
  type PluginBackendRequestOptions,
  type PluginBackendRequestTarget,
} from "../api/pluginBackends";
import type { WorkspaceBackend, WorkspaceBackendRequestOptions, WorkspacePluginBinding } from "./types";

export type PluginBackendRequester = (
  target: PluginBackendRequestTarget,
  operation: string,
  input: JsonValue,
  options?: PluginBackendRequestOptions,
) => Promise<JsonValue>;

export type PluginBackendChannelOpener = (
  target: PluginBackendRequestTarget,
  operation: string,
  input: JsonValue,
  options: PluginBackendChannelOptions,
) => Promise<PluginBackendChannel>;

export function createPluginWorkspaceBackend(
  binding: WorkspacePluginBinding,
  workspace: Pick<Workspace, "id" | "projectId">,
  machineId: string,
  request: PluginBackendRequester = requestPluginBackend,
  openChannel: PluginBackendChannelOpener = openPluginBackendChannel,
): WorkspaceBackend | undefined {
  const backendRevision = binding.backendRevision;
  if (backendRevision === undefined) return undefined;
  return {
    ...(binding.backendCapabilityVersion === undefined ? {} : { capabilityVersion: binding.backendCapabilityVersion }),
    ...(binding.channelVersion === undefined ? {} : {
      channelVersion: binding.channelVersion,
      openChannel: (operation, input, options) => openChannel({
        pluginId: binding.sourcePluginId,
        backendRevision,
        machineId,
        projectId: workspace.projectId,
        workspaceId: workspace.id,
      }, operation, input, options),
    }),
    request: (operation, input, options?: WorkspaceBackendRequestOptions) => request({
      pluginId: binding.sourcePluginId,
      backendRevision,
      machineId,
      projectId: workspace.projectId,
      workspaceId: workspace.id,
    }, operation, input, options),
  };
}
