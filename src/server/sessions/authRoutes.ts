import type { FastifyInstance } from "fastify";
import type { AuthService } from "./authService.js";

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService, prefix = ""): void {
  app.get<{ Querystring: { mode?: "login" | "logout"; authType?: "oauth" | "api_key" } }>(`${prefix}/auth/providers`, async (request, reply) => {
    try {
      return await auth.authProviders(request.query.mode ?? "login", request.query.authType);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Body: { providerId: string; key: string } }>(`${prefix}/auth/api-key`, async (request, reply) => {
    try {
      return await auth.saveApiKey(request.body.providerId, request.body.key);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Additive endpoint for newer browsers; the one-secret route remains for
  // rolling compatibility with older browser bundles.
  app.post<{ Body: { providerId: string } }>(`${prefix}/auth/api-key/interactive`, async (request, reply) => {
    try {
      return await auth.startApiKeyLogin(request.body.providerId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Body: { providerId: string } }>(`${prefix}/auth/logout`, async (request, reply) => {
    try {
      return await auth.logoutProvider(request.body.providerId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Body: { providerId: string } }>(`${prefix}/auth/oauth`, async (request, reply) => {
    try {
      return await auth.startOAuthLogin(request.body.providerId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { flowId: string } }>(`${prefix}/auth/oauth/:flowId`, async (request, reply) => {
    try {
      return auth.oauthFlow(request.params.flowId);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { flowId: string }; Body: { requestId: string; value: string } }>(`${prefix}/auth/oauth/:flowId/respond`, async (request, reply) => {
    try {
      return auth.respondToOAuthFlow(request.params.flowId, request.body.requestId, request.body.value);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { flowId: string } }>(`${prefix}/auth/oauth/:flowId/cancel`, async (request, reply) => {
    try {
      return auth.cancelOAuthFlow(request.params.flowId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
