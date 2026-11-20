import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { DEFAULT_HTTP_ACCESS_LOG, DEFAULT_LOG_LEVEL, type PiWebConfig } from "../config.js";
import { withGatewayRequestId } from "../sessiond/gatewayRequestContext.js";
import { isObservedDaemonBodyError } from "./sessiond/daemonProxyDiagnostics.js";

type Service = "web" | "sessiond";

// Fastify's blanket disableRequestLogging also disables its default error,
// serializer and response-stream diagnostics. Replace only the access chatter.
class HttpLogController extends LogController {
  constructor(private readonly access: boolean) { super(); }

  override incomingRequest(): void { /* completion only */ }
  override routeNotFound(): void { /* counted at completion without the raw URL */ }

  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply): void {
    if (error != null) {
      super.requestCompleted(error, request, reply);
    } else if (this.access) {
      request.log.info({
        event: "http.access", method: request.method, route: request.routeOptions.url ?? "<unmatched>",
        statusCode: reply.statusCode, durationMs: reply.elapsedTime,
      }, "HTTP request completed");
    }
  }

  override defaultErrorLog(error: Error, request: FastifyRequest, reply: FastifyReply): void {
    if (!isObservedDaemonBodyError(request, error)) super.defaultErrorLog(error, request, reply);
  }

  override streamError(error: NodeJS.ErrnoException, request: FastifyRequest, reply: FastifyReply): void {
    if (isObservedDaemonBodyError(request, error)) return;
    if (reply.raw.destroyed && (error.code === "ERR_STREAM_PREMATURE_CLOSE" || error.name === "AbortError")) return;
    super.streamError(error, request, reply);
  }
}

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function createHttpServer(
  service: Service,
  config: Pick<PiWebConfig, "logLevel" | "httpAccessLog">,
  options: Pick<FastifyServerOptions, "bodyLimit" | "logger"> = {},
): FastifyInstance {
  const logger = typeof options.logger === "object" ? options.logger : {};
  const app = Fastify({
    ...(options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit }),
    logger: options.logger === false ? false : {
      ...logger, level: config.logLevel ?? DEFAULT_LOG_LEVEL,
      base: { pid: process.pid, hostname: hostname(), service },
      // Fastify also serializes `req` in diagnostics, e.g. unhandled 5xx.
      serializers: { ...logger.serializers, req: (req) => ({ method: req.method, route: req.routeOptions.url }) },
    },
    logController: new HttpLogController(config.httpAccessLog ?? DEFAULT_HTTP_ACCESS_LOG),
    requestIdHeader: false,
    genReqId: (raw) => {
      // Only the private daemon listener accepts hop IDs. Never use an inbound
      // header for gateway identity, even when it looks like a valid UUID.
      const hopId = raw.headers["x-request-id"];
      return service === "sessiond" && typeof hopId === "string" && uuidV4.test(hopId) ? hopId : randomUUID();
    },
  });
  app.addHook("onRequest", (request, reply, done) => {
    void reply.header("x-request-id", request.id);
    if (service === "web") withGatewayRequestId(request.id, done);
    else done();
  });
  return app;
}
