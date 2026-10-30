import type { FastifyInstance } from "fastify";
import type { PluginSessionSelection } from "../../shared/pluginCatalogTypes.js";
import type { PluginSessionLifecycleV1 } from "../../shared/pluginSessionLifecycleTypes.js";
import { createServerPluginSessionLifecycleCapabilityFactory, type CreateServerPluginSessionLifecycleCapabilityOptions } from "../plugins/serverPluginSessionLifecycleCapability.js";
import { requestCancellation } from "../requestCancellation.js";

/** Browser lifecycle commands share backend-plugin workspace and session authority. */
export function registerPluginSessionLifecycleRoutes(app: FastifyInstance, dependencies: CreateServerPluginSessionLifecycleCapabilityOptions): void {
  const factory = createServerPluginSessionLifecycleCapabilityFactory(dependencies);
  const base = "/plugin-sessions/projects/:projectId/workspaces/:workspaceId/sessions/:sessionId";
  function route(method: "GET" | "POST" | "DELETE", path: string, operation: Exclude<keyof PluginSessionLifecycleV1, "version">): void {
    app.route<{ Params: PluginSessionSelection }>({
      method, url: path,
      handler: async (request, reply) => {
        const cancellation = requestCancellation(request, reply);
        const instance = factory.create({ pluginId: "pi-web.browser", packageRoot: "", lifetimeSignal: cancellation.signal });
        try {
          reply.header("cache-control", "no-store");
          // Only route-owned identifiers are authority inputs; bodies/query cwd are ignored.
          const { projectId, workspaceId, sessionId } = request.params;
          const result = await instance.value[operation]({ projectId, workspaceId, sessionId });
          if (operation === "get") return result;
          return { ok: true };
        } catch (error) {
          if (cancellation.signal.aborted) throw error;
          const message = error instanceof Error ? error.message : String(error);
          const status = /stale|unavailable|not found|could not resolve the selected project/iu.test(message) ? 404 : /activity|must be archived/iu.test(message) ? 409 : 400;
          return await reply.code(status).send({ error: message });
        } finally {
          await instance.dispose?.(new AbortController().signal);
          cancellation.dispose();
        }
      },
    });
  }
  route("GET", base, "get");
  for (const operation of ["pin", "unpin", "archive", "restore"] as const) route("POST", `${base}/${operation}`, operation);
  route("DELETE", base, "delete");
}
