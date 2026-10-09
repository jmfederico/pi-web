import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectBrowserMessageResponse, projectBrowserTranscriptSnapshot } from "../browserMessageProjection.js";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import * as attachmentService from "./attachmentService.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionService } from "./piSessionService.js";
import { fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";
import { SessionArchiveStore } from "./sessionArchiveStore.js";
import { SessionMediaIndex } from "./sessionMediaIndex.js";
import { registerSessionRoutes } from "./sessionRoutes.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
const image = (data = png) => ({ type: "image" as const, data, mimeType: "image/png" });
const idOf = (data: string) => createHash("sha256").update(`image/png\0${data}`).digest("hex");
let temp: string;
const services: PiSessionService[] = [];

beforeEach(async () => { temp = await mkdtemp(join(tmpdir(), "pi-web-media-")); });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await rm(temp, { recursive: true, force: true });
});

describe("PiSessionService media", () => {
  it("roundtrips projected messages, retains all runtime branches, and reconstructs evicted bytes without changing Pi messages", async () => {
    const first = Object.freeze(image());
    const other = Object.freeze(image(Buffer.from("other").toString("base64")));
    const message = Object.freeze({ role: "user", content: Object.freeze([first]) });
    const branch = [{ type: "message", id: "selected", message }];
    const entries = [...branch, { type: "message", id: "other-branch", message: { role: "toolResult", content: [other] } }];
    const original = structuredClone(entries);
    const fake = fakeRuntime("session-1", { sessionManager: fakeSessionManager("/workspace", { getBranch: () => branch, getEntries: () => entries }) });
    const hub = new SessionEventHub(new SessionMediaIndex({ maxMediaEntries: 1 }));
    const service = new PiSessionService(hub, {
      agentDir: temp, modelRuntime: testModelRuntime,
      archiveStore: new SessionArchiveStore(join(temp, "archives.json")),
      createAgentRuntime: runtimeCreator(fake.runtime), sessionManager: sessionGateway([sessionRecord("session-1")]), heartbeatIntervalMs: 60_000,
    });
    services.push(service);
    const ref = sessionRef("session-1");
    const page = await service.messages(ref);
    expect(page.messages).toEqual([{ ...message, entryId: "selected" }]); // Service/Pi history stays inline.
    const projected = projectBrowserMessageResponse(page, (block) => hub.mediaIndex.reference(ref, block));
    expect(projected.messages).toEqual([{ ...message, entryId: "selected", content: [{ type: "image", mediaId: idOf(png), mimeType: "image/png", byteSize: Buffer.from(png, "base64").byteLength }] }]);
    expect(await service.media(ref, idOf(png))).toEqual({ data: Buffer.from(png, "base64"), mimeType: "image/png" });
    expect(await service.media(ref, idOf(other.data))).toEqual({ data: Buffer.from(other.data, "base64"), mimeType: "image/png" });
    expect(hub.mediaIndex.get(ref, idOf(png))).toBeUndefined();
    expect(await service.media(ref, idOf(png))).toEqual({ data: Buffer.from(png, "base64"), mimeType: "image/png" });
    expect(entries).toEqual(original);
    expect(await service.media(ref, "0".repeat(64))).toBeUndefined();
    await expect(service.media(sessionRef(ref.id, "/wrong-workspace"), idOf(png))).rejects.toThrow("Session not found");
  });

  it("resolves transient live tool.update/end images and snapshot partials through the same index", async () => {
    const state: { streamingMessage?: unknown } = {};
    const fake = fakeRuntime("session-1", { state });
    const hub = new SessionEventHub();
    const service = new PiSessionService(hub, {
      agentDir: temp, modelRuntime: testModelRuntime,
      archiveStore: new SessionArchiveStore(join(temp, "archives.json")),
      createAgentRuntime: runtimeCreator(fake.runtime), sessionManager: sessionGateway([sessionRecord("session-1")]), heartbeatIntervalMs: 60_000,
    });
    services.push(service);
    const ref = sessionRef("session-1");
    await service.status(ref);
    for (const type of ["tool_execution_update", "tool_execution_end"]) {
      hub.mediaIndex.clear();
      const block = image();
      const result = { content: [block] };
      fake.emit({ type, toolCallId: "call", toolName: "read", partialResult: result, result, isError: false });
      expect(await service.media(ref, idOf(png))).toEqual({ data: Buffer.from(png, "base64"), mimeType: "image/png" });
      expect(result.content).toEqual([image()]);
    }
    const partial = { role: "assistant", content: [image(), { type: "thinking", thinking: "working", thinkingSignature: "secret" }] };
    state.streamingMessage = partial;
    fake.session.isStreaming = true;
    fake.emit({ type: "message_start", message: partial });
    const snapshot = projectBrowserTranscriptSnapshot(await service.transcriptSnapshot(ref), (block) => hub.mediaIndex.reference(ref, block));
    expect(snapshot.partial).toMatchObject({ content: [{ type: "image", mediaId: idOf(png) }, { type: "thinking", thinking: "working" }] });
    expect(JSON.stringify(snapshot)).not.toContain(png);
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(partial.content).toEqual([image(), { type: "thinking", thinking: "working", thinkingSignature: "secret" }]);
    await service.dispose();
    expect(hub.mediaIndex.get(ref, idOf(png))).toBeUndefined();
  });

  it("isolates actual valid sessions copied with the same id across cwds and rejects abbreviated ids", async () => {
    const store = join(temp, "sessions");
    const cwdA = join(temp, "workspace-a");
    const cwdB = join(temp, "workspace-b");
    await Promise.all([store, cwdA, cwdB].map((path) => mkdir(path)));
    const refA = sessionRef("copied-session", cwdA);
    const refB = sessionRef(refA.id, cwdB);
    const pathA = join(store, "2026-01-01_copied-session.jsonl");
    const pathB = join(store, "2026-01-02_copied-session.jsonl");
    const transcript = (cwd: string, content: unknown) => [
      { type: "session", version: 3, id: refA.id, cwd, timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", id: "entry", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content } },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n";
    await writeFile(pathA, transcript(cwdA, [image()]));
    await writeFile(pathB, transcript(cwdB, "no image in this copy"));
    const gateway = createPiSessionManagerGateway({ agentDir: temp, env: { PI_CODING_AGENT_SESSION_DIR: store } });
    expect(await gateway.resolveSessionFile(cwdA, refA.id)).toEqual({ ...refA, path: pathA });
    expect(await gateway.resolveSessionFile(cwdB, refB.id)).toEqual({ ...refB, path: pathB });
    const readEntries = vi.spyOn(gateway, "readEntries");
    const open = vi.spyOn(gateway, "open");
    const createAgentRuntime = vi.fn(() => { throw new Error("Media must not open runtimes"); });
    const decode = vi.fn((source: string) => Buffer.from(source, "base64"));
    const hub = new SessionEventHub(new SessionMediaIndex({ decode }));
    const service = new PiSessionService(hub, {
      agentDir: temp, modelRuntime: testModelRuntime, sessionManager: gateway, createAgentRuntime,
      archiveStore: new SessionArchiveStore(join(temp, "archives.json")), heartbeatIntervalMs: 60_000,
    });
    services.push(service);
    const app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    registerSessionRoutes(app, service, hub);
    const url = (ref: { id: string; cwd: string }) => `/sessions/${encodeURIComponent(ref.id)}/media/${idOf(png)}?cwd=${encodeURIComponent(ref.cwd)}`;
    try {
      hub.mediaIndex.reference(refA, image()); // Only A owns a binding, despite both sessions being valid.
      expect((await app.inject({ method: "GET", url: url(refB) })).statusCode).toBe(404);
      expect(decode).not.toHaveBeenCalled();
      const response = await app.inject({ method: "GET", url: url({ ...refA, cwd: `${cwdA}/./` }) });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(Buffer.from(png, "base64"));
      expect(decode).toHaveBeenCalledOnce();
      expect((await app.inject({ method: "GET", url: url(refB) })).statusCode).toBe(404);
      const nonexistent = sessionRef(refA.id, join(temp, "missing-workspace"));
      hub.mediaIndex.reference(nonexistent, image());
      expect((await app.inject({ method: "GET", url: url(nonexistent) })).statusCode).toBe(404); // Verify ownership before cache.
      expect(decode).toHaveBeenCalledOnce();
      hub.mediaIndex.clear();
      readEntries.mockClear();
      const abbreviatedResponse = await app.inject({ method: "GET", url: url({ ...refA, id: "copied" }) });
      expect(abbreviatedResponse.statusCode).toBe(404);
      expect(readEntries).not.toHaveBeenCalled();
      const exactResponse = await app.inject({ method: "GET", url: url(refA) });
      expect(exactResponse.statusCode).toBe(200);
      expect(exactResponse.rawPayload).toEqual(Buffer.from(png, "base64"));
      expect(readEntries).toHaveBeenCalledExactlyOnceWith(pathA);
      expect(hub.mediaIndex.get(refB, idOf(png))).toBeUndefined();
      expect(open).not.toHaveBeenCalled();
      expect(createAgentRuntime).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("keeps prompt echoes and transient SDK image references lazy, with recoverable eviction misses", async () => {
    const decode = vi.fn((source: string) => Buffer.from(source, "base64"));
    const hub = new SessionEventHub(new SessionMediaIndex({ maxMediaEntries: 1, maxMemoEntries: 1, decode }));
    const fake = fakeRuntime("session-1");
    const service = new PiSessionService(hub, {
      agentDir: temp, modelRuntime: testModelRuntime,
      archiveStore: new SessionArchiveStore(join(temp, "archives.json")),
      createAgentRuntime: runtimeCreator(fake.runtime), sessionManager: sessionGateway([sessionRecord("session-1")]), heartbeatIntervalMs: 60_000,
    });
    services.push(service);
    const ref = sessionRef("session-1");
    // Attachment resizing is a separate boundary; the index receives the Pi image.
    vi.spyOn(attachmentService, "attachmentsToInlineImages").mockResolvedValueOnce([{ image: image() }]);
    await service.prompt(ref, "look at this", undefined, [{ kind: "image", mimeType: "image/png", data: png }]);
    expect(decode).not.toHaveBeenCalled();
    expect(await service.media(ref, idOf(png))).toEqual({ data: Buffer.from(png, "base64"), mimeType: "image/png" });
    hub.mediaIndex.clear();
    decode.mockClear();
    const emitImage = (block: ReturnType<typeof image>) => {
      fake.emit({ type: "tool_execution_update", toolCallId: "call", toolName: "read", partialResult: { content: [block] } });
    };
    emitImage(image());
    expect(decode).not.toHaveBeenCalled();
    emitImage(image("AQID")); // The old transient reference is evicted, not persisted in history.
    expect(await service.media(ref, idOf(png))).toBeUndefined();
    expect(decode).not.toHaveBeenCalled();
    emitImage(image());
    expect(await service.media(ref, idOf(png))).toEqual({ data: Buffer.from(png, "base64"), mimeType: "image/png" });
    expect(decode).toHaveBeenCalledExactlyOnceWith(png);
  });

  it("rebuilds after restart from every disk branch and observes external appends while a runtime is idle", async () => {
    const cwd = join(temp, "workspace");
    const store = join(temp, "sessions");
    await mkdir(cwd);
    await mkdir(store);
    const path = join(store, "2026_session-1.jsonl");
    const block = image();
    const entry = (id: string, parentId: string | null, content: unknown) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content } });
    const original = [
      { type: "session", version: 3, id: "session-1", cwd, timestamp: "2026-01-01T00:00:00.000Z" },
      entry("root", null, "hello"), entry("abandoned", "root", [block]), entry("selected", "root", "no image here"),
    ].map((value) => JSON.stringify(value)).join("\n") + "\n";
    await writeFile(path, original);
    const coldService = () => {
      const createAgentRuntime = vi.fn(() => { throw new Error("Binary reads must not construct runtimes"); });
      const gateway = createPiSessionManagerGateway({ agentDir: temp, env: { PI_CODING_AGENT_SESSION_DIR: store } });
      const open = vi.spyOn(gateway, "open");
      const hub = new SessionEventHub(new SessionMediaIndex({ maxMediaEntries: 1 }));
      const service = new PiSessionService(hub, { agentDir: temp, modelRuntime: testModelRuntime, archiveStore: new SessionArchiveStore(join(temp, "archives.json")), createAgentRuntime, sessionManager: gateway, heartbeatIntervalMs: 60_000 });
      services.push(service);
      return { service, createAgentRuntime, open };
    };
    const ref = sessionRef("session-1", cwd);
    const first = coldService();
    expect(await first.service.media(ref, idOf(png))).toEqual({ data: Buffer.from(png, "base64"), mimeType: "image/png" });
    await first.service.dispose();
    const restarted = coldService();
    expect(await restarted.service.media(ref, idOf(png))).toEqual({ data: Buffer.from(png, "base64"), mimeType: "image/png" });
    expect(restarted.open).not.toHaveBeenCalled();
    expect(restarted.createAgentRuntime).not.toHaveBeenCalled();

    const gateway = createPiSessionManagerGateway({ agentDir: temp, env: { PI_CODING_AGENT_SESSION_DIR: store } });
    const fake = fakeRuntime("session-1", { sessionFile: path, sessionManager: fakeSessionManager(cwd, { getSessionFile: () => path }) });
    const idle = new PiSessionService(new SessionEventHub(new SessionMediaIndex({ maxMediaEntries: 1 })), {
      agentDir: temp, modelRuntime: testModelRuntime, archiveStore: new SessionArchiveStore(join(temp, "archives.json")), createAgentRuntime: runtimeCreator(fake.runtime), sessionManager: gateway, heartbeatIntervalMs: 60_000,
    });
    services.push(idle);
    await idle.status(ref);
    const appended = image(Buffer.from("external append").toString("base64"));
    const appendedLine = JSON.stringify(entry("external", "root", [appended])) + "\n";
    await appendFile(path, appendedLine);
    expect(await idle.media(ref, idOf(appended.data))).toEqual({ data: Buffer.from(appended.data, "base64"), mimeType: "image/png" });
    expect(await idle.media(ref, idOf(png))).toEqual({ data: Buffer.from(png, "base64"), mimeType: "image/png" });
    expect(await readFile(path, "utf8")).toBe(original + appendedLine);
    expect(await readdir(store)).toEqual(["2026_session-1.jsonl"]);
  });

  it("propagates disk failures rather than reporting false misses, and recovers on retry", async () => {
    const readEntries = vi.fn<(path: string) => Promise<readonly unknown[] | undefined>>()
      .mockRejectedValueOnce(new Error("disk failure"))
      .mockResolvedValue([{ type: "message", message: { content: [image()] } }]);
    const service = new PiSessionService(new SessionEventHub(), {
      agentDir: temp, modelRuntime: testModelRuntime, archiveStore: new SessionArchiveStore(join(temp, "archives.json")),
      sessionManager: { ...sessionGateway([sessionRecord("session-1")]), readEntries }, heartbeatIntervalMs: 60_000,
    });
    services.push(service);
    await expect(service.media(sessionRef("session-1"), idOf(png))).rejects.toThrow("disk failure");
    await expect(service.media(sessionRef("session-1"), "../bad")).rejects.toThrow("Invalid media id");
    expect(await service.media(sessionRef("session-1"), idOf(png))).toEqual({ data: Buffer.from(png, "base64"), mimeType: "image/png" });
  });
});
