import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isObservedDaemonBodyError, logDaemonProxyFailure, logDaemonRequestFailure, logInvalidDaemonResponse, observeDaemonBody } from "./daemonProxyDiagnostics.js";
import type { ReportWebSocketProxyFailure, WebSocketProxyFailure } from "../webSocketBridge.js";
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
): void {
  const proxy = async (request: { method: string; url: string; body?: unknown }, reply: FastifyReply, cancellation?: ReturnType<typeof requestCancellation>) => {
    try {
      let upstream;
      const path = stripPrefix(request.url, prefix);
      try {
        upstream = cancellation === undefined
          ? await daemon.request(request.method, path, request.body)
          : await daemon.request(request.method, path, request.body, { signal: cancellation.signal });
      } catch (error) {
        logDaemonRequestFailure(reply.request, error, cancellation?.signal);
        requestFailed(reply, error);
        return undefined;
      }
      reply.code(upstream.statusCode);
      if (cancellation !== undefined) reply.header("cache-control", "no-store");
      else {
        const contentType = upstream.headers["content-type"];
        if (contentType !== undefined && contentType !== "") reply.header("content-type", contentType);
      }
      return upstream.body !== "" ? parseJson(upstream.body) : undefined;
    } catch (error) {
      logInvalidDaemonResponse(reply.request);
      requestFailed(reply, error);
      return undefined;
    } finally {
      cancellation?.dispose();
    }
  };

  const requireDaemonPins = async (reply: FastifyReply): Promise<boolean> => {
    try {
      const response = await daemon.request("GET", "/runtime");
      const runtime = response.statusCode === 200 ? parsePiWebRuntimeComponent(parseJson(response.body)) : undefined;
      if (runtime?.component === "sessiond" && runtime.available && supportsPiWebCapability(runtime, PI_WEB_CAPABILITIES.sessionPinsDaemonOwned)) return true;
    } catch (error) {
      if (error instanceof SyntaxError) logInvalidDaemonResponse(reply.request);
      else logDaemonRequestFailure(reply.request, error);
      // Fail closed: never fall back to legacy web-owned pin state.
    }
    await reply.code(503).send({ error: "Daemon-owned session pins are unavailable. Update the web/API before restarting the updated session daemon." });
    return false;
  };

  const pinPath = `${prefix}/navigation/projects/:projectId/workspaces/:workspaceId/session-pins`;
  for (const method of ["GET", "PUT"] as const) {
    app.route({ method, url: pinPath, handler: async (request, reply) => {
      if (!await requireDaemonPins(reply)) return;
      return proxy(request, reply);
    } });
  }

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
      // Only sessiond resolves exclusions, freshly for every preview/execute.
      const forwarded = { ...record };
      delete forwarded["excludedPinnedSessionIds"];
      if (record["skipPinned"] === true && !await requireDaemonPins(reply)) return;
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
      const stopObserving = observeDaemonBody(request, upstream.body, cancellation.signal);
      try { return await reply.send(upstream.body); } finally { stopObserving(); }
    } catch (error) {
      if (!isObservedDaemonBodyError(request, error)) logDaemonRequestFailure(request, error, cancellation.signal);
      if (cancellation.signal.aborted || reply.raw.headersSent) return;
      requestFailed(reply, error);
      return await reply;
    } finally {
      cancellation.dispose();
    }
  });

  app.get(`${prefix}/sessiond/health`, (_request, reply) => proxy({ method: "GET", url: `${prefix}/health` }, reply));
  app.get(`${prefix}/sessiond/runtime`, (_request, reply) => proxy({ method: "GET", url: `${prefix}/runtime` }, reply));

  const connectEvents = (socket: WebSocket, request: FastifyRequest, path: string): void => {
    const report: ReportWebSocketProxyFailure = (failure, error) => {
      logDaemonProxyFailure(request, { transport: "websocket", ...failure }, error);
    };
    let upstream: WebSocket;
    try {
      upstream = daemon.connectWebSocket(path);
    } catch (error) {
      report({ phase: "connect", reason: "socket-error" }, error);
      socket.close(1011);
      return;
    }
    bridgeSockets(socket, upstream, report);
  };
  app.get(`${prefix}/sessions/:sessionId/events`, { websocket: true }, (socket, request) => {
    connectEvents(socket, request, stripPrefix(request.url, prefix));
  });
  app.get(`${prefix}/sessions/events`, { websocket: true }, (socket, request) => { connectEvents(socket, request, "/sessions/events"); });
  app.get(`${prefix}/events`, { websocket: true }, (socket, request) => { connectEvents(socket, request, "/events"); });

  app.post(`${prefix}/projects`, (request, reply) => proxy(request, reply));
  app.delete(`${prefix}/projects/:projectId`, (request, reply) => proxy(request, reply));

  // Authority resolution can include provider I/O; forward browser cancellation.
  const cancellableProxy = (request: FastifyRequest, reply: FastifyReply) => proxy(request, reply, requestCancellation(request, reply));
  app.get(`${prefix}/plugin-catalog/*`, cancellableProxy);
  app.all(`${prefix}/plugin-sessions/*`, cancellableProxy);

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

function bridgeSockets(client: WebSocket, upstream: WebSocket, report: ReportWebSocketProxyFailure): void {
  let phase: WebSocketProxyFailure["phase"] = upstream.readyState === WebSocket.OPEN ? "bridge" : "connect";
  let closing = false;
  upstream.once("open", () => { phase = "bridge"; });
  const closeUpstream = (): void => { closing = true; upstream.close(); };
  client.on("message", (data) => { sendIfOpen(upstream, data); });
  upstream.on("message", (data) => { sendIfOpen(client, data); });
  client.on("close", closeUpstream);
  client.on("error", closeUpstream);
  upstream.on("close", (code) => {
    if (!closing && (phase === "connect" || code === 1006 || code === 1011)) report({ phase, reason: "unexpected-close", closeCode: code });
    closing = true;
    client.close();
  });
  upstream.on("error", (error) => {
    if (!closing) report({ phase, reason: "socket-error" }, error);
    closing = true;
    client.close();
  });
}

function sendIfOpen(socket: WebSocket, data: RawData): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(data);
  }
}
