import { randomBytes } from "node:crypto";
import { createConnection, Socket as NetSocket } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import type { JsonValue } from "../server-plugin-api.js";
import {
  parsePluginBackendChannelServerEnvelope,
  serializePluginBackendChannelDataEnvelope,
  serializePluginBackendChannelOpenEnvelope,
} from "../shared/pluginBackendProtocol.js";
import { registerMachineProxyRoutes } from "./machines/machineProxyRoutes.js";
import type { MachineClient } from "./machines/machineClient.js";
import { PluginBackendChannelProxyAdmissionPool } from "./plugins/pluginBackendChannelProxyAdmission.js";
import { registerPluginBackendChannelProxyRoutes } from "./plugins/pluginBackendChannelProxyRoutes.js";
import { PluginBackendRegistry } from "./plugins/pluginBackendRegistry.js";
import type { ServerPluginPairedBackendContribution } from "./plugins/serverPluginRuntime.js";
import { registerPluginBackendChannelRoutes } from "./sessiond/pluginBackendChannelRoutes.js";
import type { Project } from "./types.js";
import { installPluginBackendChannelWebSocketPayloadLimit } from "./webSocketBridge.js";
import { WorkspaceProviderRegistry } from "./workspaces/workspaceProviderRegistry.js";

const project: Project = {
  id: "project-one",
  name: "Project",
  path: "/repo",
  createdAt: "2026-09-01T00:00:00.000Z",
};
const channelKinds = ["direct", "local-proxy", "federated"] as const;
type ChannelKind = (typeof channelKinds)[number];

const liveTopologies = new Set<ChannelTopology>();

afterEach(async () => {
  await Promise.all([...liveTopologies].map(async (topology) => { await topology.close(); }));
  liveTopologies.clear();
});

describe("plugin backend channel end-to-end teardown and receive drain", () => {
  it.each(channelKinds)("drains asynchronous receives before clean close through %s", async (kind) => {
    const gates = [deferred(), deferred()];
    const events: string[] = [];
    const close = vi.fn(() => { events.push("close"); });
    const topology = await createTopology(() => ({
      async receive(data) {
        const sequence = frameSequence(data);
        events.push(`receive:${String(sequence)}:start`);
        const gate = gates[sequence - 1];
        if (gate === undefined) throw new Error("Missing receive gate");
        await gate.promise;
        events.push(`receive:${String(sequence)}:end`);
      },
      close,
    }));
    const browser = topology.connect(kind);
    const messages = socketMessages(browser);
    const closed = nextClose(browser);
    await waitForOpen(browser);
    browser.send(serializePluginBackendChannelOpenEnvelope("terminal-r1", null));
    expect(parsePluginBackendChannelServerEnvelope(await messages.next())).toMatchObject({ kind: "ready" });
    browser.send(serializePluginBackendChannelDataEnvelope({ sequence: 1 }));
    browser.send(serializePluginBackendChannelDataEnvelope({ sequence: 2 }), () => {
      browser.close(1000, "browser complete");
    });

    await vi.waitFor(() => { expect(events).toEqual(["receive:1:start"]); });
    expect(close).not.toHaveBeenCalled();
    expect(topology.registry.activeChannelCount()).toBe(1);
    gates[0]?.resolve();
    await vi.waitFor(() => {
      expect(events).toEqual(["receive:1:start", "receive:1:end", "receive:2:start"]);
    });
    expect(close).not.toHaveBeenCalled();
    gates[1]?.resolve();

    await expect(closed).resolves.toMatchObject({ code: 1000 });
    await vi.waitFor(() => {
      expect(events).toEqual([
        "receive:1:start",
        "receive:1:end",
        "receive:2:start",
        "receive:2:end",
        "close",
      ]);
      expect(topology.registry.activeChannelCount()).toBe(0);
      expect(topology.activeProxyAdmissions()).toEqual({ local: 0, federated: 0 });
    });
  });

  it.each(["local-proxy", "federated"] as const)(
    "forwards semantically invalid bounded text through %s for sessiond rejection",
    async (kind) => {
      const topology = await createTopology(() => ({ receive: () => undefined }));
      const browser = topology.connect(kind);
      const messages = socketMessages(browser);
      const closed = nextClose(browser);
      await waitForOpen(browser);

      browser.send("{");

      const rejection = parsePluginBackendChannelServerEnvelope(await messages.next());
      expect(rejection).toMatchObject({ kind: "error", code: "invalid-frame" });
      if (rejection.kind !== "error") throw new Error("Expected sessiond protocol rejection");
      expect(rejection.message).toContain("must be valid JSON");
      await expect(closed).resolves.toMatchObject({ code: 1008 });
      await vi.waitFor(() => {
        expect(topology.registry.activeChannelCount()).toBe(0);
        expect(topology.activeProxyAdmissions()).toEqual({ local: 0, federated: 0 });
      });
    },
  );

  it("retains admission until concurrent shutdown physically terminates a paused peer", async () => {
    const topology = await createTopology(() => ({ receive: () => undefined }));
    const browser = topology.connect("direct");
    const messages = socketMessages(browser);
    await waitForOpen(browser);
    browser.send(serializePluginBackendChannelOpenEnvelope("terminal-r1", null));
    expect(parsePluginBackendChannelServerEnvelope(await messages.next())).toMatchObject({ kind: "ready" });
    const transport: unknown = Reflect.get(browser, "_socket");
    if (!(transport instanceof NetSocket)) throw new Error("Expected browser TCP socket");
    transport.pause();

    const shutdown = topology.registry.closeAll("integration shutdown");
    await delay(50);
    expect(topology.registry.activeChannelCount()).toBe(1);
    expect(topology.physicalSocketCounts("direct").sessiond).toBe(1);

    await shutdown;
    await vi.waitFor(() => {
      expect(topology.registry.activeChannelCount()).toBe(0);
      expect(topology.physicalSocketCounts("direct").sessiond).toBe(0);
    }, { timeout: 3_000 });
    transport.destroy();
  });

  it.each(channelKinds)("physically bounds paused no-open and abnormal sockets through %s", async (kind) => {
    const topology = await createTopology(() => ({ receive: () => undefined }), { maxTotal: 1 });
    const rawSockets: NetSocket[] = [];
    try {
      const first = await openRawWebSocket(topology.url(kind));
      rawSockets.push(first);
      await vi.waitFor(() => {
        expect(topology.physicalSocketCounts(kind)).toEqual(expectedPhysicalCounts(kind, 1));
        expect(topology.registry.activeChannelCount()).toBe(1);
      });

      const denied = await Promise.all(Array.from({ length: 3 }, async () => openRawWebSocket(topology.url(kind))));
      rawSockets.push(...denied);
      await vi.waitFor(() => {
        expect(topology.physicalSocketCounts(kind)).toEqual(expectedPhysicalCounts(kind, 1));
        expect(topology.registry.activeChannelCount()).toBe(1);
        expect(topology.activeProxyAdmissions()).toEqual(expectedProxyAdmissions(kind, 1));
      }, { timeout: 3_000 });

      first.write(maskedTextFrame("{"));
      await vi.waitFor(() => {
        expect(topology.physicalSocketCounts(kind)).toEqual(expectedPhysicalCounts(kind, 0));
        expect(topology.registry.activeChannelCount()).toBe(0);
        expect(topology.activeProxyAdmissions()).toEqual({ local: 0, federated: 0 });
      }, { timeout: 4_000 });
    } finally {
      for (const socket of rawSockets) socket.destroy();
    }
  });
});

