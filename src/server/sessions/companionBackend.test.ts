import { resolve as resolvePath } from "node:path";
import { createEventBus } from "../../piSdk.js";
import { describe, expect, it, vi } from "vitest";
import { createCompanionBackend, type ServerPluginPeerRequestContextV5, type ServerPluginPeerV5, type JsonValue } from "../../server-plugin-api.js";
import { PluginBackendRegistry } from "../plugins/pluginBackendRegistry.js";
import type { ServerPluginPairedBackendContribution } from "../plugins/serverPluginRuntime.js";
import { bindCompanionBackend } from "./companionBackend.js";
import { PLUGIN_BACKEND_CHANNEL_DRAIN_TIMEOUT_MS, PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES, PLUGIN_BACKEND_CHANNEL_SERVER_TO_BROWSER_QUEUE_MAX_BYTES, serializePluginBackendChannelDataEnvelope, serializePluginBackendChannelReadyEnvelope } from "../../shared/pluginBackendProtocol.js";

const project = { id: "p", name: "Host project", path: resolvePath("/host"), createdAt: "2026-01-01" };
const workspace = { id: "w", projectId: "p", path: resolvePath("/host/work"), label: "Host workspace", isMain: false };

function fixture(backend: ServerPluginPeerV5, apiVersion: 3 | 5 = 5, options: { channelCallbackTimeoutMs?: number } = {}) {
  const bus = createEventBus();
  const contribution: ServerPluginPairedBackendContribution = {
    apiVersion, pluginId: "paired", moduleRevision: "r1", pluginName: "Paired",
    packageRoot: "/plugin", source: "test", scope: "local", backend,
  };
  const requireProject = vi.fn((id: string) => {
    if (id !== project.id) throw new Error("Project not found");
    return Promise.resolve(project);
  });
  const resolve = vi.fn(() => Promise.resolve({ status: "folder" as const, projectId: project.id, workspaces: [workspace], diagnostics: [] }));
  const registry = new PluginBackendRegistry({ contributions: [contribution], workspaces: { resolve }, ...options });
  const detach = bindCompanionBackend(bus, { backends: registry, contributions: [contribution], projects: { requireProject } });
  return { bus, contribution, requireProject, resolve, registry, detach, discover: () => createCompanionBackend(bus, "paired") };
}

