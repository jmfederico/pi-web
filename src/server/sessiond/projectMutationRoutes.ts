import type { FastifyInstance, FastifyReply } from "fastify";
import type { ProjectService } from "../projects/projectService.js";

export function registerProjectMutationRoutes(app: FastifyInstance, projects: Pick<ProjectService, "add" | "rename" | "close">): void {
  app.post<{ Body: unknown }>("/projects", async (request, reply) => {
    const input = request.body;
    if (!isProjectInput(input)) {
      return reply.code(400).send({ error: "Invalid project input: path is required; name must be a string and create must be a boolean" });
    }
    try {
      return await projects.add(input);
    } catch (error) {
      return reply.code(isInvalidProjectPath(error) ? 400 : 500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch<{ Params: { projectId: string }; Body: unknown }>("/projects/:projectId", async (request, reply) => {
    const input = request.body;
    if (!isRenameInput(input)) return reply.code(400).send({ error: "Invalid project input: name must be a string" });
    try {
      return await projects.rename(request.params.projectId, input.name);
    } catch (error) {
      return sendProjectError(reply, error);
    }
  });

  app.delete<{ Params: { projectId: string } }>("/projects/:projectId", async (request, reply) => {
    try {
      await projects.close(request.params.projectId);
      return { closed: true };
    } catch (error) {
      return sendProjectError(reply, error);
    }
  });
}

function sendProjectError(reply: FastifyReply, error: unknown): FastifyReply {
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(message === "Project not found" ? 404 : 500).send({ error: message });
}

function isProjectInput(input: unknown): input is Parameters<ProjectService["add"]>[0] {
  return input !== null && typeof input === "object"
    && "path" in input && typeof input.path === "string" && input.path.trim() !== ""
    && (!("name" in input) || input.name === undefined || typeof input.name === "string")
    && (!("create" in input) || input.create === undefined || typeof input.create === "boolean");
}

function isRenameInput(input: unknown): input is { name: string } {
  return input !== null && typeof input === "object" && "name" in input && typeof input.name === "string";
}

function isInvalidProjectPath(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "Project path must be a directory") return true;
  return "code" in error && ["ENOENT", "ENOTDIR", "EEXIST", "EACCES", "EPERM", "EINVAL", "ENAMETOOLONG", "ELOOP", "ERR_INVALID_ARG_VALUE"].includes(String(error.code));
}
