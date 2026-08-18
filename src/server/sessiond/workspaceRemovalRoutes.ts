import type { FastifyInstance, FastifyReply } from "fastify";
import type { TerminalCommandRun } from "../../shared/apiTypes.js";
import {
  parseWorkspaceRemovalRequest,
  WORKSPACE_REMOVAL_REQUEST_BODY_MAX_BYTES,
} from "../../shared/workspaceRemovalProtocol.js";
import { requestCancellation } from "../requestCancellation.js";
import type { Project } from "../types.js";
import { workspaceRemovalHttpStatus } from "../workspaces/workspaceRemovalService.js";

export interface WorkspaceRemovalProjectReader {
  requireProject(projectId: string): Promise<Project>;
}

export interface WorkspaceRemover {
  remove(
    project: Project,
    workspaceId: string,
    precondition: string,
    signal: AbortSignal,
  ): Promise<TerminalCommandRun>;
}

export interface WorkspaceRemovalRouteDependencies {
  projects: WorkspaceRemovalProjectReader;
  removals: WorkspaceRemover;
  /**
   * Reports that the project's workspaces may have changed. Called whatever the
   * outcome, because a removal that fails part way still leaves the provider
   * listing different from the one status attribution cached.
   */
  onWorkspacesMutated: () => void;
}

/** Internal sessiond endpoint for host-orchestrated provider workspace removal. */
export function registerWorkspaceRemovalRoutes(
  app: FastifyInstance,
  dependencies: WorkspaceRemovalRouteDependencies,
  prefix = "/workspace-removals",
): void {
  app.delete<{ Params: { projectId: string; workspaceId: string }; Body: unknown }>(
    `${prefix}/projects/:projectId/workspaces/:workspaceId`,
    { bodyLimit: WORKSPACE_REMOVAL_REQUEST_BODY_MAX_BYTES },
    async (request, reply) => {
      let precondition: string;
      try {
        precondition = parseWorkspaceRemovalRequest(request.body).precondition;
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
        return await dependencies.removals.remove(
          project,
          request.params.workspaceId,
          precondition,
          cancellation.signal,
        );
      } catch (error) {
        return await removalRequestFailed(reply, error);
      } finally {
        dependencies.onWorkspacesMutated();
        cancellation.dispose();
      }
    },
  );
}

function removalRequestFailed(reply: FastifyReply, error: unknown): FastifyReply {
  return reply.code(workspaceRemovalHttpStatus(error)).send({ error: errorMessage(error) });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
