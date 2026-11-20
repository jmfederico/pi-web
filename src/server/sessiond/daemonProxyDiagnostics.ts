import type { Readable } from "node:stream";
import type { FastifyRequest } from "fastify";
import type { WebSocketProxyFailure } from "../webSocketBridge.js";

interface HttpFailure {
  transport: "http";
  phase: "request" | "response";
  reason: "request-failed" | "invalid-response" | "stream-failed" | "timeout";
}

/** Never serialize upstream errors: messages/stacks can include URLs, query input, or socket paths. */
export function logDaemonProxyFailure(
  request: FastifyRequest,
  failure: HttpFailure | ({ transport: "websocket" } & WebSocketProxyFailure),
  error?: unknown,
): void {
  const errorCode = transportErrorCode(error);
  request.log.error({
    event: "sessiond.proxy.failure", upstream: "sessiond", method: request.method, route: request.routeOptions.url,
    ...failure, ...(errorCode === undefined ? {} : { errorCode }),
  }, "Session daemon proxy failed");
}

// A fetch failure usually has the system error on its cause rather than the outer TypeError.
function transportErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  for (const cause of [error, error.cause]) {
    if (cause instanceof Error && "code" in cause && typeof cause.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(cause.code)) return cause.code;
  }
  return undefined;
}

export function logDaemonRequestFailure(request: FastifyRequest, error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted === true) return;
  const reason = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "request-failed";
  logDaemonProxyFailure(request, { transport: "http", phase: "request", reason }, error);
}

// Fastify consumes source errors inside reply.send(stream); awaiting the reply
// does not reject on a premature close. Attribute at the source and leave the
// response lifecycle to Fastify, without also logging its copy of this error.
const observedBodyErrors = new WeakMap<FastifyRequest, Error>();

export function observeDaemonBody(request: FastifyRequest, body: Readable, signal: AbortSignal): () => void {
  const onError = (error: Error): void => {
    observedBodyErrors.set(request, error);
    if (!signal.aborted) logDaemonProxyFailure(request, {
      transport: "http", phase: "response", reason: error.name === "TimeoutError" ? "timeout" : "stream-failed",
    }, error);
  };
  body.once("error", onError);
  return () => { body.off("error", onError); };
}

export function isObservedDaemonBodyError(request: FastifyRequest, error: unknown): boolean {
  return error instanceof Error && observedBodyErrors.get(request) === error;
}

export function logInvalidDaemonResponse(request: FastifyRequest): void {
  logDaemonProxyFailure(request, { transport: "http", phase: "response", reason: "invalid-response" });
}
