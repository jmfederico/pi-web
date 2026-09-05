import { createServer, type Server as NetServer, type Socket as NetSocket } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parsePluginBackendChannelServerEnvelope,
  PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES,
  serializePluginBackendChannelDataEnvelope,
} from "../../shared/pluginBackendProtocol.js";
import { PluginBackendChannelProxyAdmissionPool } from "./pluginBackendChannelProxyAdmission.js";
import { registerPluginBackendChannelProxyRoutes } from "./pluginBackendChannelProxyRoutes.js";

let app: FastifyInstance;
let upstream: WebSocketServer;
let sockets: WebSocket[];

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await waitForListening(upstream);
  sockets = [];
});

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  await app.close();
  await new Promise<void>((resolve) => { upstream.close(() => { resolve(); }); });
});

describe("local plugin backend channel proxy", () => {
  it("bridges opaque bounded text beyond the transport-connect deadline and releases after clean physical teardown", async () => {
    const admissions = new PluginBackendChannelProxyAdmissionPool({ transportConnectTimeoutMs: 250 });
    const connections: { path: string; maxPayload: number | undefined }[] = [];
    const upstreamConnected = new Promise<WebSocket>((resolve) => {
      upstream.once("connection", (socket) => {
        sockets.push(socket);
        resolve(socket);
      });
    });
    registerPluginBackendChannelProxyRoutes(app, {
      connectWebSocket(path, options) {
        connections.push({ path, maxPayload: options?.maxPayload });
        const socket = new WebSocket(`${webSocketServerUrl(upstream)}${path}`, options);
        sockets.push(socket);
        return socket;
      },
    }, "/api", admissions);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const browser = new WebSocket(`${fastifyServerUrl(app)}/api/plugin-backends/terminal.tools/projects/project%20one/workspaces/workspace%20one/channels/terminal.attach`);
    sockets.push(browser);
    const upstreamSocket = await upstreamConnected;
    await waitForOpen(browser);
    const opaqueClientFrame = "not-json-and-not-an-envelope";
    const forwardedClientFrame = nextMessage(upstreamSocket);
    browser.send(opaqueClientFrame);
    await expect(forwardedClientFrame).resolves.toBe(opaqueClientFrame);

    const opaqueUpstreamFrame = "also-not-json-and-not-an-envelope";
    const forwardedUpstreamFrame = nextMessage(browser);
    upstreamSocket.send(opaqueUpstreamFrame);
    await expect(forwardedUpstreamFrame).resolves.toBe(opaqueUpstreamFrame);
    expect(admissions.activeCount).toBe(1);

    await delay(350);
    const lateClientData = serializePluginBackendChannelDataEnvelope({ direction: "upstream" });
    const forwardedLateClientData = nextMessage(upstreamSocket);
    browser.send(lateClientData);
    await expect(forwardedLateClientData).resolves.toBe(lateClientData);
    const lateServerData = serializePluginBackendChannelDataEnvelope({ direction: "browser" });
    const forwardedLateServerData = nextMessage(browser);
    upstreamSocket.send(lateServerData);
    await expect(forwardedLateServerData).resolves.toBe(lateServerData);
    expect(connections).toEqual([{
      path: "/plugin-backends/terminal.tools/projects/project%20one/workspaces/workspace%20one/channels/terminal.attach",
      maxPayload: PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES,
    }]);

    const browserClosed = nextClose(browser);
    const upstreamClosed = nextClose(upstreamSocket);
    browser.close(1000, "complete");
    await Promise.all([browserClosed, upstreamClosed]);
    await vi.waitFor(() => { expect(admissions.activeCount).toBe(0); });
  });

  it("rejects excess proxy admissions before opening another daemon socket", async () => {
    const admissions = new PluginBackendChannelProxyAdmissionPool({ maxTotal: 1, transportConnectTimeoutMs: 1_000 });
    let connectionCount = 0;
    let resolveDaemonConnected: ((socket: WebSocket) => void) | undefined;
    const daemonConnected = new Promise<WebSocket>((resolve) => { resolveDaemonConnected = resolve; });
    upstream.once("connection", (socket) => {
      sockets.push(socket);
      resolveDaemonConnected?.(socket);
    });
    registerPluginBackendChannelProxyRoutes(app, {
      connectWebSocket(path, options) {
        connectionCount += 1;
        const socket = new WebSocket(`${webSocketServerUrl(upstream)}${path}`, options);
        sockets.push(socket);
        return socket;
      },
    }, "/api", admissions);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const first = new WebSocket(`${fastifyServerUrl(app)}/api/plugin-backends/terminal/projects/p/workspaces/w/channels/attach`);
    sockets.push(first);
    await waitForOpen(first);
    const daemonSocket = await daemonConnected;
    expect(connectionCount).toBe(1);
    expect(admissions.activeCount).toBe(1);

    const second = new WebSocket(`${fastifyServerUrl(app)}/api/plugin-backends/terminal/projects/p/workspaces/w/channels/attach`);
    sockets.push(second);
    const errorFrame = nextMessage(second).then((text) => parsePluginBackendChannelServerEnvelope(text));
    const rejected = nextClose(second);
    await waitForOpen(second);
    await expect(errorFrame).resolves.toMatchObject({ kind: "error", code: "admission-denied" });
    await expect(rejected).resolves.toMatchObject({ code: 1006 });
    expect(connectionCount).toBe(1);
    expect(admissions.activeCount).toBe(1);

    const firstClosed = nextClose(first);
    const daemonClosed = nextClose(daemonSocket);
    first.close();
    await Promise.all([firstClosed, daemonClosed]);
    await vi.waitFor(() => { expect(admissions.activeCount).toBe(0); });
  });

  it("times out and releases when the daemon WebSocket upgrade stalls", async () => {
    const stalledSockets = new Set<NetSocket>();
    let resolveStalledClosed: (() => void) | undefined;
    const stalledClosed = new Promise<void>((resolve) => { resolveStalledClosed = resolve; });
    const stalled = createServer((socket) => {
      stalledSockets.add(socket);
      socket.once("close", () => {
        stalledSockets.delete(socket);
        resolveStalledClosed?.();
      });
      socket.resume();
    });
    await listen(stalled);
    const admissions = new PluginBackendChannelProxyAdmissionPool({ transportConnectTimeoutMs: 100 });
    try {
      registerPluginBackendChannelProxyRoutes(app, {
        connectWebSocket(_path, options) {
          const address = stalled.address();
          if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
          const socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}`, options);
          sockets.push(socket);
          return socket;
        },
      }, "/api", admissions);
      await app.listen({ host: "127.0.0.1", port: 0 });

      const browser = new WebSocket(`${fastifyServerUrl(app)}/api/plugin-backends/terminal/projects/p/workspaces/w/channels/attach`);
      sockets.push(browser);
      const closed = nextClose(browser);
      await waitForOpen(browser);
      const closeEvent = await closed;
      expect(closeEvent.code).toBe(1011);
      expect(closeEvent.reason).toContain("transport connection timed out");
      await stalledClosed;
      await vi.waitFor(() => { expect(admissions.activeCount).toBe(0); });
      expect(stalledSockets.size).toBe(0);
    } finally {
      for (const socket of stalledSockets) socket.destroy();
      await close(stalled);
    }
  });

  it("cancels a connecting daemon socket when the downstream closes early", async () => {
    const stalledSockets = new Set<NetSocket>();
    let resolveAccepted: (() => void) | undefined;
    const accepted = new Promise<void>((resolve) => { resolveAccepted = resolve; });
    let resolveStalledClosed: (() => void) | undefined;
    const stalledClosed = new Promise<void>((resolve) => { resolveStalledClosed = resolve; });
    const stalled = createServer((socket) => {
      stalledSockets.add(socket);
      resolveAccepted?.();
      socket.once("close", () => {
        stalledSockets.delete(socket);
        resolveStalledClosed?.();
      });
      socket.resume();
    });
    await listen(stalled);
    const admissions = new PluginBackendChannelProxyAdmissionPool({ transportConnectTimeoutMs: 1_000 });
    try {
      registerPluginBackendChannelProxyRoutes(app, {
        connectWebSocket(_path, options) {
          const address = stalled.address();
          if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
          const socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}`, options);
          sockets.push(socket);
          return socket;
        },
      }, "/api", admissions);
      await app.listen({ host: "127.0.0.1", port: 0 });

      const browser = new WebSocket(`${fastifyServerUrl(app)}/api/plugin-backends/terminal/projects/p/workspaces/w/channels/attach`);
      sockets.push(browser);
      await waitForOpen(browser);
      await accepted;
      expect(admissions.activeCount).toBe(1);

      const browserClosed = nextClose(browser);
      browser.close(1000, "cancel setup");
      await browserClosed;
      await stalledClosed;
      await vi.waitFor(() => { expect(admissions.activeCount).toBe(0); });
      expect(stalledSockets.size).toBe(0);
    } finally {
      for (const socket of stalledSockets) socket.destroy();
      await close(stalled);
    }
  });
});

function waitForListening(server: WebSocketServer): Promise<void> {
  if (server.address() !== null) return Promise.resolve();
  return new Promise((resolve) => { server.once("listening", () => { resolve(); }); });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", () => { resolve(); });
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("message", (data, isBinary) => {
      if (isBinary) throw new Error("Expected text frame");
      resolve(rawDataToString(data));
    });
  });
}

function nextClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

function listen(server: NetServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: NetServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function webSocketServerUrl(server: WebSocketServer): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${String(address.port)}`;
}

function fastifyServerUrl(instance: FastifyInstance): string {
  const address = instance.server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${String(address.port)}`;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}
