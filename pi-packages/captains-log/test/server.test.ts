import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import plugin from "../src/server.js";
import { LogStore, logScope } from "../src/store.js";
import { CAPTAIN_REPLY, CAPTAIN_REQUEST, SOURCE_REQUEST, SOURCE_REPLY, isLogEntry, type LogEntry } from "../src/browser/protocol.js";
import { entryFrames, isCaptainClientFrame, isCaptainServerFrame, type CaptainServerFrame } from "../src/browser/channelProtocol.js";
import { PI_WEB_HOST_PI_SESSIONS_CAPABILITY, type ServerPluginCapabilityResolver } from "../../../src/server-plugin-api.js";

it("pushes admission, native receipt, running and saved completion; scope/channel closure never cancels admitted work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "captain-channel-"));
  const lifetime = new AbortController();
  const bus = new EventEmitter();
  const closeNative = vi.fn();
  const create = vi.fn(() => Promise.resolve({ sessionId: "session" }));
  let nativeId = "";
  let started: () => void = () => { throw new Error("Deferred not initialized"); };
  const nativeStarted = new Promise<void>((resolve) => { started = resolve; });
  const activation = await plugin.activate({
    apiVersion: 3, pluginId: "captain", packageRoot: directory, dataDirectory: directory, settings: {}, signal: new AbortController().signal, lifetimeSignal: lifetime.signal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, execFile: () => Promise.reject(new Error("Unexpected exec")),
  });
  // Generic host capability resolution is the sole type-erased boundary in this fake.
  const capabilities: ServerPluginCapabilityResolver = {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/consistent-type-assertions
    resolve: <Value>(capability: Parameters<ServerPluginCapabilityResolver["resolve"]>[0]) => (capability === PI_WEB_HOST_PI_SESSIONS_CAPABILITY ? { create } : {
      connect: () => Promise.resolve({ signal: lifetime.signal, close: closeNative,
        on(name: string, handler: (data: unknown) => void) { bus.on(name, handler); return () => bus.off(name, handler); },
        emit(name: string, data: { requestId: string }) {
          if (name === SOURCE_REQUEST) { bus.emit(SOURCE_REPLY, { requestId: data.requestId, status: "completed", text: "Source reply" }); return; }
          expect(name).toBe(CAPTAIN_REQUEST);
          expect(data).toEqual({ requestId: data.requestId, text: "Source reply" });
          nativeId = data.requestId;
          bus.emit(CAPTAIN_REPLY, { requestId: nativeId, status: "accepted" });
          bus.emit(CAPTAIN_REPLY, { requestId: nativeId, status: "running" });
          started();
        },
      }),
    }) as Value,
  };
  await required(activation.start?.bind(activation))({ capabilities, signal: new AbortController().signal });
  const scope = { project: { id: "project", name: "Project", path: directory }, workspace: { id: "workspace", projectId: "project", path: directory, label: "Workspace", isMain: true } };
  const peer = required(activation.peer);
  const frames: CaptainServerFrame[] = [];
  const observerFrames: CaptainServerFrame[] = [];
  let saved: () => void = () => { throw new Error("Deferred not initialized"); };
  const finalSaved = new Promise<void>((resolve) => { saved = resolve; });
  const otherFrames: CaptainServerFrame[] = [];
  const opening = new AbortController();
  const open = (target: CaptainServerFrame[], signal: AbortSignal, workspace = scope.workspace) => required(peer.openChannel?.bind(peer))({ ...scope, workspace, operation: "log", input: null, signal, send(data) { if (!isCaptainServerFrame(data)) throw new Error("Invalid frame"); target.push(structuredClone(data)); if (data.type === "entry" && data.saved && data.entry.status === "completed") saved(); } });
  try {
    const channel = await open(frames, opening.signal);
    const observer = await open(observerFrames, new AbortController().signal);
    const other = await open(otherFrames, new AbortController().signal, { ...scope.workspace, id: "other" });
    await expect(required(peer.request?.bind(peer))({ ...scope, operation: "ask", input: "Why?", signal: lifetime.signal })).rejects.toThrow("translations require");
    await channel.receive({ type: "translate", requestId: "11111111-1111-4111-8111-111111111111", sourceSessionId: "source" }, new AbortController().signal);
    await nativeStarted;
    expect(frames[0]).toMatchObject({ type: "admitted" });
    expect(JSON.stringify(frames)).toContain("Native companion received request");
    expect(JSON.stringify(frames)).toContain("Native Pi agent running");
    await observer.receive({ type: "translate", requestId: "22222222-2222-4222-8222-222222222222", sourceSessionId: "source" }, lifetime.signal);
    expect(observerFrames.at(-1)).toMatchObject({ type: "rejected" });
    opening.abort();
    await required(channel.close?.bind(channel))({ code: 1000, reason: "browser closed", signal: lifetime.signal });
    const count = frames.length;
    expect(closeNative).toHaveBeenCalledTimes(1);
    bus.emit(CAPTAIN_REPLY, { requestId: nativeId, status: "completed", text: "Arrr, saved evidence" });
    await finalSaved;
    expect(frames).toHaveLength(count);
    expect(otherFrames).toEqual([]);
    expect(observerFrames.some((frame) => frame.type === "entry" && frame.saved && frame.entry.status === "completed")).toBe(true);
    expect(observerFrames.at(-1)).toEqual({ type: "text", id: nativeId, text: "Arrr, saved evidence" });
    expect(closeNative).toHaveBeenCalledTimes(2);
    const snapshot = await required(peer.request?.bind(peer))({ ...scope, operation: "list", input: null, signal: lifetime.signal });
    expect(snapshot).toEqual([expect.objectContaining({ id: nativeId, status: "completed", text: "" })]);
    const read = await required(peer.request?.bind(peer))({ ...scope, operation: "read", input: nativeId, signal: lifetime.signal });
    expect(read).toMatchObject({ text: "Arrr, saved evidence", sessionId: "session" });
    expect(create).toHaveBeenCalledTimes(1);
    await required(observer.close?.bind(observer))({ code: 1000, reason: "done", signal: lifetime.signal });
    await required(other.close?.bind(other))({ code: 1000, reason: "done", signal: lifetime.signal });
  } finally { lifetime.abort(); await required(activation.dispose?.bind(activation))(new AbortController().signal); await rm(directory, { recursive: true, force: true }); }
});

