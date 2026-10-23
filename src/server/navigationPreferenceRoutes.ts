import type { FastifyInstance } from "fastify";
import { NAVIGATION_PREFERENCE_ROUTES } from "../shared/navigationPreferences.js";
import { InvalidNavigationPreferenceError, NavigationPreferenceConflictError, parseNavigationPreference, type NavigationPreferenceScope, type NavigationPreferenceStore } from "./storage/navigationPreferenceStore.js";

interface PreferenceParams {
  projectId?: string;
  workspaceId?: string;
}

function preferenceScope(index: number, params: PreferenceParams): NavigationPreferenceScope {
  if (index === 0) return { kind: "projects" };
  if (params.projectId === undefined) throw new Error("Missing project scope");
  if (index === 1) return { kind: "workspaces", projectId: params.projectId };
  if (params.workspaceId === undefined) throw new Error("Missing workspace scope");
  return { kind: "session-pins", projectId: params.projectId, workspaceId: params.workspaceId };
}

export function registerNavigationPreferenceRoutes(
  app: FastifyInstance,
  store: Pick<NavigationPreferenceStore, "get" | "put">,
  prefix = "/api",
): void {
  NAVIGATION_PREFERENCE_ROUTES.forEach((path, index) => {
    app.get<{ Params: PreferenceParams }>(`${prefix}${path}`, async (request) => store.get(preferenceScope(index, request.params)));
    app.put<{ Params: PreferenceParams; Body: unknown }>(`${prefix}${path}`, async (request, reply) => {
      let preference;
      try {
        preference = parseNavigationPreference(request.body);
      } catch (error) {
        if (error instanceof InvalidNavigationPreferenceError) return reply.code(400).send({ error: error.message });
        throw error;
      }
      try {
        return await store.put(preferenceScope(index, request.params), preference);
      } catch (error) {
        if (error instanceof NavigationPreferenceConflictError) {
          return reply.code(409).send({ error: error.message, ...error.current });
        }
        throw error;
      }
    });
  });
}
