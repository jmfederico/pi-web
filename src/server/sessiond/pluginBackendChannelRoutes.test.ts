import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import { terminalOutputFrames } from "../../../pi-web-plugins/terminal/server/server-plugin.js";
import type { JsonValue } from "../../server-plugin-api.js";
import {
  parsePluginBackendChannelServerEnvelope,
  PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES,
  PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES,
  serializePluginBackendChannelDataEnvelope,
  serializePluginBackendChannelOpenEnvelope,
} from "../../shared/pluginBackendProtocol.js";
import { PluginBackendRegistry } from "../plugins/pluginBackendRegistry.js";
import type { ServerPluginPairedBackendContribution } from "../plugins/serverPluginRuntime.js";
import type { Project } from "../types.js";
import { WorkspaceProviderRegistry } from "../workspaces/workspaceProviderRegistry.js";
import { installPluginBackendChannelWebSocketPayloadLimit } from "../webSocketBridge.js";
import { registerPluginBackendChannelRoutes } from "./pluginBackendChannelRoutes.js";

const project: Project = {
  id: "project one",
  name: "Project",
  path: "/repo",
  createdAt: "2026-08-02T00:00:00.000Z",
};

let app: FastifyInstance;
let sockets: WebSocket[];

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  installPluginBackendChannelWebSocketPayloadLimit(app.websocketServer);
  sockets = [];
});

afterEach(async () => {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
  }
  await app.close();
});

