import type { FastifyInstance, FastifyReply } from "fastify";
import type { PiPackageScope } from "../shared/apiTypes.js";
import { ActiveAgentProfileAccessError } from "./activeAgentProfileProvider.js";
import type { PiPackageService } from "./piPackageService.js";

class PiPackageRequestValidationError extends Error {}

export function registerPiPackageRoutes(app: FastifyInstance, service: PiPackageService, prefix = "/api"): void {
  const routePrefix = normalizeRoutePrefix(prefix);

  app.get(`${routePrefix}/pi-packages`, async (_request, reply) => {
    try {
      return await service.list();
    } catch (error) {
      return sendPiPackageError(reply, error);
    }
  });

  app.post<{ Body: unknown }>(`${routePrefix}/pi-packages/install`, async (request, reply) => {
    try {
      return await service.install(parseRequiredSourceRequest(request.body));
    } catch (error) {
      return sendPiPackageError(reply, error);
    }
  });

  app.post<{ Body: unknown }>(`${routePrefix}/pi-packages/remove`, async (request, reply) => {
    try {
      const body = requireRequestObject(request.body);
      return await service.remove(parseRequiredSource(body["source"]), parseOptionalScope(body["scope"]));
    } catch (error) {
      return sendPiPackageError(reply, error);
    }
  });

  app.post<{ Body: unknown }>(`${routePrefix}/pi-packages/update`, async (request, reply) => {
    try {
      const source = parseOptionalUpdateSource(request.body);
      return source === undefined ? await service.update() : await service.update(source);
    } catch (error) {
      return sendPiPackageError(reply, error);
    }
  });
}

function normalizeRoutePrefix(prefix: string): string {
  const normalized = prefix.replace(/\/+$/u, "");
  return normalized === "" ? "/api" : normalized;
}

function parseRequiredSourceRequest(body: unknown): string {
  const request = requireRequestObject(body);
  if (request["scope"] !== undefined || request["local"] !== undefined) {
    throw new PiPackageRequestValidationError("Pi package install scope is not supported; installs use Pi's default package location");
  }
  return parseRequiredSource(request["source"]);
}

function parseRequiredSource(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new PiPackageRequestValidationError("Pi package source must be a non-empty string");
  return value.trim();
}

function parseOptionalUpdateSource(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  const source = requireRequestObject(body)["source"];
  if (source === undefined) return undefined;
  return parseRequiredSource(source);
}

function parseOptionalScope(value: unknown): PiPackageScope | undefined {
  if (value === undefined) return undefined;
  if (value !== "user" && value !== "project") throw new PiPackageRequestValidationError("Pi package scope must be \"user\" or \"project\"");
  return value;
}

function requireRequestObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new PiPackageRequestValidationError("Pi package request body must be an object");
  return value;
}

function sendPiPackageError(reply: FastifyReply, error: unknown): FastifyReply {
  const status = error instanceof PiPackageRequestValidationError
    ? 400
    : error instanceof ActiveAgentProfileAccessError
      ? 503
      : 500;
  return reply.code(status).send({ error: errorMessage(error) });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
