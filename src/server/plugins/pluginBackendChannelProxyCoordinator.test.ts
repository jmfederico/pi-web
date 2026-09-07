import { createServer, type Server as NetServer, type Socket as NetSocket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { PluginBackendChannelProxyAdmissionPool } from "./pluginBackendChannelProxyAdmission.js";
import { coordinatePluginBackendChannelProxy } from "./pluginBackendChannelProxyCoordinator.js";

const servers = new Set<WebSocketServer>();
const sockets = new Set<WebSocket>();

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  await Promise.all(Array.from(servers, closeSocketServer));
  sockets.clear();
  servers.clear();
});

describe("plugin backend channel proxy coordinator", () => {
  it("times out unresolved setup and physically closes a late upstream without reacquiring accounting", async () => {
    const downstream = await createSocketPair();
    const lateUpstream = await createSocketPair();
    const upstream = deferred<WebSocket>();
    const admissions = new PluginBackendChannelProxyAdmissionPool({ transportConnectTimeoutMs: 25 });
    const downstreamClosed = nextClose(downstream.peerSocket);
    const completion = coordinatePluginBackendChannelProxy({
      downstream: downstream.bridgeSocket,
      admissions,
      scope: scope(),
      connectUpstream: () => upstream.promise,
    });

    expect(admissions.activeCount).toBe(1);
    const downstreamCloseEvent = await downstreamClosed;
    expect(downstreamCloseEvent.code).toBe(1011);
    expect(downstreamCloseEvent.reason).toContain("transport connection timed out");
    await completion;
    expect(admissions.activeCount).toBe(0);

    const lateUpstreamClosed = nextClose(lateUpstream.peerSocket);
    upstream.resolve(lateUpstream.bridgeSocket);
    await expect(lateUpstreamClosed).resolves.toMatchObject({ code: 1006 });
    await delay(35);
    expect(admissions.activeCount).toBe(0);
  });

  it("settles an upstream setup error before the pending deadline and releases exactly once", async () => {
    const downstream = await createSocketPair();
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
    const address = stalled.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
    const outbound = new WebSocket(`ws://127.0.0.1:${String(address.port)}`);
    sockets.add(outbound);
    const admissions = new PluginBackendChannelProxyAdmissionPool({ transportConnectTimeoutMs: 250 });
    try {
      const downstreamClosed = nextClose(downstream.peerSocket);
      const completion = coordinatePluginBackendChannelProxy({
        downstream: downstream.bridgeSocket,
        admissions,
        scope: scope(),
        connectUpstream: () => outbound,
      });
      await accepted;
      expect(admissions.activeCount).toBe(1);

      outbound.emit("error", new Error("upgrade failed"));
      const downstreamCloseEvent = await downstreamClosed;
      expect(downstreamCloseEvent.code).toBe(1011);
      expect(downstreamCloseEvent.reason).toContain("upstream transport setup failed");
      await Promise.all([completion, stalledClosed]);
      expect(admissions.activeCount).toBe(0);
      await delay(300);
      expect(admissions.activeCount).toBe(0);
      expect(stalledSockets.size).toBe(0);
    } finally {
      for (const socket of stalledSockets) socket.destroy();
      await close(stalled);
    }
  });
});

function scope(): { authorityId: string; pluginId: string; projectId: string; workspaceId: string } {
  return {
    authorityId: "test",
    pluginId: "terminal",
    projectId: "project",
    workspaceId: "workspace",
  };
}

interface SocketPair {
  bridgeSocket: WebSocket;
  peerSocket: WebSocket;
}

async function createSocketPair(): Promise<SocketPair> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.add(server);
  await waitForListening(server);
  const connected = new Promise<WebSocket>((resolve) => {
    server.once("connection", (socket) => {
      sockets.add(socket);
      resolve(socket);
    });
  });
  const peerSocket = new WebSocket(serverUrl(server));
  sockets.add(peerSocket);
  const opened = waitForOpen(peerSocket);
  const bridgeSocket = await connected;
  await opened;
  return { bridgeSocket, peerSocket };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function waitForListening(server: WebSocketServer): Promise<void> {
  if (server.address() !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () => {
      socket.off("error", reject);
      resolve();
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

function closeSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => { resolve(); });
  });
}

function serverUrl(server: WebSocketServer): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected WebSocket server address");
  return `ws://127.0.0.1:${String(address.port)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
