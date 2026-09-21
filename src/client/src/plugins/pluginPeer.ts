import type { JsonValue, Workspace } from "../api";
import {
  openPairedPluginBackendChannel,
  requestPairedPluginBackend,
  type PluginBackendChannel,
  type PluginBackendChannelOptions,
  type PluginBackendRequestOptions,
  type PluginBackendRequestTarget,
} from "../api/pluginBackends";
import type {
  PluginPeer,
  PluginPeerRequestOptions,
  WorkspacePluginBinding,
} from "./types";

export type PluginPeerRequester = (
  target: PluginBackendRequestTarget,
  operation: string,
  input: JsonValue,
  options?: PluginBackendRequestOptions,
) => Promise<JsonValue>;

export type PluginPeerChannelOpener = (
  target: PluginBackendRequestTarget,
  operation: string,
  input: JsonValue,
  options: PluginBackendChannelOptions,
) => Promise<PluginBackendChannel>;

/** Expose only the capabilities contributed by this exact revision-paired package. */
export function createPluginPeer(
  binding: WorkspacePluginBinding,
  workspace: Pick<Workspace, "id" | "projectId">,
  machineId: string,
  request: PluginPeerRequester = requestPairedPluginBackend,
  openChannel: PluginPeerChannelOpener = openPairedPluginBackendChannel,
): PluginPeer | undefined {
  if (binding.pairedRequestVersion !== 1 && binding.pairedChannelVersion !== 1) return undefined;
  const target = pluginBackendTarget(binding, workspace, machineId);
  if (target === undefined) return undefined;
  if (binding.pairedRequestVersion === 1 && binding.pairedChannelVersion === 1) {
    return {
      request: (operation: string, input: JsonValue, options?: PluginPeerRequestOptions) => request(target, operation, input, options),
      openChannel: (operation, input, options) => openChannel(target, operation, input, options),
    };
  }
  if (binding.pairedRequestVersion === 1) {
    return {
      request: (operation: string, input: JsonValue, options?: PluginPeerRequestOptions) => request(target, operation, input, options),
    };
  }
  if (binding.pairedChannelVersion === 1) {
    return {
      openChannel: (operation, input, options) => openChannel(target, operation, input, options),
    };
  }
  return undefined;
}

function pluginBackendTarget(
  binding: WorkspacePluginBinding,
  workspace: Pick<Workspace, "id" | "projectId">,
  machineId: string,
): PluginBackendRequestTarget | undefined {
  const backendRevision = binding.backendRevision;
  if (backendRevision === undefined) return undefined;
  return {
    pluginId: binding.sourcePluginId,
    backendRevision,
    machineId,
    projectId: workspace.projectId,
    workspaceId: workspace.id,
  };
}
