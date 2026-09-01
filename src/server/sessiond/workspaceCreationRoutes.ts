import type { FastifyInstance, FastifyReply } from "fastify";
import type { TerminalCommandRun } from "../../shared/apiTypes.js";
import {
  parseWorkspaceCreationRequest,
  WORKSPACE_CREATION_REQUEST_BODY_MAX_BYTES,
} from "../../shared/workspaceCreation.js";
import { requestCancellation } from "../requestCancellation.js";
import type { Project } from "../types.js";
import { workspaceCreationHttpStatus, type WorkspaceCreationInput } from "../workspaces/workspaceCreationService.js";

export interface WorkspaceCreationProjectReader {
  requireProject(projectId: string): Promise<Project>;
}

export interface WorkspaceCreator {
  create(project: Project, input: WorkspaceCreationInput, signal: AbortSignal): Promise<TerminalCommandRun>;
}

export interface WorkspaceCreationRouteDependencies {
  projects: WorkspaceCreationProjectReader;
  creations: WorkspaceCreator;
  /**
   * Reports that the project's workspaces may have changed. Called whatever the
   * outcome, because a creation that fails part way still leaves the provider
   * listing different from the one status attribution cached.
   */
  onWorkspacesMutated: () => void;
}

/** Internal sessiond endpoint for host-orchestrated provider workspace creation. */
export function registerWorkspaceCreationRoutes(
  app: FastifyInstance,
  dependencies: WorkspaceCreationRouteDependencies,
  prefix = "/workspace-creations",
): void {
  app.post<{ Params: { projectId: string }; Body: unknown }>(
    `${prefix}/projects/:projectId`,
    { bodyLimit: WORKSPACE_CREATION_REQUEST_BODY_MAX_BYTES },
    async (request, reply) => {
      let input: WorkspaceCreationInput;
      try {
        input = parseWorkspaceCreationRequest(request.body);
      } catch (error) {
        return reply.code(400).send({ error: errorMessage(error) });
      }

      let project: Project;
      try {
        project = await dependencies.projects.requireProject(request.params.projectId);
      } catch (error) {
        const message = errorMessage(error);
        return reply.code(message === "Project not found" ? 404 : 500).send({ error: message });
      }

      const cancellation = requestCancellation(request, reply);
      try {
        return await dependencies.creations.create(project, input, cancellation.signal);
      } catch (error) {
        return await creationRequestFailed(reply, error);
      } finally {
        dependencies.onWorkspacesMutated();
        cancellation.dispose();
      }
    },
  );
}

function creationRequestFailed(reply: FastifyReply, error: unknown): FastifyReply {
  return reply.code(workspaceCreationHttpStatus(error)).send({ error: errorMessage(error) });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
