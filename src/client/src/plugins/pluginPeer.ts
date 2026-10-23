import type { JsonValue, Workspace } from "../api";
import type { PluginBackend, PluginBackendScope } from "../../../plugin-api";
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

/** Fixed machine and package revision; callback selection cannot retarget retained peers. */
export function createPluginBackend(
  binding: WorkspacePluginBinding,
  machineId: string,
  lifetimeSignal?: AbortSignal,
  request: PluginPeerRequester = requestPairedPluginBackend,
  openChannel: PluginPeerChannelOpener = openPairedPluginBackendChannel,
): PluginBackend | undefined {
  if (binding.backendRevision === undefined || (binding.pairedRequestVersion !== 1 && binding.pairedChannelVersion !== 1)) return undefined;
  const backendRevision = binding.backendRevision;
  const signalFor = (signal?: AbortSignal) => lifetimeSignal === undefined ? signal
    : signal === undefined ? lifetimeSignal : AbortSignal.any([lifetimeSignal, signal]);
  return Object.freeze({
    machineId,
    forScope(scope: PluginBackendScope): PluginPeer {
      lifetimeSignal?.throwIfAborted();
      if (scope.kind !== "machine" && (typeof scope.projectId !== "string" || scope.projectId === "")) throw new Error("Project id is required");
      if (scope.kind === "workspace" && (typeof scope.workspaceId !== "string" || scope.workspaceId === "")) throw new Error("Workspace id is required");
      const target: PluginBackendRequestTarget = Object.freeze({
        pluginId: binding.sourcePluginId,
        backendRevision,
        machineId,
        scope: scope.kind,
        ...(scope.kind === "machine" ? {} : { projectId: scope.projectId }),
        ...(scope.kind === "workspace" ? { workspaceId: scope.workspaceId } : {}),
      });
      const requester = (operation: string, input: JsonValue, options?: PluginPeerRequestOptions) => {
        const signal = signalFor(options?.signal);
        signal?.throwIfAborted();
        return request(target, operation, input, { ...(signal === undefined ? {} : { signal }) });
      };
      const opener: NonNullable<PluginPeer["openChannel"]> = (operation, input, options) => {
        const signal = signalFor(options.signal);
        signal?.throwIfAborted();
        return openChannel(target, operation, input, { ...options, ...(signal === undefined ? {} : { signal }) });
      };
      if (binding.pairedRequestVersion === 1) return Object.freeze({ request: requester, ...(binding.pairedChannelVersion === 1 ? { openChannel: opener } : {}) });
      return Object.freeze({ openChannel: opener });
    },
  });
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
