import { randomUUID } from "node:crypto";
import type { PiWebHostPiSessionEventsV1, PluginSessionSelection } from "@jmfederico/pi-web/server-plugin-api";
import { MCP_MANAGER_REQUEST, MCP_MANAGER_RESPONSE, type McpManagerRequest } from "./shared.js";

/** Safe runtime intent only; never transports definitions or authentication data. */
export interface McpRuntimeView {
  projectTrusted: boolean;
  pending: boolean;
  servers: { name: string; pending: boolean }[];
  errors: { name?: string; message: string }[];
}

export async function requestMcpRuntime(
  events: PiWebHostPiSessionEventsV1,
  selection: PluginSessionSelection,
  action: "view" | "refresh",
  signal: AbortSignal,
): Promise<McpRuntimeView> {
  signal.throwIfAborted();
  const connection = await events.connect(selection);
  const timeout = AbortSignal.timeout(3000);
  const lifetime = AbortSignal.any([signal, connection.signal, timeout]);
  let cleanup: (() => void) | undefined;
  try {
    lifetime.throwIfAborted();
    return await new Promise<McpRuntimeView>((resolve, reject) => {
      const id = randomUUID();
      const abort = () => { reject(new Error("MCP loader did not respond. Reload Pi resources in this session and try again.")); };
      lifetime.addEventListener("abort", abort, { once: true });
      const unsubscribe = connection.on(MCP_MANAGER_RESPONSE, (response) => {
        if (!record(response) || response["id"] !== id) return;
        try { resolve(parseRuntimeView(response)); } catch (error) { reject(error instanceof Error ? error : new Error("Invalid MCP loader response")); }
      });
      cleanup = () => { unsubscribe(); lifetime.removeEventListener("abort", abort); };
      // Subscribe before sending: a companion may respond synchronously.
      try { connection.emit(MCP_MANAGER_REQUEST, { id, action } satisfies McpManagerRequest); } catch (error) { reject(error instanceof Error ? error : new Error("Could not contact MCP loader")); }
    });
  } finally {
    cleanup?.();
    connection.close();
  }
}

function parseRuntimeView(response: Record<string, unknown>): McpRuntimeView {
  const state = response["state"];
  if (!record(state) || typeof response["projectTrusted"] !== "boolean" || typeof state["pending"] !== "boolean"
    || !Array.isArray(state["servers"]) || !Array.isArray(state["errors"])) throw new Error("Invalid MCP loader response. Reload Pi resources and try again.");
  return {
    projectTrusted: response["projectTrusted"], pending: state["pending"],
    servers: state["servers"].map((row: unknown) => {
      if (!record(row) || typeof row["name"] !== "string" || typeof row["pending"] !== "boolean") throw new Error("Invalid MCP loader server state");
      return { name: row["name"], pending: row["pending"] };
    }),
    errors: state["errors"].map((row: unknown) => {
      if (!record(row) || typeof row["message"] !== "string" || (row["name"] !== undefined && typeof row["name"] !== "string")) throw new Error("Invalid MCP loader error state");
      return { message: row["message"], ...(row["name"] === undefined ? {} : { name: row["name"] }) };
    }),
  };
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
