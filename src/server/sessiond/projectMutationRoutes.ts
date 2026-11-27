import type { FastifyInstance, FastifyReply } from "fastify";
import type { ProjectService } from "../projects/projectService.js";
import type { ProjectSettingsUpdate } from "../../shared/apiTypes.js";
import { requireWorktreeFolder } from "../../shared/worktreeFolder.js";

export function registerProjectMutationRoutes(
  app: FastifyInstance,
  projects: Pick<ProjectService, "add" | "updateSettings" | "close">,
  enforcedWorktreeFolder?: string,
): void {
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
    let update: ProjectSettingsUpdate;
    try {
      update = parseProjectSettingsUpdate(request.body);
      if (enforcedWorktreeFolder !== undefined && (update.set?.worktreeFolder !== undefined || update.unset?.includes("/worktreeFolder") === true)) {
        throw new Error(`Worktree folder is controlled by ${enforcedWorktreeFolder}`);
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    try {
      return await projects.updateSettings(request.params.projectId, update);
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

function parseProjectSettingsUpdate(input: unknown): ProjectSettingsUpdate {
  if (!isRecord(input)) throw new Error("Project settings must be an object");
  // The existing rename API continues to accept a bare { name }.
  if (Object.keys(input).length === 1 && typeof input["name"] === "string") return { set: { name: input["name"] } };
  if (Object.keys(input).some((key) => key !== "set" && key !== "unset")) throw new Error("Project settings update must contain only set and unset");
  const fields = input["set"] === undefined ? {} : input["set"];
  if (!isRecord(fields) || Object.keys(fields).some((key) => key !== "name" && key !== "worktreeFolder")) throw new Error("Unknown project setting");
  const name = fields["name"];
  if (name !== undefined && typeof name !== "string") throw new Error("Project name must be a string");
  const rawFolder = fields["worktreeFolder"];
  const worktreeFolder = rawFolder === undefined ? undefined : requireWorktreeFolder(rawFolder, "Project worktree folder");
  const unset = input["unset"] === undefined ? [] : input["unset"];
  if (!Array.isArray(unset) || !unset.every((key) => key === "/worktreeFolder")) throw new Error("Only /worktreeFolder can be unset");
  if (unset.length > 0 && worktreeFolder !== undefined) throw new Error("Worktree folder cannot be set and unset together");
  if (unset.length === 0 && name === undefined && worktreeFolder === undefined) throw new Error("No project settings to update");
  return {
    set: { ...(name === undefined ? {} : { name }), ...(worktreeFolder === undefined ? {} : { worktreeFolder }) },
    ...(unset.length === 0 ? {} : { unset: ["/worktreeFolder"] }),
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

function isInvalidProjectPath(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "Project path must be a directory") return true;
  return "code" in error && ["ENOENT", "ENOTDIR", "EEXIST", "EACCES", "EPERM", "EINVAL", "ENAMETOOLONG", "ELOOP", "ERR_INVALID_ARG_VALUE"].includes(String(error.code));
}
