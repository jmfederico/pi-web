import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parsePluginBackendChannelServerEnvelope,
  PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES,
  PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES,
  serializePluginBackendChannelDataEnvelope,
  serializePluginBackendChannelOpenEnvelope,
  serializePluginBackendChannelReadyEnvelope,
} from "../../shared/pluginBackendProtocol.js";
import { PluginBackendChannelProxyAdmissionPool } from "../plugins/pluginBackendChannelProxyAdmission.js";
import { registerPluginBackendChannelProxyRoutes } from "../plugins/pluginBackendChannelProxyRoutes.js";
import type { MachineClient } from "./machineClient.js";
import { registerMachineProxyRoutes } from "./machineProxyRoutes.js";

let app: FastifyInstance;
let remoteServer: WebSocketServer;
let sockets: WebSocket[];

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  remoteServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await waitForListening(remoteServer);
  sockets = [];
});

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  await app.close();
  await new Promise<void>((resolve) => { remoteServer.close(() => { resolve(); }); });
});

describe("machine plugin backend channel proxy", () => {
  it("transfers an opaque ordered prelude and bridges data beyond the transport-connect deadline", async () => {
    const admissions = new PluginBackendChannelProxyAdmissionPool({ transportConnectTimeoutMs: 250 });
    const connections: { path: string; maxPayload: number | undefined }[] = [];
    const remoteConnected = new Promise<{ socket: WebSocket; messages: ReturnType<typeof socketMessages> }>((resolve) => {
      remoteServer.once("connection", (socket) => {
        sockets.push(socket);
        resolve({ socket, messages: socketMessages(socket) });
      });
    });
    const client: MachineClient = {
      request: () => Promise.reject(new Error("HTTP not expected")),
      requestJson: () => Promise.reject(new Error("HTTP not expected")),
      connectWebSocket(path, options) {
        connections.push({ path, maxPayload: options?.maxPayload });
        const socket = new WebSocket(`${webSocketServerUrl(remoteServer)}${path}`, options);
        sockets.push(socket);
        return socket;
      },
    };
    let resolveRemoteClient: ((value: MachineClient | undefined) => void) | undefined;
    const remoteClient = new Promise<MachineClient | undefined>((resolve) => { resolveRemoteClient = resolve; });
    registerMachineProxyRoutes(app, { remoteClient: () => remoteClient }, admissions);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const browser = new WebSocket(`${fastifyServerUrl(app)}/api/machines/remote%20one/plugin-backends/terminal/projects/p%201/workspaces/w%201/channels/terminal.attach`);
    sockets.push(browser);
    await waitForOpen(browser);

    const firstPreludeFrame = "not-json-and-not-an-envelope";
    const secondPreludeFrame = "still-not-a-channel-envelope";
    browser.send(firstPreludeFrame);
    browser.send(secondPreludeFrame);
    resolveRemoteClient?.(client);
    const remote = await remoteConnected;
    await expect(remote.messages.next()).resolves.toBe(firstPreludeFrame);
    await expect(remote.messages.next()).resolves.toBe(secondPreludeFrame);

    const ready = serializePluginBackendChannelReadyEnvelope();
    const browserReady = nextMessage(browser);
    remote.socket.send(ready);
    await expect(browserReady).resolves.toBe(ready);
    expect(admissions.activeCount).toBe(1);

    await delay(350);
    const lateClientData = serializePluginBackendChannelDataEnvelope({ sequence: 2 });
    browser.send(lateClientData);
    await expect(remote.messages.next()).resolves.toBe(lateClientData);
    const lateServerData = serializePluginBackendChannelDataEnvelope({ sequence: 3 });
    const browserData = nextMessage(browser);
    remote.socket.send(lateServerData);
    await expect(browserData).resolves.toBe(lateServerData);
    expect(connections).toEqual([{
      path: "/api/plugin-backends/terminal/projects/p%201/workspaces/w%201/channels/terminal.attach",
      maxPayload: PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES,
    }]);

    const browserClosed = nextClose(browser);
    const remoteClosed = nextClose(remote.socket);
    browser.close(1000, "complete");
    await Promise.all([browserClosed, remoteClosed]);
    await vi.waitFor(() => { expect(admissions.activeCount).toBe(0); });
  });

  it("shares one attributed aggregate admission cap across local and federated routes", async () => {
    const admissions = new PluginBackendChannelProxyAdmissionPool({ maxTotal: 1, transportConnectTimeoutMs: 1_000 });
    const localUpstreamConnected = new Promise<WebSocket>((resolve) => {
      remoteServer.once("connection", (socket) => {
        sockets.push(socket);
        resolve(socket);
      });
    });
    registerPluginBackendChannelProxyRoutes(app, {
      connectWebSocket(path, options) {
        const socket = new WebSocket(`${webSocketServerUrl(remoteServer)}${path}`, options);
        sockets.push(socket);
        return socket;
      },
    }, "/api", admissions);
    const remoteClient = vi.fn(() => Promise.resolve(undefined));
    registerMachineProxyRoutes(app, { remoteClient }, admissions);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const local = new WebSocket(`${fastifyServerUrl(app)}/api/plugin-backends/terminal/projects/local-project/workspaces/local-workspace/channels/attach`);
    sockets.push(local);
    await waitForOpen(local);
    const localUpstream = await localUpstreamConnected;
    expect(admissions.activeCount).toBe(1);

    const federated = new WebSocket(`${fastifyServerUrl(app)}/api/machines/remote-one/plugin-backends/other.tools/projects/remote-project/workspaces/remote-workspace/channels/attach`);
    sockets.push(federated);
    const errorFrame = nextMessage(federated).then((text) => parsePluginBackendChannelServerEnvelope(text));
    const federatedClosed = nextClose(federated);
    await waitForOpen(federated);
    const rejection = await errorFrame;
    expect(rejection).toMatchObject({ kind: "error", code: "admission-denied" });
    if (rejection.kind !== "error") throw new Error("Expected aggregate admission error");
    expect(rejection.message).toContain("other.tools in remote-project/remote-workspace via remote-one");
    await expect(federatedClosed).resolves.toMatchObject({ code: 1006 });
    expect(remoteClient).not.toHaveBeenCalled();
    expect(admissions.activeCount).toBe(1);

    const localClosed = nextClose(local);
    const upstreamClosed = nextClose(localUpstream);
    local.close(1000, "complete");
    await Promise.all([localClosed, upstreamClosed]);
    await vi.waitFor(() => { expect(admissions.activeCount).toBe(0); });
  });

  it("reserves federation admission before resolving the remote client", async () => {
    const admissions = new PluginBackendChannelProxyAdmissionPool({ maxTotal: 1, transportConnectTimeoutMs: 1_000 });
    let remoteClientCalls = 0;
    let resolveRemoteClientCalled: (() => void) | undefined;
    const remoteClientCalled = new Promise<void>((resolve) => { resolveRemoteClientCalled = resolve; });
    const unresolved = new Promise<MachineClient | undefined>(() => { /* Keep remote lookup pending. */ });
    registerMachineProxyRoutes(app, {
      remoteClient() {
        remoteClientCalls += 1;
        resolveRemoteClientCalled?.();
        return unresolved;
      },
    }, admissions);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const first = new WebSocket(`${fastifyServerUrl(app)}/api/machines/remote/plugin-backends/terminal/projects/p/workspaces/w/channels/attach`);
    sockets.push(first);
    await waitForOpen(first);
    await remoteClientCalled;
    expect(admissions.activeCount).toBe(1);

    const second = new WebSocket(`${fastifyServerUrl(app)}/api/machines/remote/plugin-backends/terminal/projects/p/workspaces/w/channels/attach`);
    sockets.push(second);
    const errorFrame = nextMessage(second).then((text) => parsePluginBackendChannelServerEnvelope(text));
    const rejected = nextClose(second);
    await waitForOpen(second);
    await expect(errorFrame).resolves.toMatchObject({ kind: "error", code: "admission-denied" });
    await expect(rejected).resolves.toMatchObject({ code: 1006 });
    expect(remoteClientCalls).toBe(1);
    expect(admissions.activeCount).toBe(1);

    const firstClosed = nextClose(first);
    first.close();
    await firstClosed;
    await vi.waitFor(() => { expect(admissions.activeCount).toBe(0); });
  });

  it("accounts the invalid local-machine channel alias through physical teardown", async () => {
    const admissions = new PluginBackendChannelProxyAdmissionPool({ maxTotal: 1 });
    const remoteClient = vi.fn(() => Promise.resolve(undefined));
    registerMachineProxyRoutes(app, { remoteClient }, admissions);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const browser = new WebSocket(`${fastifyServerUrl(app)}/api/machines/local/plugin-backends/terminal/projects/p/workspaces/w/channels/attach`);
    sockets.push(browser);
    const closed = nextClose(browser);
    await waitForOpen(browser);
    await vi.waitFor(() => { expect(admissions.activeCount).toBe(1); });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    await vi.waitFor(() => { expect(admissions.activeCount).toBe(0); });
    expect(remoteClient).not.toHaveBeenCalled();
  });

  it("times out unresolved federation setup and releases its admission", async () => {
    const admissions = new PluginBackendChannelProxyAdmissionPool({ transportConnectTimeoutMs: 30 });
    registerMachineProxyRoutes(app, {
      remoteClient: () => new Promise<MachineClient | undefined>(() => { /* Keep remote lookup pending. */ }),
    }, admissions);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const browser = new WebSocket(`${fastifyServerUrl(app)}/api/machines/remote/plugin-backends/terminal/projects/p/workspaces/w/channels/attach`);
    sockets.push(browser);
    const closed = nextClose(browser);
    await waitForOpen(browser);
    const closeEvent = await closed;
    expect(closeEvent.code).toBe(1011);
    expect(closeEvent.reason).toContain("transport connection timed out");
    await vi.waitFor(() => { expect(admissions.activeCount).toBe(0); });
  });

  it("does not create a late upstream after the downstream cancels remote resolution", async () => {
    const admissions = new PluginBackendChannelProxyAdmissionPool({ transportConnectTimeoutMs: 1_000 });
    const connectWebSocket = vi.fn(() => {
      throw new Error("Late connection must not be attempted");
    });
    const client: MachineClient = {
      request: () => Promise.reject(new Error("HTTP not expected")),
      requestJson: () => Promise.reject(new Error("HTTP not expected")),
      connectWebSocket,
    };
    let resolveRemoteClient: ((value: MachineClient | undefined) => void) | undefined;
    const remoteClient = new Promise<MachineClient | undefined>((resolve) => { resolveRemoteClient = resolve; });
    const remoteClientCalled = vi.fn(() => remoteClient);
    registerMachineProxyRoutes(app, { remoteClient: remoteClientCalled }, admissions);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const browser = new WebSocket(`${fastifyServerUrl(app)}/api/machines/remote/plugin-backends/terminal/projects/p/workspaces/w/channels/attach`);
    sockets.push(browser);
    await waitForOpen(browser);
    await vi.waitFor(() => { expect(remoteClientCalled).toHaveBeenCalledOnce(); });
    const closed = nextClose(browser);
    browser.close(1000, "cancel lookup");
    await closed;
    await vi.waitFor(() => { expect(admissions.activeCount).toBe(0); });

    resolveRemoteClient?.(client);
    await delay(0);
    expect(connectWebSocket).not.toHaveBeenCalled();
    expect(admissions.activeCount).toBe(0);
  });

  it("fails a bounded prelude overflow visibly and releases without opening upstream", async () => {
    const admissions = new PluginBackendChannelProxyAdmissionPool({ transportConnectTimeoutMs: 1_000 });
    const remoteClient = vi.fn(() => new Promise<MachineClient | undefined>(() => { /* Keep lookup pending. */ }));
    registerMachineProxyRoutes(app, { remoteClient }, admissions);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const browser = new WebSocket(`${fastifyServerUrl(app)}/api/machines/remote/plugin-backends/terminal/projects/p/workspaces/w/channels/attach`);
    sockets.push(browser);
    const closed = nextClose(browser);
    await waitForOpen(browser);
    browser.send(serializePluginBackendChannelOpenEnvelope("terminal-r1", null));
    for (let sequence = 0; sequence < PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES; sequence += 1) {
      browser.send(serializePluginBackendChannelDataEnvelope({ sequence }));
    }

    const closeEvent = await closed;
    expect(closeEvent.code).toBe(1013);
    expect(closeEvent.reason).toContain("prelude queue limit");
    await vi.waitFor(() => { expect(admissions.activeCount).toBe(0); });
    expect(remoteClient).toHaveBeenCalledOnce();
  });

  it("releases exactly once after abnormal upstream teardown", async () => {
    const admissions = new PluginBackendChannelProxyAdmissionPool({ maxTotal: 1 });
    const remoteConnected = new Promise<WebSocket>((resolve) => {
      remoteServer.once("connection", (socket) => {
        sockets.push(socket);
        resolve(socket);
      });
    });
    const client: MachineClient = {
      request: () => Promise.reject(new Error("HTTP not expected")),
      requestJson: () => Promise.reject(new Error("HTTP not expected")),
      connectWebSocket(path, options) {
        const socket = new WebSocket(`${webSocketServerUrl(remoteServer)}${path}`, options);
        sockets.push(socket);
        return socket;
      },
    };
    registerMachineProxyRoutes(app, { remoteClient: () => Promise.resolve(client) }, admissions);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const browser = new WebSocket(`${fastifyServerUrl(app)}/api/machines/remote/plugin-backends/terminal/projects/p/workspaces/w/channels/attach`);
    sockets.push(browser);
    const browserClosed = nextClose(browser);
    await waitForOpen(browser);
    const remote = await remoteConnected;
    await vi.waitFor(() => { expect(admissions.activeCount).toBe(1); });

    remote.terminate();
    await expect(browserClosed).resolves.toMatchObject({ code: 1011 });
    await vi.waitFor(() => { expect(admissions.activeCount).toBe(0); });
    expect(admissions.activeCount).toBe(0);
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

function socketMessages(socket: WebSocket): { next(): Promise<string> } {
  const queued: string[] = [];
  const waiters: ((value: string) => void)[] = [];
  socket.on("message", (data, isBinary) => {
    if (isBinary) throw new Error("Expected text frame");
    const value = rawDataToString(data);
    const waiter = waiters.shift();
    if (waiter === undefined) queued.push(value);
    else waiter(value);
  });
  return {
    next: () => {
      const value = queued.shift();
      return value === undefined
        ? new Promise<string>((resolve) => { waiters.push(resolve); })
        : Promise.resolve(value);
    },
  };
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