describe("session daemon plugin backend channels", () => {
  it("opens after scope resolution, preserves ready ordering, exchanges data, and cleans up once", async () => {
    const workspaces = workspaceRegistry();
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected workspace");
    const received: JsonValue[] = [];
    const close = vi.fn();
    const registry = new PluginBackendRegistry({
      contributions: [contribution(({ send }) => {
        send({ type: "output", data: "replay" });
        return {
          receive: (data) => { received.push(data); },
          close,
        };
      })],
      workspaces,
    });
    registerPluginBackendChannelRoutes(app, { projects: projectReader(), backends: registry });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const socket = connect(workspaceId);
    const messages = socketMessages(socket);
    await waitForOpen(socket);
    socket.send(serializePluginBackendChannelOpenEnvelope("terminal-r1", { terminalId: "t1" }));

    expect(parsePluginBackendChannelServerEnvelope(await messages.next())).toEqual({ version: 1, kind: "ready" });
    expect(parsePluginBackendChannelServerEnvelope(await messages.next())).toEqual({
      version: 1,
      kind: "data",
      data: { type: "output", data: "replay" },
    });
    socket.send(serializePluginBackendChannelDataEnvelope({ type: "input", data: "pwd\n" }));
    await vi.waitFor(() => { expect(received).toEqual([{ type: "input", data: "pwd\n" }]); });

    const closed = nextClose(socket);
    socket.close(1000, "panel closed");
    await closed;
    await vi.waitFor(() => { expect(registry.activeChannelCount()).toBe(0); });
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: 1000, reason: "panel closed" }));
  });

  it("drains plugin frames in order before clean completion closes the real socket", async () => {
    const workspaces = workspaceRegistry();
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected workspace");
    const registry = new PluginBackendRegistry({
      contributions: [contribution(({ send }) => {
        send({ sequence: 1 });
        send({ sequence: 2 });
        return { receive: () => undefined, closed: Promise.resolve() };
      })],
      workspaces,
    });
    registerPluginBackendChannelRoutes(app, { projects: projectReader(), backends: registry });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const socket = connect(workspaceId);
    const messages = socketMessages(socket);
    const closed = nextClose(socket);
    await waitForOpen(socket);
    socket.send(serializePluginBackendChannelOpenEnvelope("terminal-r1", null));

    expect(parsePluginBackendChannelServerEnvelope(await messages.next())).toEqual({ version: 1, kind: "ready" });
    expect(parsePluginBackendChannelServerEnvelope(await messages.next())).toEqual({ version: 1, kind: "data", data: { sequence: 1 } });
    expect(parsePluginBackendChannelServerEnvelope(await messages.next())).toEqual({ version: 1, kind: "data", data: { sequence: 2 } });
    await expect(closed).resolves.toMatchObject({ code: 1000 });
    await vi.waitFor(() => { expect(registry.activeChannelCount()).toBe(0); });
  });

  it("drains accepted asynchronous receives in order before a clean browser close", async () => {
    const workspaces = workspaceRegistry();
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected workspace");
    const gates = [deferred(), deferred()];
    const events: string[] = [];
    const close = vi.fn(() => { events.push("close"); });
    const registry = new PluginBackendRegistry({
      contributions: [contribution(() => ({
        async receive(data) {
          if (!isJsonRecord(data) || typeof data["sequence"] !== "number") throw new Error("Expected sequence frame");
          const sequence = data["sequence"];
          events.push(`receive:${String(sequence)}:start`);
          const gate = gates[sequence - 1];
          if (gate === undefined) throw new Error("Missing receive gate");
          await gate.promise;
          events.push(`receive:${String(sequence)}:end`);
        },
        close,
      }))],
      workspaces,
    });
    registerPluginBackendChannelRoutes(app, { projects: projectReader(), backends: registry });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const socket = connect(workspaceId);
    const messages = socketMessages(socket);
    const closed = nextClose(socket);
    await waitForOpen(socket);
    socket.send(serializePluginBackendChannelOpenEnvelope("terminal-r1", null));
    expect(parsePluginBackendChannelServerEnvelope(await messages.next())).toMatchObject({ kind: "ready" });
    socket.send(serializePluginBackendChannelDataEnvelope({ sequence: 1 }));
    socket.send(serializePluginBackendChannelDataEnvelope({ sequence: 2 }), () => { socket.close(1000, "browser complete"); });

    await vi.waitFor(() => { expect(events).toEqual(["receive:1:start"]); });
    expect(close).not.toHaveBeenCalled();
    expect(registry.activeChannelCount()).toBe(1);
    gates[0]?.resolve();
    await vi.waitFor(() => { expect(events).toEqual(["receive:1:start", "receive:1:end", "receive:2:start"]); });
    expect(close).not.toHaveBeenCalled();
    gates[1]?.resolve();

    await expect(closed).resolves.toMatchObject({ code: 1000 });
    await vi.waitFor(() => { expect(events).toEqual([
      "receive:1:start",
      "receive:1:end",
      "receive:2:start",
      "receive:2:end",
      "close",
    ]); });
    await vi.waitFor(() => { expect(registry.activeChannelCount()).toBe(0); });
  });

  it("attaches and reconnects with the full worst-case escaped Terminal replay", async () => {
    const workspaces = workspaceRegistry();
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected workspace");
    const replay = "\u0000".repeat(200_000);
    const replayFrames = terminalOutputFrames(replay, true);
    expect(replayFrames.length).toBeLessThan(128);
    const registry = new PluginBackendRegistry({
      contributions: [contribution(({ send }) => {
        for (const frame of replayFrames) send(frame);
        send({ type: "output", data: "__LIVE_AFTER_REPLAY__", replay: false });
        return { receive: () => undefined };
      })],
      workspaces,
    });
    registerPluginBackendChannelRoutes(app, { projects: projectReader(), backends: registry });
    await app.listen({ host: "127.0.0.1", port: 0 });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const socket = connect(workspaceId);
      const messages = socketMessages(socket);
      await waitForOpen(socket);
      socket.send(serializePluginBackendChannelOpenEnvelope("terminal-r1", null));
      expect(parsePluginBackendChannelServerEnvelope(await messages.next())).toEqual({ version: 1, kind: "ready" });
      let received = "";
      for (const expectedFrame of replayFrames) {
        const frame = parsePluginBackendChannelServerEnvelope(await messages.next());
        expect(frame).toEqual({ version: 1, kind: "data", data: expectedFrame });
        if (frame.kind !== "data" || !isJsonRecord(frame.data)) throw new Error("Expected Terminal replay data frame");
        const data = frame.data["data"];
        if (typeof data !== "string") throw new Error("Expected Terminal replay text");
        received += data;
      }
      expect(received).toBe(replay);
      expect(parsePluginBackendChannelServerEnvelope(await messages.next())).toEqual({
        version: 1,
        kind: "data",
        data: { type: "output", data: "__LIVE_AFTER_REPLAY__", replay: false },
      });
      const closed = nextClose(socket);
      socket.close(1000, `replay-${String(attempt)}`);
      await closed;
      await vi.waitFor(() => { expect(registry.activeChannelCount()).toBe(0); });
    }
  });

  it("reserves admission before open and releases no-open sockets exactly once", async () => {
    const workspaces = workspaceRegistry();
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected workspace");
    const registry = new PluginBackendRegistry({
      contributions: [contribution(() => ({ receive: () => undefined }))],
      workspaces,
      channelMaxTotal: 1,
    });
    registerPluginBackendChannelRoutes(app, { projects: projectReader(), backends: registry });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const waiting = connect(workspaceId);
    await waitForOpen(waiting);
    await vi.waitFor(() => { expect(registry.activeChannelCount()).toBe(1); });

    const denied = connect(workspaceId);
    const deniedMessages = socketMessages(denied);
    const deniedClose = nextClose(denied);
    await waitForOpen(denied);
    expect(parsePluginBackendChannelServerEnvelope(await deniedMessages.next())).toMatchObject({
      kind: "error",
      code: "admission-denied",
    });
    await expect(deniedClose).resolves.toMatchObject({ code: 1006 });
    expect(registry.activeChannelCount()).toBe(1);

    waiting.close(1000, "retry");
    await vi.waitFor(() => { expect(registry.activeChannelCount()).toBe(0); });
    const retry = connect(workspaceId);
    await waitForOpen(retry);
    await vi.waitFor(() => { expect(registry.activeChannelCount()).toBe(1); });
    retry.close(1000, "done");
    await vi.waitFor(() => { expect(registry.activeChannelCount()).toBe(0); });
  });

  it("enforces open and post-open data payload limits in the WebSocket receiver", async () => {
    const workspaces = workspaceRegistry();
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected workspace");
    const registry = new PluginBackendRegistry({
      contributions: [contribution(() => ({ receive: () => undefined }))],
      workspaces,
    });
    registerPluginBackendChannelRoutes(app, { projects: projectReader(), backends: registry });
    app.get("/unrelated-session-socket", { websocket: true }, (socket) => {
      socket.on("message", (data, isBinary) => { socket.send(data, { binary: isBinary }); });
    });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const oversizedOpen = connect(workspaceId);
    const oversizedOpenClose = nextClose(oversizedOpen);
    await waitForOpen(oversizedOpen);
    oversizedOpen.send("x".repeat(PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES + 1));
    await expect(oversizedOpenClose).resolves.toMatchObject({ code: 1009 });

    const oversizedData = connect(workspaceId);
    const messages = socketMessages(oversizedData);
    await waitForOpen(oversizedData);
    oversizedData.send(serializePluginBackendChannelOpenEnvelope("terminal-r1", null));
    expect(parsePluginBackendChannelServerEnvelope(await messages.next())).toMatchObject({ kind: "ready" });
    const oversizedDataClose = nextClose(oversizedData);
    oversizedData.send("x".repeat(PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES + 1));
    await expect(oversizedDataClose).resolves.toMatchObject({ code: 1009 });
    await vi.waitFor(() => { expect(registry.activeChannelCount()).toBe(0); });

    const unrelated = new WebSocket(`${serverUrl(app)}/unrelated-session-socket`);
    sockets.push(unrelated);
    await waitForOpen(unrelated);
    const unrelatedPayload = "s".repeat(PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES + 1);
    const echoed = socketMessages(unrelated);
    unrelated.send(unrelatedPayload);
    await expect(echoed.next()).resolves.toBe(unrelatedPayload);
  });

  it("attributes stale revisions, plugin receive failures, and binary input before closing", async () => {
    const workspaces = workspaceRegistry();
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected workspace");
    const registry = new PluginBackendRegistry({
      contributions: [contribution(() => ({ receive: () => { throw new Error("input exploded"); } }))],
      workspaces,
    });
    registerPluginBackendChannelRoutes(app, { projects: projectReader(), backends: registry });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const stale = connect(workspaceId);
    const staleMessages = socketMessages(stale);
    await waitForOpen(stale);
    stale.send(serializePluginBackendChannelOpenEnvelope("old", null));
    expect(parsePluginBackendChannelServerEnvelope(await staleMessages.next())).toMatchObject({
      kind: "error",
      code: "stale-plugin-revision",
    });
    await nextClose(stale);

    const failed = connect(workspaceId);
    const failedMessages = socketMessages(failed);
    await waitForOpen(failed);
    failed.send(serializePluginBackendChannelOpenEnvelope("terminal-r1", null));
    expect(parsePluginBackendChannelServerEnvelope(await failedMessages.next())).toMatchObject({ kind: "ready" });
    failed.send(serializePluginBackendChannelDataEnvelope({ type: "input" }));
    const receiveFailure = parsePluginBackendChannelServerEnvelope(await failedMessages.next());
    expect(receiveFailure).toMatchObject({ kind: "error", code: "receive-failed" });
    if (receiveFailure.kind !== "error") throw new Error("Expected receive failure envelope");
    expect(receiveFailure.message).toContain("input exploded");
    await nextClose(failed);

    const binary = connect(workspaceId);
    const binaryMessages = socketMessages(binary);
    await waitForOpen(binary);
    binary.send(Buffer.from("not text"), { binary: true });
    expect(parsePluginBackendChannelServerEnvelope(await binaryMessages.next())).toMatchObject({
      kind: "error",
      code: "binary-frame",
    });
    await nextClose(binary);
  });
});

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

