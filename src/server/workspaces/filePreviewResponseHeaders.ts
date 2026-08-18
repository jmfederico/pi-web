import type { FastifyReply } from "fastify";
import { workspaceFilePreviewErrorResponsePolicy, type WorkspaceFilePreviewResponsePolicy } from "./filePreviewResponsePolicy.js";

/** Writes a preview response policy onto a reply, so local and proxied previews emit the identical contract. */
export function applyWorkspaceFilePreviewResponsePolicy(reply: FastifyReply, policy: WorkspaceFilePreviewResponsePolicy): FastifyReply {
  return reply
    .header("Content-Type", policy.contentType)
    .header("Content-Disposition", policy.contentDisposition)
    .header("Content-Security-Policy", policy.contentSecurityPolicy)
    .header("X-Content-Type-Options", policy.contentTypeOptions);
}

/**
 * Hardens a failed preview response. Preview URLs are navigated directly by the
 * browser, so an error body carrying attacker-influenced path text must never be
 * sniffable into active content, on either the local or the remote route.
 */
export function applyWorkspaceFilePreviewErrorResponsePolicy(reply: FastifyReply): FastifyReply {
  return applyWorkspaceFilePreviewResponsePolicy(reply, workspaceFilePreviewErrorResponsePolicy());
}
