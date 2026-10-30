import type { FastifyInstance, FastifyReply } from "fastify";
import { WebSocket, type RawData } from "ws";
import {
  SessionDaemonClient,
  type SessionDaemonRequestOptions,
  type SessionDaemonStreamResponse,
} from "../../sessiond/sessionDaemonClient.js";
import { requestCancellation } from "../requestCancellation.js";
import { PI_WEB_CAPABILITIES, supportsPiWebCapability } from "../../shared/capabilities.js";
import { parsePiWebRuntimeComponent } from "../../shared/piWebStatusParsing.js";

export interface SessionProxyDaemon {
  request(
    method: string,
    path: string,
    body?: unknown,
    options?: SessionDaemonRequestOptions,
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;
  requestStream(path: string, options?: SessionDaemonRequestOptions): Promise<SessionDaemonStreamResponse>;
  connectWebSocket(path: string): WebSocket;
}

export function registerSessionProxyRoutes(
  app: FastifyInstance,
  daemon: SessionProxyDaemon = new SessionDaemonClient(),
  prefix = "/api",
  cleanupPreferences?: { pinnedSessionIds(): Promise<string[]> },
): void {
  const proxy = async (request: { method: string; url: string; body?: unknown }, reply: FastifyReply) => {
    try {
      const upstream = await daemon.request(request.method, stripPrefix(request.url, prefix), request.body);
      reply.code(upstream.statusCode);
      const contentType = upstream.headers["content-type"];
      if (contentType !== undefined && contentType !== "") reply.header("content-type", contentType);
      return upstream.body !== "" ? parseJson(upstream.body) : undefined;
    } catch (error) {
      requestFailed(reply, error);
      return undefined;
    }
  };

  for (const path of ["/sessions/cleanup/preview", "/sessions/cleanup"]) {
    app.post(`${prefix}${path}`, async (request, reply) => {
      const body = request.body;
      if (body !== undefined && !isRecord(body)) {
        return reply.code(400).send({ error: "Request body must be an object" });
      }
      const record = body ?? {};
      if (record["skipPinned"] !== undefined && typeof record["skipPinned"] !== "boolean") {
        return reply.code(400).send({ error: "skipPinned field must be a boolean" });
      }
      // Never trust browser-supplied exclusions: only this web/API owns navigation state.
      const forwarded = { ...record };
      delete forwarded["excludedPinnedSessionIds"];
      if (record["skipPinned"] === true) {
        try {
          if (cleanupPreferences === undefined) throw new Error("Pinned session lookup unavailable");
          forwarded["excludedPinnedSessionIds"] = await cleanupPreferences.pinnedSessionIds();
        } catch (error) {
          request.log.error({ err: error }, "Failed to read pinned sessions for cleanup");
          return reply.code(500).send({ error: "Unable to read pinned sessions for cleanup" });
        }
        try {
          // Check every operation: an older long-lived daemon would ignore the exclusions.
          const response = await daemon.request("GET", "/runtime");
          const runtime = response.statusCode === 200 ? parsePiWebRuntimeComponent(parseJson(response.body)) : undefined;
          if (runtime?.component !== "sessiond" || !runtime.available || !supportsPiWebCapability(runtime, PI_WEB_CAPABILITIES.sessionCleanupPinnedExclusions)) {
            return await reply.code(503).send({ error: "Pinned-session cleanup protection is unavailable. Restart the session daemon after updating PI WEB." });
          }
        } catch (error) {
          request.log.error({ err: error }, "Failed to verify pinned-session cleanup protection");
          return reply.code(503).send({ error: "Unable to verify pinned-session cleanup protection" });
        }
      }
      return proxy({ method: request.method, url: request.url, body: forwarded }, reply);
    });
  }

  // Image responses cross this boundary as bytes, never as JSON or UTF-8 text.
  app.get(`${prefix}/sessions/:sessionId/media/:mediaId`, async (request, reply) => {
    const cancellation = requestCancellation(request, reply);
    try {
      const upstream = await daemon.requestStream(stripPrefix(request.url, prefix), { signal: cancellation.signal });
      reply.code(upstream.statusCode);
      for (const name of ["content-type", "content-length", "cache-control", "x-content-type-options"]) {
        const value = upstream.headers[name];
        if (value !== undefined && value !== "") reply.header(name, value);
      }
      return await reply.send(upstream.body);
    } catch (error) {
      requestFailed(reply, error);
      return await reply;
    } finally {
      cancellation.dispose();
    }
  });

  app.get(`${prefix}/sessiond/health`, (_request, reply) => proxy({ method: "GET", url: `${prefix}/health` }, reply));
  app.get(`${prefix}/sessiond/runtime`, (_request, reply) => proxy({ method: "GET", url: `${prefix}/runtime` }, reply));

  app.get<{ Params: { sessionId: string } }>(`${prefix}/sessions/:sessionId/events`, { websocket: true }, (socket, request) => {
    bridgeSockets(socket, daemon.connectWebSocket(stripPrefix(request.url, prefix)));
  });

  app.get(`${prefix}/sessions/events`, { websocket: true }, (socket) => {
    bridgeSockets(socket, daemon.connectWebSocket("/sessions/events"));
  });

  app.get(`${prefix}/events`, { websocket: true }, (socket) => {
    bridgeSockets(socket, daemon.connectWebSocket("/events"));
  });

  app.post(`${prefix}/projects`, (request, reply) => proxy(request, reply));
  app.delete(`${prefix}/projects/:projectId`, (request, reply) => proxy(request, reply));

  // Catalog reads can include provider I/O; forward browser cancellation.
  app.get(`${prefix}/plugin-catalog/*`, async (request, reply) => {
    const cancellation = requestCancellation(request, reply);
    try {
      const upstream = await daemon.request("GET", stripPrefix(request.url, prefix), undefined, { signal: cancellation.signal });
      reply.code(upstream.statusCode).header("cache-control", "no-store");
      return upstream.body === "" ? undefined : parseJson(upstream.body);
    } catch (error) {
      requestFailed(reply, error);
      return undefined;
    } finally {
      cancellation.dispose();
    }
  });

  app.all(`${prefix}/status`, (request, reply) => proxy(request, reply));
  app.all(`${prefix}/notices`, (request, reply) => proxy(request, reply));
  app.all(`${prefix}/notices/dismiss`, (request, reply) => proxy(request, reply));
  app.get(`${prefix}/models`, (request, reply) => proxy(request, reply));
  app.all(`${prefix}/auth`, (request, reply) => proxy(request, reply));
  app.all(`${prefix}/auth/*`, (request, reply) => proxy(request, reply));
  app.all(`${prefix}/sessions`, (request, reply) => proxy(request, reply));
  app.all(`${prefix}/sessions/*`, (request, reply) => proxy(request, reply));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripPrefix(url: string, prefix: string): string {
  const path = url.split("?", 1)[0] ?? url;
  const query = url.slice(path.length);
  const stripped = path.startsWith(prefix) ? `${path.slice(prefix.length)}${query}` : url;
  return stripped === "" ? "/" : stripped;
}

function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

function requestFailed(reply: FastifyReply, error: unknown): void {
  reply.code(502).send({ error: `Session daemon unavailable: ${error instanceof Error ? error.message : String(error)}` });
}

function bridgeSockets(client: WebSocket, upstream: WebSocket): void {
  client.on("message", (data) => { sendIfOpen(upstream, data); });
  upstream.on("message", (data) => { sendIfOpen(client, data); });
  client.on("close", () => { upstream.close(); });
  upstream.on("close", () => { client.close(); });
  upstream.on("error", () => { client.close(); });
  client.on("error", () => { upstream.close(); });
}

function sendIfOpen(socket: WebSocket, data: RawData): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(data);
  }
}
