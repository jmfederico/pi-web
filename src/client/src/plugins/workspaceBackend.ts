import type { JsonValue, Workspace } from "../api";
import {
  requestPluginBackend,
  requestPluginBackendBinary,
  type PluginBackendRequestTarget,
} from "../api/pluginBackends";
import type { WorkspaceBackend, WorkspacePluginBinding } from "./types";

export type PluginBackendRequester = (
  target: PluginBackendRequestTarget,
  operation: string,
  input: JsonValue,
) => Promise<JsonValue>;

export type PluginBackendBinaryRequester = (
  target: PluginBackendRequestTarget,
  operation: string,
  body: Uint8Array,
) => Promise<JsonValue>;

export function createPluginWorkspaceBackend(
  binding: WorkspacePluginBinding,
  workspace: Pick<Workspace, "id" | "projectId">,
  machineId: string,
  request: PluginBackendRequester = requestPluginBackend,
  requestBinary: PluginBackendBinaryRequester = requestPluginBackendBinary,
): WorkspaceBackend | undefined {
  const backendRevision = binding.backendRevision;
  if (backendRevision === undefined) return undefined;
  const target: PluginBackendRequestTarget = {
    pluginId: binding.sourcePluginId,
    backendRevision,
    machineId,
    projectId: workspace.projectId,
    workspaceId: workspace.id,
  };
  return {
    request: (operation, input) => request(target, operation, input),
    requestBinary: (operation, body) => requestBinary(target, operation, body),
  };
}
