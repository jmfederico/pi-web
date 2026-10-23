import type { FastifyInstance } from "fastify";
import { isPiWebPluginId } from "../../shared/pluginIds.js";
import { requestCancellation } from "../requestCancellation.js";
import type { Project } from "../types.js";
import type { WorkspaceChangeNotifier } from "../workspaces/workspaceChangeNotifier.js";

export interface WorkspaceNotificationRouteDependencies {
  projects: { requireProject(projectId: string): Promise<Project> };
  workspaces: { acceptNotification(project: Project, pluginId: string, signal: AbortSignal): Promise<boolean> };
  changes: Pick<WorkspaceChangeNotifier, "notify">;
}

/** Machine-local hints from provider-owned integrations, never a workspace registration API. */
export function registerWorkspaceNotificationRoutes(app: FastifyInstance, dependencies: WorkspaceNotificationRouteDependencies): void {
  app.post<{ Params: { projectId: string }; Body: unknown }>(
    "/workspace-notifications/projects/:projectId",
    { bodyLimit: 1_024 },
    async (request, reply) => {
      const { projectId } = request.params;
      const body = request.body;
      if (projectId === "" || projectId.length > 512
        || typeof body !== "object" || body === null || Array.isArray(body)
        || !("pluginId" in body) || typeof body.pluginId !== "string" || !isPiWebPluginId(body.pluginId)
        || Object.keys(body).some((key) => key !== "pluginId")) {
        return await reply.code(400).send({ error: "Workspace notification requires a registered project id and pluginId" });
      }
      let project: Project;
      try {
        project = await dependencies.projects.requireProject(projectId);
      } catch (error) {
        const message = errorMessage(error);
        return await reply.code(message === "Project not found" ? 404 : 500).send({ error: message });
      }
      const cancellation = requestCancellation(request, reply);
      try {
        const accepted = await dependencies.workspaces.acceptNotification(project, body.pluginId, cancellation.signal);
        if (accepted && !cancellation.signal.aborted) dependencies.changes.notify(project.id);
        return await reply.send({ accepted });
      } catch (error) {
        request.log.warn({ err: error, projectId, pluginId: body.pluginId }, "workspace notification could not be evaluated");
        return await reply.code(502).send({ error: errorMessage(error) });
      } finally {
        cancellation.dispose();
      }
    },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
