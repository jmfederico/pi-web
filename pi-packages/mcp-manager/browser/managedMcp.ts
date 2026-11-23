import type { PluginBackend, PluginPeer } from "@jmfederico/pi-web/plugin-api";
import type { ManagedMcpServerView, ManagedMcpUpdate, ManagedMcpView } from "../shared.js";

export type ManagedMcpPanelContext = { machineId: string; sessionId?: string } & (
  | { projectId: string; workspaceId: string; cwd: string }
  | { projectId?: never; workspaceId?: never; cwd?: never }
);

function peer(backend: PluginBackend | undefined, context: ManagedMcpPanelContext): PluginPeer & { request: NonNullable<PluginPeer["request"]> } {
  if (backend?.machineId !== context.machineId) throw new Error("MCP backend unavailable on this machine");
  const scoped = backend.forScope(context.workspaceId === undefined ? { kind: "machine" }
    : { kind: "workspace", projectId: context.projectId, workspaceId: context.workspaceId });
  if (scoped.request === undefined) throw new Error("MCP backend requests unavailable");
  return scoped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected MCP object");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected MCP string");
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Expected MCP boolean");
  return value;
}
function server(value: unknown): ManagedMcpServerView {
  const row = record(value);
  const enabled = record(row["enabled"]);
  const definitionScope = row["definitionScope"];
  if (definitionScope !== "global" && definitionScope !== "project") throw new Error("Invalid MCP definition scope");
  return {
    name: text(row["name"]), definitionScope,
    enabled: {
      global: bool(enabled["global"]),
      ...(enabled["project"] === undefined ? {} : { project: bool(enabled["project"]) }),
      ...(enabled["session"] === undefined ? {} : { session: bool(enabled["session"]) }),
    },
    effectiveEnabled: bool(row["effectiveEnabled"]),
    ...(row["description"] === undefined ? {} : { description: text(row["description"]) }),
    ...(row["pending"] === undefined ? {} : { pending: bool(row["pending"]) }),
    ...(row["error"] === undefined ? {} : { error: text(row["error"]) }),
    ...(row["nativeConflict"] === undefined ? {} : { nativeConflict: bool(row["nativeConflict"]) }),
  };
}

/** Decode only the safe view contract, never pass through connection definitions. */
export function parseManagedMcpView(value: unknown): ManagedMcpView {
  const data = record(value);
  if (!Array.isArray(data["servers"]) || !Array.isArray(data["issues"])) throw new Error("Expected MCP lists");
  return {
    globalConfigPath: text(data["globalConfigPath"]),
    ...(data["projectConfigPath"] === undefined ? {} : { projectConfigPath: text(data["projectConfigPath"]) }),
    projectTrusted: bool(data["projectTrusted"]),
    globalWritable: bool(data["globalWritable"]),
    projectWritable: bool(data["projectWritable"]),
    sessionWritable: bool(data["sessionWritable"]),
    servers: data["servers"].map(server),
    issues: data["issues"].map(text),
    revision: text(data["revision"]),
  };
}

export const managedMcpApi = {
  get: async (backend: PluginBackend | undefined, context: ManagedMcpPanelContext, signal: AbortSignal): Promise<ManagedMcpView> =>
    parseManagedMcpView(await peer(backend, context).request("view", context.sessionId === undefined ? {} : { sessionId: context.sessionId }, { signal })),
  update: async (backend: PluginBackend | undefined, context: ManagedMcpPanelContext, update: Omit<ManagedMcpUpdate, "cwd" | "sessionId">, signal: AbortSignal): Promise<ManagedMcpView> =>
    parseManagedMcpView(await peer(backend, context).request("update", {
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      scope: update.scope, serverName: update.serverName, enabled: update.enabled, revision: update.revision,
    }, { signal })),
};
