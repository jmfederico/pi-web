import type { FastifyInstance, FastifyReply } from "fastify";
import { WebSocket, type RawData } from "ws";
import { SessionDaemonClient } from "../../sessiond/sessionDaemonClient.js";

export interface SessionProxyDaemon {
  request(method: string, path: string, body?: unknown): Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;
  connectWebSocket(path: string): WebSocket;
}

export function registerSessionProxyRoutes(app: FastifyInstance, daemon: SessionProxyDaemon = new SessionDaemonClient(), prefix = "/api"): void {
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

  app.all(`${prefix}/activity`, (request, reply) => proxy(request, reply));
  app.all(`${prefix}/auth`, (request, reply) => proxy(request, reply));
  app.all(`${prefix}/auth/*`, (request, reply) => proxy(request, reply));
  app.all(`${prefix}/sessions`, (request, reply) => proxy(request, reply));
  app.all(`${prefix}/sessions/*`, (request, reply) => proxy(request, reply));
  app.all(`${prefix}/scheduled-tasks`, (request, reply) => proxy(request, reply));
  app.all(`${prefix}/scheduled-tasks/*`, (request, reply) => proxy(request, reply));
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
