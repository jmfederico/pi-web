import type { FastifyInstance } from "fastify";
import type { ManagedMcpContext, ManagedMcpUpdate, ManagedMcpView } from "../../shared/managedMcp.js";
import { normalizeRequestCwd } from "../workingDirectory.js";

interface ManagedMcpRouteService {
  managedMcpView(context: ManagedMcpContext): Promise<ManagedMcpView>;
  updateManagedMcp(input: ManagedMcpUpdate): Promise<ManagedMcpView>;
}

export function registerManagedMcpRoutes(app: FastifyInstance, sessions: ManagedMcpRouteService, prefix = ""): void {
  app.get<{ Querystring: unknown }>(`${prefix}/mcp/managed`, async (request, reply) => {
    try {
      const query = object(request.query);
      onlyKeys(query, ["cwd", "sessionId"]);
      return await sessions.managedMcpView(context(query));
    } catch (error) { return reply.code(400).send({ error: message(error) }); }
  });
  app.post<{ Body: unknown }>(`${prefix}/mcp/managed`, async (request, reply) => {
    try {
      const body = object(request.body);
      onlyKeys(body, ["cwd", "sessionId", "scope", "serverName", "enabled", "revision"]);
      const scope = body["scope"];
      if (scope !== "global" && scope !== "project" && scope !== "session") throw new Error("Invalid MCP scope");
      if (typeof body["enabled"] !== "boolean") throw new Error("MCP enabled must be a boolean");
      const serverName = string(body, "serverName");
      if (!/^[a-zA-Z0-9_-]+$/.test(serverName)) throw new Error("Invalid MCP server name");
      return await sessions.updateManagedMcp({
        ...context(body), scope, serverName, enabled: body["enabled"], revision: string(body, "revision"),
      });
    } catch (error) { return reply.code(400).send({ error: message(error) }); }
  });
}

function context(value: Record<string, unknown>): ManagedMcpContext {
  const cwd = value["cwd"] === undefined ? undefined : normalizeRequestCwd(string(value, "cwd"));
  const sessionId = value["sessionId"] === undefined ? undefined : string(value, "sessionId");
  if (sessionId !== undefined && cwd === undefined) throw new Error("Session MCP settings require a workspace");
  return { ...(cwd === undefined ? {} : { cwd }), ...(sessionId === undefined ? {} : { sessionId }) };
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an MCP request object");
  return Object.fromEntries(Object.entries(value));
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Unexpected MCP field");
}
function string(value: Record<string, unknown>, key: string): string {
  const text = value[key];
  if (typeof text !== "string" || text.trim() === "" || text.length > 32768) throw new Error(`${key} must be a nonempty string`);
  return text;
}
function message(error: unknown): string { return error instanceof Error ? error.message : "MCP operation failed"; }
