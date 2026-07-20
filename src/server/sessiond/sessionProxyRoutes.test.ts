import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSessionProxyRoutes } from "./sessionProxyRoutes";

let app: FastifyInstance;
let daemon: FakeSessionDaemon;

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  daemon = await FakeSessionDaemon.create();
  registerSessionProxyRoutes(app, daemon, "/api/machines/local");
});

afterEach(async () => {
  await app.close();
  await daemon.close();
});

describe("machine-scoped session proxy routes", () => {
  it("strips the machine prefix before forwarding session requests", async () => {
    const response = await app.inject({ method: "GET", url: "/api/machines/local/sessions?cwd=/repo" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(daemon.requests).toEqual([{ method: "GET", path: "/sessions?cwd=/repo", body: undefined }]);
  });

  it("forwards queue-clear mutations and their status through the session daemon", async () => {
    const status = { sessionId: "session-1", pendingMessageCount: 0, queuedMessages: [] };
    daemon.respondWith({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(status) });

    const response = await app.inject({ method: "POST", url: "/api/machines/local/sessions/session-1/queue/clear", payload: { cwd: "/repo" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(status);
    expect(daemon.requests).toEqual([{ method: "POST", path: "/sessions/session-1/queue/clear", body: { cwd: "/repo" } }]);
  });

  it("forwards unread snapshots and acknowledgement cutoffs unchanged", async () => {
    const catalog = await app.inject({ method: "GET", url: "/api/machines/local/sessions/unread" });
    const acknowledge = await app.inject({
      method: "POST",
      url: "/api/machines/local/sessions/session-1/unread/acknowledge",
      payload: { cwd: "/repo", catalogId: "catalog-test", throughCompletionOrder: 9 },
    });

    expect([catalog.statusCode, acknowledge.statusCode]).toEqual([200, 200]);
    expect(daemon.requests).toEqual([
      { method: "GET", path: "/sessions/unread", body: undefined },
      { method: "POST", path: "/sessions/session-1/unread/acknowledge", body: { cwd: "/repo", catalogId: "catalog-test", throughCompletionOrder: 9 } },
    ]);
  });

  it("forwards notification snapshots and dismissal bodies unchanged", async () => {
    const catalog = await app.inject({ method: "GET", url: "/api/machines/local/sessions/notifications" });
    const inbox = await app.inject({ method: "GET", url: `/api/machines/local/sessions/session-1/notifications?cwd=${encodeURIComponent("/repo")}` });
    const dismiss = await app.inject({
      method: "POST",
      url: "/api/machines/local/sessions/session-1/notifications/dismiss",
      payload: { cwd: "/repo", daemonInstanceId: "daemon-test", notificationId: "notice-1" },
    });
    const dismissAll = await app.inject({
      method: "POST",
      url: "/api/machines/local/sessions/session-1/notifications/dismiss-all",
      payload: { cwd: "/repo", daemonInstanceId: "daemon-test", throughOrder: 7, throughOverflowWatermark: 2 },
    });

    expect([catalog.statusCode, inbox.statusCode, dismiss.statusCode, dismissAll.statusCode]).toEqual([200, 200, 200, 200]);
    expect(daemon.requests).toEqual([
      { method: "GET", path: "/sessions/notifications", body: undefined },
      { method: "GET", path: "/sessions/session-1/notifications?cwd=%2Frepo", body: undefined },
      { method: "POST", path: "/sessions/session-1/notifications/dismiss", body: { cwd: "/repo", daemonInstanceId: "daemon-test", notificationId: "notice-1" } },
      { method: "POST", path: "/sessions/session-1/notifications/dismiss-all", body: { cwd: "/repo", daemonInstanceId: "daemon-test", throughOrder: 7, throughOverflowWatermark: 2 } },
    ]);
  });

  it("strips the machine prefix before forwarding auth requests", async () => {
    const response = await app.inject({ method: "POST", url: "/api/machines/local/auth/api-key", payload: { providerId: "p", key: "k" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(daemon.requests).toEqual([{ method: "POST", path: "/auth/api-key", body: { providerId: "p", key: "k" } }]);
  });

  it("forwards sessiond health and runtime aliases to daemon endpoints", async () => {
    const healthResponse = await app.inject({ method: "GET", url: "/api/machines/local/sessiond/health" });
    const runtimeResponse = await app.inject({ method: "GET", url: "/api/machines/local/sessiond/runtime" });

    expect(healthResponse.statusCode).toBe(200);
    expect(healthResponse.json()).toEqual({ ok: true });
    expect(runtimeResponse.statusCode).toBe(200);
    expect(runtimeResponse.json()).toEqual({ ok: true });
    expect(daemon.requests).toEqual([
      { method: "GET", path: "/health", body: undefined },
      { method: "GET", path: "/runtime", body: undefined },
    ]);
  });

  it("forwards empty upstream responses without parsing a body", async () => {
    daemon.respondWith({ statusCode: 204, headers: {}, body: "" });

    const response = await app.inject({ method: "DELETE", url: "/api/machines/local/sessions/session-1" });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(daemon.requests).toEqual([{ method: "DELETE", path: "/sessions/session-1", body: undefined }]);
  });

  it("returns a 502 response when the daemon request fails", async () => {
    daemon.failWith(new Error("connection refused"));

    const response = await app.inject({ method: "GET", url: "/api/machines/local/sessions" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "Session daemon unavailable: connection refused" });
    expect(daemon.requests).toEqual([{ method: "GET", path: "/sessions", body: undefined }]);
  });

  it("preserves cwd query context when forwarding session event websockets", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${serverUrl(app)}/api/machines/local/sessions/session-1/events?cwd=${encodeURIComponent("/repo")}`);

    try {
      await waitForOpen(socket);
      expect(daemon.websocketPaths).toEqual(["/sessions/session-1/events?cwd=%2Frepo"]);
    } finally {
      socket.close();
    }
  });
});

interface FakeSessionDaemonResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

class FakeSessionDaemon {
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  readonly websocketPaths: string[] = [];
  private readonly queuedResponses: (FakeSessionDaemonResponse | Error)[] = [];
  private readonly sockets = new Set<WebSocket>();

  private constructor(private readonly upstream: WebSocketServer) {
    this.upstream.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => { this.sockets.delete(socket); });
    });
  }

  static async create(): Promise<FakeSessionDaemon> {
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await waitForListening(upstream);
    return new FakeSessionDaemon(upstream);
  }

  respondWith(response: FakeSessionDaemonResponse): void {
    this.queuedResponses.push(response);
  }

  failWith(error: Error): void {
    this.queuedResponses.push(error);
  }

  request(method: string, path: string, body?: unknown): Promise<FakeSessionDaemonResponse> {
    this.requests.push({ method, path, body });
    const queuedResponse = this.queuedResponses.shift();
    if (queuedResponse instanceof Error) return Promise.reject(queuedResponse);
    return Promise.resolve(queuedResponse ?? { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) });
  }

  connectWebSocket(path: string): WebSocket {
    this.websocketPaths.push(path);
    return new WebSocket(`${webSocketServerUrl(this.upstream)}${path}`);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await closeWebSocketServer(this.upstream);
  }
}

function serverUrl(instance: FastifyInstance): string {
  const address = instance.server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${String(address.port)}`;
}

function webSocketServerUrl(server: WebSocketServer): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${String(address.port)}`;
}

function waitForListening(server: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    server.once("listening", () => { resolve(); });
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", () => { resolve(); });
    socket.once("error", reject);
    socket.once("close", () => { reject(new Error("WebSocket closed before opening")); });
  });
}