describe("bindCompanionBackend", () => {
  it("late-binds startup authority only at discovery, then retains that snapshot", async () => {
    const f = fixture({ request: () => "captured" });
    f.detach();
    let ready = false;
    const provider = vi.fn(() => {
      if (!ready) throw new Error("Registry not ready");
      return { backends: f.registry, contributions: [f.contribution], projects: { requireProject: f.requireProject } };
    });
    const detach = bindCompanionBackend(f.bus, provider);
    expect(provider).not.toHaveBeenCalled();
    expect(() => f.discover()).toThrow("Registry not ready");
    ready = true;
    const captured = f.discover();
    ready = false;
    await expect(captured.forScope({ kind: "machine" }).request?.("read", null)).resolves.toBe("captured");
    expect(provider).toHaveBeenCalledTimes(2);
    expect(() => f.discover()).toThrow("Registry not ready");
    detach();
  });
  it("captures v5 revision and capabilities without legacy or missing fallback", async () => {
    const f = fixture({ request: () => "ok" });
    const backend = f.discover();
    expect(backend.machineId).toBe("local");
    const peer = backend.forScope({ kind: "machine" });
    expect(peer).not.toHaveProperty("openChannel");
    f.contribution.moduleRevision = "r2";
    f.contribution.backend = { openChannel: () => ({ receive: vi.fn() }) };
    expect(backend.forScope({ kind: "machine" })).not.toHaveProperty("openChannel");
    await expect(peer.request?.("read", null)).rejects.toMatchObject({ code: "stale-plugin-revision" });
    expect(() => createCompanionBackend(f.bus, "missing")).toThrow("No active v5");
    f.detach();
    const legacy = fixture({ request: () => null }, 3);
    expect(() => legacy.discover()).toThrow("No active v5");
    legacy.detach();
  });

  it("resolves each project through current host authority and workspaces through the registry", async () => {
    const request = vi.fn(({ scope }: ServerPluginPeerRequestContextV5) => scope.kind);
    const f = fixture({ request });
    const backend = f.discover();
    const selection = { kind: "workspace", projectId: "p", workspaceId: "w", project: { path: "/forged" } } as const;
    const peer = backend.forScope(selection);
    await expect(peer.request?.("read", null)).resolves.toBe("workspace");
    expect(request.mock.calls[0]?.[0].scope).toEqual({ kind: "workspace", project: { id: project.id, name: project.name, path: project.path }, workspace });
    expect(f.requireProject).toHaveBeenCalledWith("p");
    expect(f.resolve).toHaveBeenCalledWith(project, expect.any(AbortSignal));
    await backend.forScope({ kind: "project", projectId: "p" }).request?.("read", null);
    await backend.forScope({ kind: "machine" }).request?.("read", null);
    expect(request.mock.calls.map(([context]) => context.scope.kind)).toEqual(["workspace", "project", "machine"]);
    await expect(backend.forScope({ kind: "project", projectId: "unknown" }).request?.("read", null)).rejects.toThrow("Project not found");
    expect(() => backend.forScope({ kind: "project", projectId: "" })).toThrow("Invalid");
    f.detach();
  });

  it("snapshots request and channel input before asynchronous project resolution", async () => {
    const f = fixture({ request: ({ input }) => input, openChannel: ({ input, send }) => {
      send(input);
      return { receive: vi.fn() };
    } });
    let resolveProject!: (value: typeof project) => void;
    f.requireProject.mockImplementation(() => new Promise((resolve) => { resolveProject = resolve; }));
    const peer = f.discover().forScope({ kind: "project", projectId: "p" });
    const input = { title: "original" };
    const pending = peer.request?.("read", input);
    input.title = "changed";
    resolveProject(project);
    await expect(pending).resolves.toEqual({ title: "original" });
    const onData = vi.fn();
    const opening = peer.openChannel?.("watch", input, { onData });
    input.title = "changed again";
    resolveProject(project);
    const channel = await opening;
    expect(onData).toHaveBeenCalledWith({ title: "changed" });
    channel?.close();
    await channel?.closed;
    f.detach();
  });

  it("buffers opening server frames until success, preserving snapshots and order", async () => {
    let started!: () => void;
    const openingStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let send!: (data: JsonValue) => void;
    const f = fixture({ openChannel: async (context) => {
      send = context.send;
      const frame = { title: "original" };
      send(frame);
      frame.title = "changed";
      started();
      await blocked;
      send("second");
      return { receive: vi.fn() };
    } });
    const onData = vi.fn();
    try {
      const opening = f.discover().forScope({ kind: "machine" }).openChannel?.("watch", null, { onData });
      await openingStarted;
      expect(onData).not.toHaveBeenCalled();
      release();
      const channel = await opening;
      expect(onData.mock.calls).toEqual([[{ title: "original" }], ["second"]]);
      send("third");
      expect(onData.mock.calls).toEqual([[{ title: "original" }], ["second"], ["third"]]);
      channel?.close();
      await channel?.closed;
    } finally { release(); f.detach(); await f.registry.closeAll(); }
  });

  it("discards server frames when opening fails after sending", async () => {
    let started!: () => void;
    const openingStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture({ openChannel: async ({ send }) => {
      send("must not escape");
      started();
      await blocked;
      throw new Error("open failed after send");
    } });
    const onData = vi.fn();
    try {
      const opening = f.discover().forScope({ kind: "machine" }).openChannel?.("watch", null, { onData });
      const rejected = expect(opening).rejects.toThrow("open failed after send");
      await openingStarted;
      expect(onData).not.toHaveBeenCalled();
      release();
      await rejected;
      expect(onData).not.toHaveBeenCalled();
    } finally { release(); f.detach(); await f.registry.closeAll(); }
  });

  it.each([
    { label: "frame count", data: null },
    { label: "serialized byte size", data: "x".repeat(60 * 1024) },
  ])("bounds pre-ready server frames by $label like the browser transport", async ({ data }) => {
    const bytes = Buffer.byteLength(serializePluginBackendChannelDataEnvelope(data), "utf8");
    const readyBytes = Buffer.byteLength(serializePluginBackendChannelReadyEnvelope(), "utf8");
    const accepted = Math.min(PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES - 1,
      Math.floor((PLUGIN_BACKEND_CHANNEL_SERVER_TO_BROWSER_QUEUE_MAX_BYTES - readyBytes) / bytes));
    for (const overflow of [false, true]) {
      const close = vi.fn();
      const f = fixture({ openChannel: ({ send }) => {
        for (let index = 0; index < accepted; index++) send(data);
        if (overflow) {
          // Even a plugin swallowing the send error cannot publish a failed open.
          try { send(data); } catch { /* Registry retains the send failure. */ }
        }
        return { receive: vi.fn(), close };
      } });
      const onData = vi.fn();
      try {
        const opening = f.discover().forScope({ kind: "machine" }).openChannel?.("watch", null, { onData });
        if (overflow) {
          await expect(opening).rejects.toThrow("queue limit was exceeded");
          expect(onData).not.toHaveBeenCalled();
        } else {
          const channel = await opening;
          expect(onData).toHaveBeenCalledTimes(accepted);
          channel?.close();
          await channel?.closed;
        }
      } finally { f.detach(); await f.registry.closeAll(); }
      expect(close).toHaveBeenCalledOnce();
    }
  });

  it("closes a ready channel rather than rejecting open when a buffered data consumer throws", async () => {
    const close = vi.fn();
    const f = fixture({ openChannel: ({ send }) => {
      send("one"); send("two");
      return { receive: vi.fn(), close };
    } });
    const onData = vi.fn(() => { throw new Error("consumer failed"); });
    try {
      const channel = await f.discover().forScope({ kind: "machine" }).openChannel?.("watch", null, { onData });
      await expect(channel?.closed).resolves.toMatchObject({ wasClean: false, error: { code: "protocol-error", message: "consumer failed" } });
      expect(onData).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally { f.detach(); await f.registry.closeAll(); }
  });

  it.each([
    { label: "frame count", data: null, accepted: 128 },
    { label: "byte size", data: "x".repeat(60 * 1024), accepted: 17 },
  ])("bounds the channel receive queue by $label", async ({ data, accepted }) => {
    const f = fixture({ openChannel: () => ({ receive: vi.fn() }) });
    const channel = await f.discover().forScope({ kind: "machine" }).openChannel?.("watch", null, { onData: vi.fn() });
    if (channel === undefined) throw new Error("Expected channel");
    for (let index = 0; index < accepted; index++) channel.send(data);
    expect(() => { channel.send(data); }).toThrow("queue is full");
    await expect(channel.closed).resolves.toMatchObject({ code: 1008, wasClean: false });
    f.detach();
  });

  it("cancels requests, revokes retained facades, and leaves unrelated event connections intact", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let signal: AbortSignal | undefined;
    const f = fixture({ request: (context) => {
      signal = context.signal;
      started();
      return new Promise(vi.fn());
    } });
    const backend = f.discover();
    const peer = backend.forScope({ kind: "machine" });
    const pending = peer.request?.("wait", null);
    const rejected = expect(pending).rejects.toThrow("detached");
    await ready;
    const message = vi.fn();
    f.bus.on("other", message);
    f.detach(); f.detach();
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(() => backend.forScope({ kind: "machine" })).toThrow("detached");
    await expect(peer.request?.("again", null)).rejects.toThrow("detached");
    expect(() => f.discover()).toThrow("hosted PI WEB");
    f.bus.emit("other", null);
    expect(message).toHaveBeenCalledOnce();
  });

  it("honors caller cancellation before project resolution and dispatch", async () => {
    const request = vi.fn(() => null);
    const f = fixture({ request });
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    await expect(f.discover().forScope({ kind: "project", projectId: "p" }).request?.("read", null, { signal: controller.signal })).rejects.toThrow("caller cancelled");
    expect(f.requireProject).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    f.detach();
  });

  it("cancels while resolving project authority without dispatching late work", async () => {
    const request = vi.fn(() => null);
    const f = fixture({ request });
    let resolveProject!: (value: typeof project) => void;
    f.requireProject.mockImplementation(() => new Promise((resolve) => { resolveProject = resolve; }));
    const controller = new AbortController();
    const pending = f.discover().forScope({ kind: "project", projectId: "p" }).request?.("read", null, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await rejected;
    resolveProject(project);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    f.detach();
  });

  it("cancels channel opening and cleans up a late plugin result", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const close = vi.fn();
    const f = fixture({ openChannel: async ({ send }) => {
      send("discard on cancellation");
      started();
      await blocked;
      return { receive: vi.fn(), close };
    } });
    const peer = f.discover().forScope({ kind: "machine" });
    if (peer.openChannel === undefined) throw new Error("Expected channels");
    const onData = vi.fn();
    const pending = peer.openChannel("watch", null, { onData });
    const rejected = expect(pending).rejects.toThrow("detached");
    await ready;
    expect(onData).not.toHaveBeenCalled();
    f.detach();
    await rejected;
    release();
    await vi.waitFor(() => { expect(close).toHaveBeenCalledOnce(); });
    expect(onData).not.toHaveBeenCalled();
  });

  it("supports channel-only peers, early data, ordered frames, and runtime cancellation", async () => {
    const receive = vi.fn<(data: JsonValue, signal: AbortSignal) => void>();
    const close = vi.fn();
    let signal: AbortSignal | undefined;
    const f = fixture({ openChannel: (context) => {
      signal = context.signal;
      context.send("ready");
      return { receive, close };
    } });
    const peer = f.discover().forScope({ kind: "workspace", projectId: "p", workspaceId: "w" });
    expect(peer).not.toHaveProperty("request");
    if (peer.openChannel === undefined) throw new Error("Expected channels");
    const onData = vi.fn();
    const channel = await peer.openChannel("watch", null, { onData });
    expect(onData).toHaveBeenCalledWith("ready");
    channel.send("one"); channel.send("two");
    await vi.waitFor(() => { expect(receive).toHaveBeenCalledTimes(2); });
    expect(receive.mock.calls.map(([data]) => data)).toEqual(["one", "two"]);
    f.detach();
    await expect(channel.closed).resolves.toMatchObject({ wasClean: false });
    expect(signal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(() => { channel.send("late"); }).toThrow("closed");
  });

  it("drains accepted frames and their replies before a clean close", async () => {
    const receive = vi.fn();
    const close = vi.fn();
    const f = fixture({ openChannel: ({ send }) => ({
      receive: (frame) => { receive(frame); send(frame); },
      close,
    }) });
    const onData = vi.fn();
    const channel = await f.discover().forScope({ kind: "machine" }).openChannel?.("watch", null, { onData });
    if (channel === undefined) throw new Error("Expected channel");
    channel.send("one");
    channel.send("two");
    channel.close("done");
    expect(() => { channel.send("late"); }).toThrow("closed");
    await expect(channel.closed).resolves.toMatchObject({ code: 1000, wasClean: true });
    expect(receive.mock.calls).toEqual([["one"], ["two"]]);
    expect(onData.mock.calls).toEqual([["one"], ["two"]]);
    expect(close).toHaveBeenCalledOnce();
    f.detach();
  });

  it("waits for an in-flight receive on clean close and bounds its drain", async () => {
    vi.useFakeTimers();
    let received!: () => void;
    const started = new Promise<void>((resolve) => { received = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const close = vi.fn();
    const f = fixture({ openChannel: () => ({ receive: () => { received(); return blocked; }, close }) }, 5, {
      channelCallbackTimeoutMs: PLUGIN_BACKEND_CHANNEL_DRAIN_TIMEOUT_MS * 2,
    });
    try {
      const channel = await f.discover().forScope({ kind: "machine" }).openChannel?.("watch", null, { onData: vi.fn() });
      if (channel === undefined) throw new Error("Expected channel");
      channel.send("one");
      await started;
      channel.close();
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(PLUGIN_BACKEND_CHANNEL_DRAIN_TIMEOUT_MS);
      release();
      await expect(channel.closed).resolves.toMatchObject({ code: 1011, wasClean: false, error: { code: "drain-failed" } });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      release();
      f.detach();
      await f.registry.closeAll();
      vi.useRealTimers();
    }
  });

  it("propagates receive failures and cleans channels on caller cancellation and clean close", async () => {
    const close = vi.fn();
    const f = fixture({ openChannel: () => ({ receive: () => { throw new Error("bad frame"); }, close }) });
    const peer = f.discover().forScope({ kind: "machine" });
    if (peer.openChannel === undefined) throw new Error("Expected channels");
    const failed = await peer.openChannel("watch", null, { onData: vi.fn() });
    failed.send(null);
    await expect(failed.closed).resolves.toMatchObject({ code: 1011, wasClean: false, error: { code: "receive-failed" } });
    const controller = new AbortController();
    const cancelled = await peer.openChannel("watch", null, { onData: vi.fn(), signal: controller.signal });
    controller.abort();
    await expect(cancelled.closed).resolves.toMatchObject({ wasClean: false });
    const clean = await peer.openChannel("watch", null, { onData: vi.fn() });
    clean.close("done"); clean.close();
    await expect(clean.closed).resolves.toEqual({ code: 1000, reason: "done", wasClean: true });
    expect(close).toHaveBeenCalledTimes(3);
    f.detach();
  });
});
