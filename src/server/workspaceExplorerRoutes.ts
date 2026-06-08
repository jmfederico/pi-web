import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import type { ProjectService } from "./projects/projectService.js";
import type { WorkspaceService } from "./workspaces/workspaceService.js";
import { resolveWorkspaceContext } from "./workspaces/workspaceContext.js";
import { listWorkspaceTree } from "./workspaces/fileTreeService.js";
import { readWorkspaceFile } from "./workspaces/fileContentService.js";
import { readWorkspaceImagePreview } from "./workspaces/imagePreviewService.js";

const execFileAsync = promisify(execFile);

export function registerWorkspaceExplorerRoutes(app: FastifyInstance, projects: ProjectService, workspaces: WorkspaceService, prefix = "/api"): void {
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

  app.put<{ Params: { projectId: string; workspaceId: string }; Body: { path?: string; content?: string } | undefined }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file`, async (request, reply) => {
    try {
      const body = request.body;
      if (body === undefined || typeof body.path !== "string" || body.path.trim() === "") throw new Error("path is required");
      if (typeof body.content !== "string") throw new Error("content is required");
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      const target = safeWorkspacePath(context.root, body.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body.content, "utf8");
      return { accepted: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { projectId: string; workspaceId: string }; Body: { ideaId?: string } | undefined }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/idea-workspace`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      const ideaId = typeof request.body?.ideaId === "string" && request.body.ideaId.trim() !== "" ? request.body.ideaId : "idea";
      const slug = ideaId.toLowerCase().replace(/[^a-z0-9.-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48) || "idea";
      const target = await uniqueWorktreePath(context.project.path, slug);
      const branch = `pi-web-idea/${basename(target)}`;
      await execFileAsync("git", ["-C", context.root, "worktree", "add", "-b", branch, target, "HEAD"], { env: sanitizedGitEnv() });
      const created = (await workspaces.list(context.project)).find((workspace) => workspace.path === target);
      if (created === undefined) throw new Error("Created workspace was not discovered");
      return created;
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

async function uniqueWorktreePath(projectPath: string, slug: string): Promise<string> {
  const parent = dirname(projectPath);
  const base = `${basename(projectPath)}-${slug}`;
  for (let index = 1; index < 100; index += 1) {
    const candidate = join(parent, index === 1 ? base : `${base}-${String(index)}`);
    try {
      await execFileAsync("test", ["-e", candidate]);
    } catch {
      return candidate;
    }
  }
  throw new Error("Could not allocate an idea workspace path");
}

function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  return env;
}

function safeWorkspacePath(root: string, path: string): string {
  const separator = process.platform === "win32" ? "\\\\" : "/";
  const normalized = normalize(path).replace(/^([/\\\\])+/, "");
  if (normalized === ".." || normalized.startsWith(`..${separator}`)) throw new Error("Path escapes workspace");
  const target = resolve(root, normalized);
  const resolvedRoot = resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${separator}`)) throw new Error("Path escapes workspace");
  return target;
}