it("bounds escaped reply chunks below the host frame limit without losing text", () => {
  const text = "\u0000".repeat(48_000);
  const frames = entryFrames({ id: "11111111-1111-4111-8111-111111111111", createdAt: "today", sessionId: "session", question: "\u0000".repeat(8000), status: "completed", stages: [], text }, true);
  expect(frames.every((frame) => Buffer.byteLength(JSON.stringify(frame)) < 65536)).toBe(true);
  expect(frames.flatMap((frame) => frame.type === "text" ? [frame.text] : []).join("")).toBe(text);
});

function required<T>(value: T | undefined): T { if (value === undefined) throw new Error("Missing test capability"); return value; }


it("automatically replaces only an exactly unhosted pirate session and durably reuses it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "captain-recovery-"));
  const lifetime = new AbortController();
  const store = new LogStore(directory);
  const scopeKey = logScope("project", "workspace");
  const archived: LogEntry = { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", createdAt: "2099-01-01T00:00:00.000Z", sessionId: "old", question: "Old question", status: "completed", stages: [], text: "Old evidence" };
  const interrupted: LogEntry = { ...archived, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", createdAt: "2099-01-01T00:00:00.001Z", status: "running" };
  await store.save(scopeKey, archived);
  await store.save(scopeKey, interrupted);
  const create = vi.fn(() => Promise.resolve({ sessionId: "new" }));
  let genericFailure = false;
  let companionFailure = false;
  let sourceUnavailable = false;
  let oldHosted = true;
  const connect = vi.fn(({ sessionId }: { sessionId: string }) => {
    if ((sessionId === "old" && !oldHosted) || (sessionId === "source" && sourceUnavailable)) return Promise.reject(new Error("Selected session is not hosted in this workspace on this machine"));
    if (genericFailure && sessionId !== "source") return Promise.reject(new Error("Transport refused"));
    const bus = new EventEmitter();
    return Promise.resolve({ signal: lifetime.signal, close: vi.fn(),
      on(name: string, handler: (data: unknown) => void) { bus.on(name, handler); return () => bus.off(name, handler); },
      emit(name: string, data: { requestId: string }) {
        expect(name).toBe(sessionId === "source" ? SOURCE_REQUEST : CAPTAIN_REQUEST);
        bus.emit(sessionId === "source" ? SOURCE_REPLY : CAPTAIN_REPLY, companionFailure && sessionId !== "source"
          ? { requestId: data.requestId, status: "failed", error: "Provider refused" }
          : { requestId: data.requestId, status: "completed", text: "Fresh evidence" });
      },
    });
  });
  const capabilities: ServerPluginCapabilityResolver = {
    // Generic capability resolution is the sole type-erased host boundary.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/consistent-type-assertions
    resolve: <Value>(capability: Parameters<ServerPluginCapabilityResolver["resolve"]>[0]) => (capability === PI_WEB_HOST_PI_SESSIONS_CAPABILITY ? { create } : { connect }) as Value,
  };
  const activate = async () => {
    const activation = await plugin.activate({ apiVersion: 3, pluginId: "captain", packageRoot: directory, dataDirectory: directory, settings: {}, signal: lifetime.signal, lifetimeSignal: lifetime.signal,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, execFile: () => Promise.reject(new Error("Unexpected exec")),
    });
    await required(activation.start?.bind(activation))({ capabilities, signal: lifetime.signal });
    return activation;
  };
  let activation = await activate();
  const scope = { project: { id: "project", name: "Project", path: directory }, workspace: { id: "workspace", projectId: "project", path: directory, label: "Workspace", isMain: true } };
  const ask = async () => {
    const peer = required(activation.peer);
    let finish: (entry: LogEntry) => void = () => { throw new Error("Deferred not initialized"); };
    const finished = new Promise<LogEntry>((resolve) => { finish = resolve; });
    const channel = await required(peer.openChannel?.bind(peer))({ ...scope, operation: "log", input: null, signal: lifetime.signal,
      send(data) { if (isCaptainServerFrame(data) && data.type === "entry" && data.saved && data.entry.status !== "running") finish(data.entry); },
    });
    await channel.receive({ type: "translate", requestId: "11111111-1111-4111-8111-111111111111", sourceSessionId: "source" }, lifetime.signal);
    const entry = await finished;
    await required(channel.close?.bind(channel))({ code: 1000, reason: "done", signal: lifetime.signal });
    return store.read(scopeKey, entry.id);
  };
  try {
    const peer = required(activation.peer);
    expect(await required(peer.request?.bind(peer))({ ...scope, operation: "read", input: interrupted.id, signal: lifetime.signal })).toMatchObject({ status: "interrupted", failureCode: "interrupted" });
    expect(create).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    // A human-opened old conversation is available through ordinary events; no resume API.
    expect(await ask()).toMatchObject({ sessionId: "old", status: "completed" });
    expect(create).not.toHaveBeenCalled();
    oldHosted = false;
    expect(await ask()).toMatchObject({ sessionId: "new", status: "completed", sourceSessionId: "source", question: "Translate last reply" });
    expect(await ask()).toMatchObject({ sessionId: "new", status: "completed" });
    await required(activation.dispose?.bind(activation))(lifetime.signal);
    activation = await activate();
    expect(await ask()).toMatchObject({ sessionId: "new", status: "completed" });
    genericFailure = true;
    expect(await ask()).toMatchObject({ sessionId: "new", status: "failed", failureCode: "request-failed" });
    genericFailure = false;
    companionFailure = true;
    expect(await ask()).toMatchObject({ sessionId: "new", status: "failed", failureCode: "request-failed" });
    sourceUnavailable = true;
    expect(await ask()).toMatchObject({ sessionId: "new", status: "failed", failureCode: "request-failed" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls.map(([selection]) => selection.sessionId)).toEqual(["source", "old", "source", "old", "new", "source", "new", "source", "new", "source", "new", "source", "new", "source"]);
    expect(await store.read(scopeKey, archived.id)).toEqual(archived);
    expect(await store.list(scopeKey)).toHaveLength(9);
  } finally { lifetime.abort(); await required(activation.dispose?.bind(activation))(new AbortController().signal); await rm(directory, { recursive: true, force: true }); }
});

it("accepts legacy records and validates optional recovery fields", () => {
  const entry = { id: "11111111-1111-4111-8111-111111111111", createdAt: "today", sessionId: "old", question: "Why?", status: "failed", stages: [], text: "Failure" };
  expect(isLogEntry(entry)).toBe(true);
  expect(isLogEntry({ ...entry, failureCode: "session-unavailable" })).toBe(true);
  expect(isLogEntry({ ...entry, failureCode: "unknown" })).toBe(false);
  const frame = { type: "translate", requestId: entry.id, sourceSessionId: "source" };
  expect(isCaptainClientFrame(frame)).toBe(true);
  expect(isCaptainClientFrame({ ...frame, sourceSessionId: "" })).toBe(false);
  expect(isCaptainClientFrame({ ...frame, sourceSessionId: "x".repeat(513) })).toBe(false);
  expect(isCaptainClientFrame({ ...frame, type: "ask" })).toBe(false);
});
