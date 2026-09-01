import type { FastifyInstance } from "fastify";
import {
  parseWorkspaceCreationRequest,
  WORKSPACE_CREATION_REQUEST_BODY_MAX_BYTES,
} from "../../shared/workspaceCreation.js";
import { SessionDaemonClient } from "../../sessiond/sessionDaemonClient.js";
import { requestCancellation } from "../requestCancellation.js";
import type { SessionProxyDaemon } from "../sessiond/sessionProxyRoutes.js";
import { proxyJsonResponse } from "./workspaceDeletionRoutes.js";

/** Browser-facing adapter; sessiond owns all workspace creation decisions and effects. */
export function registerWorkspaceCreationRoutes(
  app: FastifyInstance,
  daemon: SessionProxyDaemon = new SessionDaemonClient(),
  prefix = "/api",
): void {
  app.post<{ Params: { projectId: string }; Body: unknown }>(
    `${prefix}/projects/:projectId/workspaces`,
    { bodyLimit: WORKSPACE_CREATION_REQUEST_BODY_MAX_BYTES },
    async (request, reply) => {
      let body: ReturnType<typeof parseWorkspaceCreationRequest>;
      try {
        body = parseWorkspaceCreationRequest(request.body);
      } catch (error) {
        return reply.code(400).send({ error: errorMessage(error) });
      }

      const cancellation = requestCancellation(request, reply);
      try {
        const upstream = await daemon.request(
          "POST",
          `/workspace-creations/projects/${encodeURIComponent(request.params.projectId)}`,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