interface ChannelTopology {
  readonly registry: PluginBackendRegistry;
  connect(kind: ChannelKind): WebSocket;
  url(kind: ChannelKind): string;
  physicalSocketCounts(kind: ChannelKind): { sessiond: number; local: number; federated: number };
  activeProxyAdmissions(): { local: number; federated: number };
  close(): Promise<void>;
}

async function createTopology(
  openChannel: NonNullable<ServerPluginPairedBackendContribution["backend"]["openChannel"]>,
  options: { maxTotal?: number } = {},
): Promise<ChannelTopology> {
  const workspaces = new WorkspaceProviderRegistry({
    contributions: [],
    logger: { warn: vi.fn() },
    pathInspector: () => true,
  });
  const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
  if (workspaceId === undefined) throw new Error("Expected kernel workspace");
  const registry = new PluginBackendRegistry({
    contributions: [contribution(openChannel)],
    workspaces,
    ...(options.maxTotal === undefined ? {} : { channelMaxTotal: options.maxTotal }),
  });
  const localAdmissions = new PluginBackendChannelProxyAdmissionPool({
    ...(options.maxTotal === undefined ? {} : { maxTotal: options.maxTotal }),
  });
  const federatedAdmissions = new PluginBackendChannelProxyAdmissionPool({
    ...(options.maxTotal === undefined ? {} : { maxTotal: options.maxTotal }),
  });
  const outboundSockets = new Set<WebSocket>();
  const browserSockets = new Set<WebSocket>();

  const sessiond = await websocketApp();
  registerPluginBackendChannelRoutes(sessiond, {
    projects: { requireProject: (projectId) => projectId === project.id ? Promise.resolve(project) : Promise.reject(new Error("Project not found")) },
    backends: registry,
  });
  await sessiond.listen({ host: "127.0.0.1", port: 0 });

  const local = await websocketApp();
  registerPluginBackendChannelProxyRoutes(local, {
    connectWebSocket(path, socketOptions) {
      const socket = new WebSocket(`${serverUrl(sessiond)}${path}`, socketOptions);
      outboundSockets.add(socket);
      return socket;
    },
  }, "/api", localAdmissions);
  await local.listen({ host: "127.0.0.1", port: 0 });

  const remoteClient: MachineClient = {
    request: () => Promise.reject(new Error("HTTP not expected")),
    requestJson: () => Promise.reject(new Error("HTTP not expected")),
    connectWebSocket(path, socketOptions) {
      const socket = new WebSocket(`${serverUrl(local)}${path}`, socketOptions);
      outboundSockets.add(socket);
      return socket;
    },
  };
  const federated = await websocketApp();
  registerMachineProxyRoutes(federated, {
    remoteClient: (machineId) => Promise.resolve(machineId === "remote" ? remoteClient : undefined),
  }, federatedAdmissions);
  await federated.listen({ host: "127.0.0.1", port: 0 });

  const path = `/plugin-backends/terminal/projects/${encodeURIComponent(project.id)}/workspaces/${encodeURIComponent(workspaceId)}/channels/terminal.attach`;
  let closed = false;
  const topology: ChannelTopology = {
    registry,
    connect(kind) {
      const socket = new WebSocket(topology.url(kind));
      browserSockets.add(socket);
      return socket;
    },
    url(kind) {
      if (kind === "direct") return `${serverUrl(sessiond)}${path}`;
      if (kind === "local-proxy") return `${serverUrl(local)}/api${path}`;
      return `${serverUrl(federated)}/api/machines/remote${path}`;
    },
    physicalSocketCounts(kind) {
      return {
        sessiond: sessiond.websocketServer.clients.size,
        local: kind === "direct" ? 0 : local.websocketServer.clients.size,
        federated: kind === "federated" ? federated.websocketServer.clients.size : 0,
      };
    },
    activeProxyAdmissions: () => ({ local: localAdmissions.activeCount, federated: federatedAdmissions.activeCount }),
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of [...browserSockets, ...outboundSockets]) {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
      }
      await Promise.allSettled([federated.close(), local.close(), sessiond.close()]);
    },
  };
  liveTopologies.add(topology);
  return topology;
}

