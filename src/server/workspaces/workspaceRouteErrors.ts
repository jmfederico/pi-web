import type { FastifyReply } from "fastify";
import { workspaceCatalogHttpStatus } from "./workspaceCatalog.js";

export function sendWorkspaceRequestError(
  reply: FastifyReply,
  error: unknown,
  fallbackStatus: number,
): FastifyReply {
  return reply.code(workspaceCatalogHttpStatus(error, fallbackStatus)).send({
    error: error instanceof Error ? error.message : String(error),
  });
}
