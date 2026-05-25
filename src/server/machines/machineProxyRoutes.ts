import type { FastifyInstance, FastifyReply, HTTPMethods } from "fastify";
import type { WebSocket } from "ws";
import { bridgeSockets } from "../webSocketBridge.js";
import { RemoteMachineRequestError } from "./machineClient.js";
import { MachineService } from "./machineService.js";

interface HttpRouteSpec {
  method: HTTPMethods;
  path: string;
}

const REMOTE_HTTP_ROUTES: HttpRouteSpec[] = [
  { method: "GET", path: "/projects" },
  { method: "POST", path: "/projects" },
  { method: "DELETE", path: "/projects/:projectId" },
  { method: "GET", path: "/project-directories" },
  { method: "GET", path: "/projects/:projectId/workspaces" },
  { method: "GET", path: "/projects/:projectId/workspaces/:workspaceId/tree" },
  { method: "GET", path: "/projects/:projectId/workspaces/:workspaceId/file" },
  { method: "GET", path: "/projects/:projectId/workspaces/:workspaceId/file/preview" },
  { method: "GET", path: "/projects/:projectId/workspaces/:workspaceId/git/status" },
  { method: "GET", path: "/projects/:projectId/workspaces/:workspaceId/git/diff" },
  { method: "GET", path: "/projects/:projectId/workspaces/:workspaceId/terminals" },
  { method: "POST", path: "/projects/:projectId/workspaces/:workspaceId/terminals" },
  { method: "DELETE", path: "/projects/:projectId/workspaces/:workspaceId/terminals/:terminalId" },
  { method: "GET", path: "/files" },
  { method: "GET", path: "/activity" },
  { method: "GET", path: "/sessions" },
  { method: "POST", path: "/sessions" },
  { method: "GET", path: "/sessions/:sessionId/messages" },
  { method: "GET", path: "/sessions/:sessionId/status" },
  { method: "GET", path: "/sessions/:sessionId/models" },
  { method: "POST", path: "/sessions/:sessionId/model" },
  { method: "POST", path: "/sessions/:sessionId/model/cycle" },
  { method: "GET", path: "/sessions/:sessionId/thinking-levels" },
  { method: "POST", path: "/sessions/:sessionId/thinking-level" },
  { method: "POST", path: "/sessions/:sessionId/thinking-level/cycle" },
  { method: "GET", path: "/sessions/:sessionId/commands" },
  { method: "POST", path: "/sessions/:sessionId/prompt" },
  { method: "POST", path: "/sessions/:sessionId/shell" },
  { method: "POST", path: "/sessions/:sessionId/commands/run" },
  { method: "POST", path: "/sessions/:sessionId/commands/respond" },
  { method: "POST", path: "/sessions/:sessionId/abort" },
  { method: "POST", path: "/sessions/:sessionId/stop" },
  { method: "POST", path: "/sessions/:sessionId/archive" },
  { method: "POST", path: "/sessions/:sessionId/archive-tree" },
  { method: "POST", path: "/sessions/:sessionId/restore" },
  { method: "POST", path: "/sessions/:sessionId/detach-parent" },
  { method: "GET", path: "/auth/providers" },
  { method: "POST", path: "/auth/api-key" },
  { method: "POST", path: "/auth/logout" },
];

const REMOTE_WEBSOCKET_ROUTES = [
  "/events",
  "/sessions/events",
  "/sessions/:sessionId/events",
  "/projects/:projectId/workspaces/:workspaceId/terminals/:terminalId/socket",
];

const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "cache-control",
  "last-modified",
  "etag",
]);

export function registerMachineProxyRoutes(app: FastifyInstance, machines = new MachineService()): void {
  for (const spec of REMOTE_HTTP_ROUTES) {
    app.route<{ Params: { machineId: string }; Body: unknown }>({
      method: spec.method,
      url: `/api/machines/:machineId${spec.path}`,
      handler: (request, reply) => proxyHttpRequest(machines, request.params.machineId, request.method, request.url, request.body, reply),
    });
  }

  for (const path of REMOTE_WEBSOCKET_ROUTES) {
    app.get<{ Params: { machineId: string } }>(`/api/machines/:machineId${path}`, { websocket: true }, async (socket, request) => {
      await proxyWebSocket(machines, request.params.machineId, request.url, socket);
    });
  }
}

async function proxyHttpRequest(machines: MachineService, machineId: string, method: string, requestUrl: string, body: unknown, reply: FastifyReply): Promise<FastifyReply> {
  if (machineId === "local") {
    return reply.code(501).send({ error: "Local machine route is not registered for this endpoint" });
  }

  const client = await machines.remoteClient(machineId);
  if (client === undefined) {
    return reply.code(404).send({ error: "Machine not found" });
  }

  try {
    const upstream = await client.request(method, remoteApiPath(machineId, requestUrl), body);
    reply.code(upstream.statusCode);
    applySafeHeaders(reply, upstream.headers);
    if (upstream.body === undefined) return await reply.send();
    return await reply.send(upstream.body);
  } catch (error) {
    return sendGatewayError(reply, machineId, error);
  }
}

async function proxyWebSocket(machines: MachineService, machineId: string, requestUrl: string, socket: WebSocket): Promise<void> {
  if (machineId === "local") {
    socket.close(1011, "Local machine route is not registered for this endpoint");
    return;
  }

  const client = await machines.remoteClient(machineId);
  if (client === undefined) {
    socket.close(1008, "Machine not found");
    return;
  }

  try {
    bridgeSockets(socket, client.connectWebSocket(remoteApiPath(machineId, requestUrl)));
  } catch {
    socket.close(1011, "Remote machine unavailable");
  }
}

function remoteApiPath(machineId: string, requestUrl: string): string {
  const machinePrefix = `/api/machines/${encodeURIComponent(machineId)}`;
  const stripped = requestUrl.startsWith(machinePrefix) ? requestUrl.slice(machinePrefix.length) : requestUrl;
  const compatPath = stripped.startsWith("/") ? stripped : `/${stripped}`;
  return `/api${compatPath}`;
}

function applySafeHeaders(reply: FastifyReply, headers: Record<string, string | string[] | undefined>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (!SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    reply.header(name, value);
  }
}

function sendGatewayError(reply: FastifyReply, machineId: string, error: unknown): FastifyReply {
  const statusCode = error instanceof RemoteMachineRequestError ? error.statusCode : 502;
  const label = statusCode === 504 ? "Remote machine timeout" : "Remote machine unavailable";
  return reply.code(statusCode).send({
    error: label,
    machineId,
    statusCode,
    detail: error instanceof Error ? error.message : String(error),
  });
}
