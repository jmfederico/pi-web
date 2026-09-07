import type { JsonValue, Workspace } from "../api";
import {
  openPairedPluginBackendChannel,
  requestPairedPluginBackend,
  requestPluginBackend,
  type PluginBackendChannel,
  type PluginBackendChannelOptions,
  type PluginBackendRequestOptions,
  type PluginBackendRequestTarget,
} from "../api/pluginBackends";
import type {
  PairedWorkspaceBackendRequestOptions,
  PairedWorkspaceBackendV1,
  WorkspaceBackend,
  WorkspacePluginBinding,
} from "./types";

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

/** Preserve the browser-v2 owner-backed helper independently of paired contributions. */
export function createPluginWorkspaceBackend(
  binding: WorkspacePluginBinding,
  workspace: Pick<Workspace, "id" | "projectId" | "provider">,
  machineId: string,
  request: PluginBackendRequester = requestPluginBackend,
): WorkspaceBackend | undefined {
  const provider = workspace.provider;
  if (provider?.pluginId !== binding.sourcePluginId || !provider.capabilities.request) return undefined;
  const target = pluginBackendTarget(binding, workspace, machineId);
  if (target === undefined) return undefined;
  return {
    request: (operation, input) => request(target, operation, input),
  };
}

/** Expose only the capabilities contributed by this exact revision-paired package. */
export function createPairedPluginWorkspaceBackend(
  binding: WorkspacePluginBinding,
  workspace: Pick<Workspace, "id" | "projectId">,
  machineId: string,
  request: PluginBackendRequester = requestPairedPluginBackend,
  openChannel: PluginBackendChannelOpener = openPairedPluginBackendChannel,
): PairedWorkspaceBackendV1 | undefined {
  if (binding.pairedRequestVersion !== 1 && binding.pairedChannelVersion !== 1) return undefined;
  const target = pluginBackendTarget(binding, workspace, machineId);
  if (target === undefined) return undefined;
  if (binding.pairedRequestVersion === 1 && binding.pairedChannelVersion === 1) {
    return {
      version: 1,
      requestVersion: 1,
      channelVersion: 1,
      request: (operation: string, input: JsonValue, options?: PairedWorkspaceBackendRequestOptions) => request(target, operation, input, options),
      openChannel: (operation, input, options) => openChannel(target, operation, input, options),
    };
  }
  if (binding.pairedRequestVersion === 1) {
    return {
      version: 1,
      requestVersion: 1,
      request: (operation: string, input: JsonValue, options?: PairedWorkspaceBackendRequestOptions) => request(target, operation, input, options),
    };
  }
  if (binding.pairedChannelVersion === 1) {
    return {
      version: 1,
      channelVersion: 1,
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
