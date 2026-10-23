import type { FastifyInstance } from "fastify";
import { createServerPluginCatalogCapabilityFactory, type CreateServerPluginCatalogCapabilityOptions } from "../plugins/serverPluginCatalogCapability.js";
import { requestCancellation } from "../requestCancellation.js";
import type { PluginCatalogV1 } from "../../shared/pluginCatalogTypes.js";

/** Read-only browser catalog uses the same authority and projections as backend plugins. */
export function registerPluginCatalogRoutes(app: FastifyInstance, dependencies: CreateServerPluginCatalogCapabilityOptions): void {
  const factory = createServerPluginCatalogCapabilityFactory(dependencies);
  interface Params { projectId: string; workspaceId: string; sessionId: string }
  function route(path: string, read: (catalog: PluginCatalogV1, params: Params) => Promise<unknown>): void {
    app.get<{ Params: Params }>(path, async (request, reply) => {
      const cancellation = requestCancellation(request, reply);
      const lifetime = new AbortController();
      const instance = factory.create({ pluginId: "pi-web.browser", packageRoot: "", lifetimeSignal: AbortSignal.any([cancellation.signal, lifetime.signal]) });
      try {
        reply.header("cache-control", "no-store");
        return await read(instance.value, request.params);
      } catch (error) {
        if (cancellation.signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        return await reply.code(message === "Project not found" || /stale|unavailable|not found/iu.test(message) ? 404 : 400).send({ error: message });
      } finally {
        lifetime.abort();
        cancellation.dispose();
      }
    });
  }
  const projects = "/plugin-catalog/projects";
  const workspaces = `${projects}/:projectId/workspaces`;
  const workspace = `${workspaces}/:workspaceId`;
  route(projects, (catalog) => catalog.projects.list());
  route(`${projects}/:projectId`, (catalog, { projectId }) => catalog.projects.get(projectId));
  route(workspaces, (catalog, { projectId }) => catalog.workspaces.list(projectId));
  route(workspace, (catalog, { projectId, workspaceId }) => catalog.workspaces.get({ projectId, workspaceId }));
  route(`${workspace}/sessions`, (catalog, { projectId, workspaceId }) => catalog.sessions.list({ projectId, workspaceId }));
  route(`${workspace}/sessions/:sessionId`, (catalog, { projectId, workspaceId, sessionId }) => catalog.sessions.get({ projectId, workspaceId, sessionId }));
}