async function websocketApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  installPluginBackendChannelWebSocketPayloadLimit(app.websocketServer);
  return app;
}

function contribution(
  openChannel: NonNullable<ServerPluginPairedBackendContribution["backend"]["openChannel"]>,
): ServerPluginPairedBackendContribution {
  return {
    pluginId: "terminal",
    pluginName: "Terminal",
    packageRoot: "/plugins/terminal",
    source: "fixture",
    scope: "bundled",
    moduleRevision: "terminal-r1",
    backend: { version: 1, request: () => null, openChannel },
  };
}

function frameSequence(data: JsonValue): number {
  if (!isJsonRecord(data) || typeof data["sequence"] !== "number") throw new Error("Expected sequence frame");
  return data["sequence"];
}

function isJsonRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectedPhysicalCounts(kind: ChannelKind, count: number): { sessiond: number; local: number; federated: number } {
  return {
    sessiond: count,
    local: kind === "direct" ? 0 : count,
    federated: kind === "federated" ? count : 0,
  };
}

function expectedProxyAdmissions(kind: ChannelKind, count: number): { local: number; federated: number } {
  return {
    local: kind === "direct" ? 0 : count,
    federated: kind === "federated" ? count : 0,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
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
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve({ code: 1006, reason: "" });
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => { resolve({ code, reason: reason.toString("utf8") }); });
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

async function openRawWebSocket(urlValue: string): Promise<NetSocket> {
  const url = new URL(urlValue);
  const port = Number(url.port);
  const socket = createConnection({ host: url.hostname, port });
  socket.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    let response = "";
    const onError = (error: Error): void => { reject(error); };
    const onData = (data: Buffer): void => {
      response += data.toString("latin1");
      if (!response.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      socket.off("error", onError);
      if (!response.startsWith("HTTP/1.1 101")) {
        reject(new Error(`WebSocket upgrade failed: ${response.split("\r\n", 1)[0] ?? "unknown response"}`));
        return;
      }
      socket.pause();
      resolve();
    };
    socket.once("error", onError);
    socket.on("data", onData);
    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write([
        `GET ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"));
    });
  });
  return socket;
}

function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.length >= 126) throw new Error("Raw test frame helper supports only short frames");
  const mask = randomBytes(4);
  const frame = Buffer.alloc(2 + mask.length + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (let index = 0; index < payload.length; index += 1) {
    frame[6 + index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return frame;
}

function serverUrl(instance: FastifyInstance): string {
  const address = instance.server.address();
  if (address === null || typeof address === "string") throw new Error("Expected server address");
  return `ws://127.0.0.1:${String(address.port)}`;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}
