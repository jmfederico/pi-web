import type { FastifyInstance } from "fastify";
import type { McpAuthServersResponse, OAuthFlowState, SessionRef } from "../../shared/apiTypes.js";
import { normalizeRequestCwd } from "../workingDirectory.js";
import type { McpAuthFlowService } from "./mcpAuthFlowService.js";

interface McpAuthRouteService {
  mcpAuthServers(ref: SessionRef): Promise<McpAuthServersResponse>;
  startMcpAuth(ref: SessionRef, mode: "login" | "logout", serverName?: string): Promise<OAuthFlowState>;
  mcpAuthFlows: Pick<McpAuthFlowService, "get" | "respond" | "cancel">;
}

export function registerMcpAuthRoutes(app: FastifyInstance, sessions: McpAuthRouteService, prefix = ""): void {
  app.get<{ Params: { sessionId: string }; Querystring: unknown }>(`${prefix}/sessions/:sessionId/mcp/auth/servers`, async (request, reply) => {
    try {
      const query = record(request.query);
      onlyKeys(query, ["cwd"]);
      const cwd = string(query, "cwd");
      if (!cwd) throw new Error("cwd must not be empty");
      return await sessions.mcpAuthServers({ id: request.params.sessionId, cwd: normalizeRequestCwd(cwd) });
    } catch (error) { return reply.code(400).send({ error: message(error) }); }
  });
  app.post<{ Params: { sessionId: string }; Body: unknown }>(`${prefix}/sessions/:sessionId/mcp/auth`, async (request, reply) => {
    try {
      const body = record(request.body);
      onlyKeys(body, ["cwd", "mode", "serverName"]);
      const cwd = string(body, "cwd");
      if (!cwd) throw new Error("cwd must not be empty");
      const mode = body["mode"];
      if (mode !== "login" && mode !== "logout") throw new Error("mode must be login or logout");
      const serverName = body["serverName"] === undefined ? undefined : string(body, "serverName");
      return await sessions.startMcpAuth({ id: request.params.sessionId, cwd: normalizeRequestCwd(cwd) }, mode, serverName);
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    }
  });
  app.get<{ Params: { flowId: string } }>(`${prefix}/auth/mcp/:flowId`, (request, reply) => {
    try { return sessions.mcpAuthFlows.get(request.params.flowId); }
    catch (error) { return reply.code(404).send({ error: message(error) }); }
  });
  app.post<{ Params: { flowId: string }; Body: unknown }>(`${prefix}/auth/mcp/:flowId/respond`, (request, reply) => {
    try {
      const body = record(request.body);
      onlyKeys(body, ["requestId", "value"]);
      return sessions.mcpAuthFlows.respond(request.params.flowId, string(body, "requestId"), string(body, "value"));
    } catch (error) { return reply.code(400).send({ error: message(error) }); }
  });
  app.post<{ Params: { flowId: string } }>(`${prefix}/auth/mcp/:flowId/cancel`, (request, reply) => {
    try { return sessions.mcpAuthFlows.cancel(request.params.flowId); }
    catch (error) { return reply.code(400).send({ error: message(error) }); }
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a request object");
  return Object.fromEntries(Object.entries(value));
}
function string(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length > 32 * 1024) throw new Error(`${key} must be a string of at most 32768 characters`);
  return value;
}
function onlyKeys(body: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(body).some((key) => !keys.includes(key))) throw new Error("Unexpected MCP authentication field");
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
