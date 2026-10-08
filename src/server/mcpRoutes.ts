import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import type { McpCheckResponse, McpConfigScope } from "../shared/apiTypes.js";
import { McpConfigError, validateMcpServerName, type McpConfigService } from "./mcpConfigService.js";
import { requestCancellation } from "./requestCancellation.js";

/** The daemon supplies its checker and its managed-workspace cwd resolver. */
export interface McpRouteDependencies {
  check(cwd?: string, signal?: AbortSignal): Promise<McpCheckResponse>;
  resolveWorkspace(projectId: string, workspaceId: string): Promise<string>;
}

interface WorkspaceParams {
  projectId: string;
  workspaceId: string;
}

export function registerMcpRoutes(
  app: FastifyInstance,
  service: McpConfigService,
  dependencies: McpRouteDependencies,
  prefix = "",
): void {
  const base = prefix.replace(/\/+$/u, "");
  registerScope(`${base}/mcp`, false);
  registerScope(`${base}/projects/:projectId/workspaces/:workspaceId/mcp`, true);

  function resolveCwd(params: WorkspaceParams, workspace: boolean): Promise<string | undefined> {
    return workspace
      ? dependencies.resolveWorkspace(params.projectId, params.workspaceId)
      : Promise.resolve(undefined);
  }

  function registerScope(route: string, workspace: boolean): void {
    app.get<{ Params: WorkspaceParams; Querystring: unknown }>(route, async (request, reply) => {
      try {
        requireEmptyQuery(request.query);
        return await service.list(await resolveCwd(request.params, workspace));
      } catch (error) {
        return sendError(reply, error, request.log);
      }
    });

    app.put<{ Params: WorkspaceParams & { name: string }; Body: unknown; Querystring: unknown }>(`${route}/servers/:name`, async (request, reply) => {
      try {
        requireEmptyQuery(request.query);
        const { scope, enabled } = parseToggle(request.body, workspace);
        validateMcpServerName(request.params.name);
        return await service.setEnabled(request.params.name, scope, enabled, await resolveCwd(request.params, workspace));
      } catch (error) {
        return sendError(reply, error, request.log);
      }
    });

    app.post<{ Params: WorkspaceParams; Body: unknown; Querystring: unknown }>(`${route}/check`, async (request, reply) => {
      const cancellation = requestCancellation(request, reply);
      try {
        requireEmptyQuery(request.query);
        if (request.body !== undefined && (!isRecord(request.body) || Object.keys(request.body).length > 0)) {
          throw new McpConfigError("MCP check does not accept body fields", 400);
        }
        const cwd = await resolveCwd(request.params, workspace);
        return await dependencies.check(cwd, cancellation.signal);
      } catch (error) {
        return await sendError(reply, error, request.log);
      } finally {
        cancellation.dispose();
      }
    });
  }
}

function parseToggle(body: unknown, workspace: boolean): { scope: McpConfigScope; enabled: boolean } {
  if (!isRecord(body)) throw new McpConfigError("MCP toggle body must be an object", 400);
  const allowed = workspace ? ["scope", "enabled"] : ["enabled"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new McpConfigError("MCP toggle contains unsupported fields", 400);
  const enabled = body["enabled"];
  if (typeof enabled !== "boolean") throw new McpConfigError("enabled must be a boolean", 400);
  const scope = workspace ? body["scope"] : "user";
  if (scope !== "user" && scope !== "project") throw new McpConfigError("MCP scope must be user or project", 400);
  return { scope, enabled };
}

function requireEmptyQuery(query: unknown): void {
  if (!isRecord(query) || Object.keys(query).length > 0) throw new McpConfigError("MCP routes do not accept query parameters", 400);
}

function sendError(reply: FastifyReply, error: unknown, logger: FastifyBaseLogger): FastifyReply {
  if (error instanceof McpConfigError) {
    if (error.statusCode === 500) logger.error({ err: error }, "MCP configuration operation failed");
    return reply.code(error.statusCode).send({ error: error.message });
  }
  if (error instanceof Error && (error.message === "Project not found" || error.message === "Workspace not found")) {
    return reply.code(404).send({ error: error.message });
  }
  // Checker/process errors can contain URLs, tokens or raw config. Only errors
  // explicitly sanitized at the MCP boundary may be sent back verbatim.
  logger.error({ err: error }, "MCP operation failed");
  return reply.code(500).send({ error: "MCP operation failed. Run pi mcp list on this machine for detailed diagnostics." });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
