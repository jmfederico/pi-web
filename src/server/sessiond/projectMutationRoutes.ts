import type { FastifyInstance } from "fastify";
import type { ProjectService } from "../projects/projectService.js";

export function registerProjectMutationRoutes(app: FastifyInstance, projects: Pick<ProjectService, "add" | "close">): void {
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

  app.delete<{ Params: { projectId: string } }>("/projects/:projectId", async (request, reply) => {
    try {
      await projects.close(request.params.projectId);
      return { closed: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message === "Project not found" ? 404 : 500).send({ error: message });
    }
  });
}

function isProjectInput(input: unknown): input is Parameters<ProjectService["add"]>[0] {
  return input !== null && typeof input === "object"
    && "path" in input && typeof input.path === "string" && input.path.trim() !== ""
    && (!("name" in input) || input.name === undefined || typeof input.name === "string")
    && (!("create" in input) || input.create === undefined || typeof input.create === "boolean");
}

function isInvalidProjectPath(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "Project path must be a directory") return true;
  return "code" in error && ["ENOENT", "ENOTDIR", "EEXIST", "EACCES", "EPERM", "EINVAL", "ENAMETOOLONG", "ELOOP", "ERR_INVALID_ARG_VALUE"].includes(String(error.code));
}
