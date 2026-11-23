import { Readable } from "node:stream";
import type { FastifyReply } from "fastify";
import { parsePluginResourceMetadata } from "../../shared/pluginResourceMetadata.js";

export const PLUGIN_RESOURCE_STREAM_DEADLINE_MS = 30 * 60_000;

/** Range is the only browser request header allowed across resource hops. */
export function pluginResourceRange(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 256 || /[\r\n]/u.test(value)) throw new Error("Invalid resource Range header");
  return value;
}

export function applyPluginResourcePolicy(reply: FastifyReply, contentType = "application/json; charset=utf-8"): void {
  const pdf = contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
  reply.header("Cache-Control", "no-store")
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Disposition", "inline")
    .header("Content-Security-Policy", `${pdf ? "script-src 'none'" : "sandbox"}; default-src 'none'; frame-ancestors 'self'; form-action 'none'; base-uri 'none'`)
    .type(pdf ? "application/pdf" : contentType);
}

/** Remote metadata is untrusted: never copy upstream policy, redirects, or cookies. */
export function pluginResourceHeaders(status: number, headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const length = headers["content-length"];
  if (length !== undefined && (typeof length !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(length))) throw new Error("Invalid resource content length");
  const metadata = parsePluginResourceMetadata({
    statusCode: status,
    contentType: headers["content-type"],
    contentLength: length === undefined ? undefined : Number(length),
    contentRange: headers["content-range"],
    acceptRanges: headers["accept-ranges"],
  });
  return {
    "content-type": metadata.contentType,
    ...(metadata.contentLength === undefined ? {} : { "content-length": String(metadata.contentLength) }),
    ...(metadata.contentRange === undefined ? {} : { "content-range": metadata.contentRange }),
    ...(metadata.acceptRanges === undefined ? {} : { "accept-ranges": metadata.acceptRanges }),
  };
}

export async function sendPluginResourceResponse(reply: FastifyReply, upstream: {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body?: NodeJS.ReadableStream;
}, signal: AbortSignal): Promise<FastifyReply> {
  const body = upstream.body;
  if (!(body instanceof Readable)) throw new Error("Missing resource response body");
  try {
    if (![200, 206, 416].includes(upstream.statusCode)) {
      // Do not relay unbounded or mislabeled remote error documents.
      body.destroy();
      applyPluginResourcePolicy(reply);
      return await reply.code(upstream.statusCode >= 400 && upstream.statusCode <= 599 ? upstream.statusCode : 502)
        .send({ error: "Plugin resource request failed" });
    }
    const headers = pluginResourceHeaders(upstream.statusCode, upstream.headers);
    if (upstream.statusCode === 416) {
      body.destroy();
      applyPluginResourcePolicy(reply);
      for (const name of ["content-range", "accept-ranges"]) if (headers[name] !== undefined) reply.header(name, headers[name]);
      return await reply.code(416).send({ error: "Resource range not satisfiable" });
    }
    applyPluginResourcePolicy(reply, headers["content-type"]);
    for (const [key, value] of Object.entries(headers)) if (key !== "content-type") reply.header(key, value);
    const abort = (): void => { body.destroy(new DOMException("Resource request cancelled", "AbortError")); };
    const timer = setTimeout(() => { body.destroy(new DOMException("Resource stream timed out", "TimeoutError")); }, PLUGIN_RESOURCE_STREAM_DEADLINE_MS);
    timer.unref();
    body.once("close", () => { clearTimeout(timer); signal.removeEventListener("abort", abort); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return await reply.code(upstream.statusCode).send(body);
  } catch (error) {
    body.destroy();
    throw error;
  }
}

export function pluginResourceError(reply: FastifyReply, status: number, error: unknown): FastifyReply {
  for (const name of ["content-length", "content-range", "accept-ranges"]) reply.removeHeader(name);
  applyPluginResourcePolicy(reply);
  return reply.code(status).send({ error: (error instanceof Error ? error.message : String(error)).slice(0, 2048) });
}
