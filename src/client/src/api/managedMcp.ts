import type { ManagedMcpContext, ManagedMcpServerView, ManagedMcpUpdate, ManagedMcpView } from "../../../shared/managedMcp";
import { machinePrefix } from "./clients";
import { request } from "./http";

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
  get: (context: ManagedMcpContext, machineId = "local"): Promise<ManagedMcpView> => {
    const query = new URLSearchParams();
    if (context.cwd !== undefined) query.set("cwd", context.cwd);
    if (context.sessionId !== undefined) query.set("sessionId", context.sessionId);
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return request(`${machinePrefix(machineId)}/mcp/managed${suffix}`, parseManagedMcpView, { cache: "no-store" });
  },
  update: (update: ManagedMcpUpdate, machineId = "local"): Promise<ManagedMcpView> =>
    request(`${machinePrefix(machineId)}/mcp/managed`, parseManagedMcpView, { method: "POST", body: JSON.stringify(update) }),
};
