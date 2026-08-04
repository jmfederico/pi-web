import type { FastifyInstance, FastifyReply } from "fastify";
import {
  parseWorkspaceRemovalRequest,
  WORKSPACE_REMOVAL_REQUEST_BODY_MAX_BYTES,
} from "../../shared/workspaceRemovalProtocol.js";
import { SessionDaemonClient } from "../../sessiond/sessionDaemonClient.js";
import { requestCancellation } from "../requestCancellation.js";
import type { SessionProxyDaemon } from "../sessiond/sessionProxyRoutes.js";

/** Browser-facing adapter; sessiond owns all workspace removal decisions and effects. */
export function registerWorkspaceDeletionRoutes(
  app: FastifyInstance,
  daemon: SessionProxyDaemon = new SessionDaemonClient(),
  prefix = "/api",
): void {
  app.delete<{ Params: { projectId: string; workspaceId: string }; Body: unknown }>(
    `${prefix}/projects/:projectId/workspaces/:workspaceId`,
    { bodyLimit: WORKSPACE_REMOVAL_REQUEST_BODY_MAX_BYTES },
    async (request, reply) => {
      let body: ReturnType<typeof parseWorkspaceRemovalRequest>;
      try {
        body = parseWorkspaceRemovalRequest(request.body);
      } catch (error) {
        return reply.code(400).send({ error: errorMessage(error) });
      }

      const cancellation = requestCancellation(request, reply);
      try {
        const upstream = await daemon.request(
          "DELETE",
          `/workspace-removals/projects/${encodeURIComponent(request.params.projectId)}/workspaces/${encodeURIComponent(request.params.workspaceId)}`,
          body,
          { signal: cancellation.signal },
        );
        return await proxyJsonResponse(reply, upstream);
      } catch (error) {
        return await reply.code(502).send({
          error: `Session daemon unavailable: ${errorMessage(error)}`,
        });
      } finally {
        cancellation.dispose();
      }
    },
  );
}

function proxyJsonResponse(
  reply: FastifyReply,
  upstream: { statusCode: number; headers: Record<string, string>; body: string },
): unknown {
  reply.code(upstream.statusCode);
  const contentType = upstream.headers["content-type"];
  if (contentType !== undefined && contentType !== "") reply.header("content-type", contentType);
  if (upstream.body === "") return undefined;
  try {
    const value: unknown = JSON.parse(upstream.body);
    return value;
  } catch (error) {
    return reply.code(502).send({
      error: `Invalid session daemon workspace removal response: ${errorMessage(error)}`,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