function workspaceRegistry(): WorkspaceProviderRegistry {
  return new WorkspaceProviderRegistry({
    contributions: [],
    logger: { warn: vi.fn() },
    pathInspector: () => true,
  });
}

function projectReader() {
  return {
    requireProject: (projectId: string) => projectId === project.id
      ? Promise.resolve(project)
      : Promise.reject(new Error("Project not found")),
  };
}

function connect(workspaceId: string): WebSocket {
  const socket = new WebSocket(`${serverUrl(app)}/plugin-backends/terminal/projects/${encodeURIComponent(project.id)}/workspaces/${encodeURIComponent(workspaceId)}/channels/terminal.attach`);
  sockets.push(socket);
  return socket;
}

function socketMessages(socket: WebSocket): { next(): Promise<string> } {
  const queued: string[] = [];
  const waiters: ((value: string) => void)[] = [];
  socket.on("message", (data, isBinary) => {
    if (isBinary) throw new Error("Expected text channel frame");
    const text = rawDataToString(data);
    const waiter = waiters.shift();
    if (waiter === undefined) queued.push(text);
    else waiter(text);
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

function serverUrl(instance: FastifyInstance): string {
  const address = instance.server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${String(address.port)}`;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", () => { resolve(); });
    socket.once("error", reject);
  });
}

function nextClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve({ code: 1006, reason: "already closed" });
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => { resolve({ code, reason: rawDataToString(reason) }); });
  });
}

function isJsonRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}
