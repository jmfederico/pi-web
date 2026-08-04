import type { FastifyReply, FastifyRequest } from "fastify";

export interface RequestCancellation {
  signal: AbortSignal;
  dispose(): void;
}

/**
 * Turns an inbound HTTP disconnect into cooperative cancellation for a bounded
 * downstream operation. A normal completed response never aborts the signal.
 */
export function requestCancellation(request: FastifyRequest, reply: FastifyReply): RequestCancellation {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("HTTP request cancelled", "AbortError"));
    }
  };
  const abortOnPrematureResponseClose = (): void => {
    if (!reply.raw.writableEnded) abort();
  };

  request.raw.once("aborted", abort);
  reply.raw.once("close", abortOnPrematureResponseClose);
  if (request.raw.destroyed || (reply.raw.destroyed && !reply.raw.writableEnded)) abort();

  return {
    signal: controller.signal,
    dispose() {
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", abortOnPrematureResponseClose);
    },
  };
}
