import type { FastifyInstance } from "fastify";
import type { ServerNoticeDismissRequest } from "../../shared/apiTypes.js";
import type { ServerNoticeRouteService } from "./serverNoticeService.js";

/** Internal sessiond HTTP adapter for the server-owned current notice snapshot. */
export function registerServerNoticeRoutes(
  app: FastifyInstance,
  notices: ServerNoticeRouteService,
  prefix = "",
): void {
  app.get(`${prefix}/notices`, () => notices.snapshot());

  app.post<{ Body: unknown }>(`${prefix}/notices/dismiss`, (request, reply) => {
    try {
      const body = requireRecord(request.body);
      const dismissal: ServerNoticeDismissRequest = {
        daemonInstanceId: requireNonEmptyString(body["daemonInstanceId"], "daemonInstanceId"),
        noticeId: requireNonEmptyString(body["noticeId"], "noticeId"),
      };
      return notices.dismiss(dismissal);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("request body must be an object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} field must not be empty`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
