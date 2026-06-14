import type { FastifyInstance } from "fastify";
import type { ProjectService } from "./projects/projectService.js";
import type { WorkspaceService } from "./workspaces/workspaceService.js";
import type { WriteWorkspaceFileOptions } from "../shared/apiTypes.js";
import { resolveWorkspaceContext } from "./workspaces/workspaceContext.js";
import { listWorkspaceTree } from "./workspaces/fileTreeService.js";
import { deleteWorkspaceFile, moveWorkspaceFile, readWorkspaceFile, writeWorkspaceFile } from "./workspaces/fileContentService.js";
import { readWorkspaceImagePreview } from "./workspaces/imagePreviewService.js";

export function registerWorkspaceExplorerRoutes(app: FastifyInstance, projects: ProjectService, workspaces: WorkspaceService, prefix = "/api"): void {
  // Register content type parsers for workspace file writes.
  // Fastify's default parser only handles application/json.
  // Guard against re-registration since this function may be called multiple times.
  try { app.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => { done(null, Buffer.from(body)); }); } catch { /* already registered */ }
  try { app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => { done(null, body); }); } catch { /* already registered */ }
  try { app.addContentTypeParser(/^([a-z]+\/[a-z0-9.+-]+)$/, { parseAs: "buffer" }, (_req, body, done) => { done(null, body); }); } catch { /* already registered */ }
  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/tree`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      return await listWorkspaceTree(context.root, request.query.path);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      return await readWorkspaceFile(context.root, request.query.path);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put<{ Params: { projectId: string; workspaceId: string }; Body: Buffer; Querystring: { path?: string; createDirs?: string; overwrite?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      const options: WriteWorkspaceFileOptions = {
        createDirs: request.query.createDirs !== "false",
        overwrite: request.query.overwrite !== "false",
      };
      return await writeWorkspaceFile(context.root, request.query.path, request.body, options);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      return await deleteWorkspaceFile(context.root, request.query.path);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { projectId: string; workspaceId: string }; Querystring: { fromPath?: string; toPath?: string; createDirs?: string; overwrite?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file/move`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      return await moveWorkspaceFile(context.root, request.query.fromPath, request.query.toPath, {
        createDirs: request.query.createDirs !== "false",
        overwrite: request.query.overwrite === "true",
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file/preview`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      const preview = await readWorkspaceImagePreview(context.root, request.query.path);
      return await reply
        .type(preview.mimeType)
        .header("Cache-Control", "private, max-age=3600")
        .header("Content-Length", String(preview.size))
        .header("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'")
        .header("Last-Modified", new Date(preview.modifiedAt).toUTCString())
        .header("X-Content-Type-Options", "nosniff")
        .send(preview.stream);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
