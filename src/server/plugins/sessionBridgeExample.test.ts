import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../../../examples/session-bridge-plugin/src/server.js";
import { collectReview } from "../../../examples/session-bridge-plugin/src/reviewRun.js";
import { REVIEW_REPLY, REVIEW_REQUEST, isReview, type Review } from "../../../examples/session-bridge-plugin/src/browser/protocol.js";
import { ReviewStore, reviewScope } from "../../../examples/session-bridge-plugin/src/store.js";
import type { ServerPluginPeerRequestContext } from "../../server-plugin-api.js";

const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "workspace-review-")); directories.push(path); return path; }
function connectionFixture() {
  const bus = createEventBus();
  const lifetime = new AbortController();
  const connection = {
    signal: lifetime.signal,
    on: (channel: string, handler: (data: unknown) => void) => bus.on(channel, handler),
    emit: (channel: string, data: unknown) => { bus.emit(channel, data); },
    close: vi.fn(() => { lifetime.abort(); }),
  };
  return { bus, lifetime, connection };
}
async function setup() {
  const fixture = connectionFixture();
  const hostLifetime = new AbortController();
  const dataDirectory = await directory();
  const create = vi.fn(() => Promise.resolve({ sessionId: "created-session" }));
  const connect = vi.fn(() => Promise.resolve(fixture.connection));
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const activation = plugin.activate({
    apiVersion: 3, pluginId: "review", packageRoot: dataDirectory, dataDirectory, logger, settings: {},
    signal: new AbortController().signal, lifetimeSignal: hostLifetime.signal,
    execFile: () => { throw new Error("No backend shell commands expected"); },
  });
  activation.start({ capabilities: { resolve: (capability) => capability.parse(capability.id === "pi-sessions"
    ? { version: 1, create, run: () => { throw new Error("Use native companion, not run"); } }
    : { version: 1, connect }) }, signal: new AbortController().signal });
  const context: ServerPluginPeerRequestContext = {
    project: { id: "project", name: "Project", path: "/workspace" },
    workspace: { id: "workspace", projectId: "project", path: "/workspace", label: "Workspace", isMain: true },
    operation: "start", input: null, signal: new AbortController().signal,
  };
  const request = (operation: string, input: string | null = null) => activation.peer.request({ ...context, operation, input });
  const stop = async () => { hostLifetime.abort(); await activation.dispose(); };
  return { ...fixture, create, connect, activation, context, request, stop, dataDirectory, logger, hostLifetime };
}
function onRequest(bus: ReturnType<typeof createEventBus>, handler: (requestId: string) => void) {
  return bus.on(REVIEW_REQUEST, (data) => {
    if (typeof data !== "object" || data === null || !("requestId" in data) || typeof data.requestId !== "string") throw new Error("Invalid request");
    handler(data.requestId);
  });
}
const id = "11111111-1111-4111-8111-111111111111";

describe("review completion connection", () => {
  it("ignores unrelated events and receipt-only success, then collects a synchronous correlated final", async () => {
    const { bus, connection } = connectionFixture();
    onRequest(bus, (requestId) => {
      bus.emit(REVIEW_REPLY, { requestId: "other", status: "completed", text: "Wrong" });
      bus.emit(REVIEW_REPLY, { requestId, status: "accepted" });
      bus.emit(REVIEW_REPLY, { requestId, status: "completed", text: "Findings" });
    });
    await expect(collectReview(connection, id, new AbortController().signal)).resolves.toBe("Findings");
  });
  it.each([false, true])("bounds missing receipt/completion (accepted=%s) and cleans up timers", async (accepted) => {
    vi.useFakeTimers();
    const { bus, connection } = connectionFixture();
    if (accepted) onRequest(bus, (requestId) => { bus.emit(REVIEW_REPLY, { requestId, status: "accepted" }); });
    const result = collectReview(connection, id, new AbortController().signal);
    const rejected = expect(result).rejects.toThrow(accepted ? "10 minutes" : "No companion receipt");
    await vi.advanceTimersByTimeAsync(accepted ? 600_000 : 5_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["connection", "plugin"])("rejects %s lifetime cancellation", async (kind) => {
    const { bus, connection, lifetime } = connectionFixture();
    const pluginLifetime = new AbortController();
    onRequest(bus, () => { (kind === "connection" ? lifetime : pluginLifetime).abort(); });
    await expect(collectReview(connection, id, pluginLifetime.signal)).rejects.toThrow("interrupted");
  });
  it.each(["", "x".repeat(48_001)])("rejects empty or oversized final findings", async (text) => {
    const { bus, connection } = connectionFixture();
    onRequest(bus, (requestId) => { bus.emit(REVIEW_REPLY, { requestId, status: "completed", text }); });
    await expect(collectReview(connection, id, new AbortController().signal)).rejects.toThrow("Invalid companion findings");
  });
});

describe("review backend", () => {
  it("persists final findings, scopes requests, survives browser cancellation, and supports list/read after restart", async () => {
    const fixture = await setup();
    let complete: () => void = () => { throw new Error("Review not requested yet"); };
    onRequest(fixture.bus, (requestId) => {
      fixture.bus.emit(REVIEW_REPLY, { requestId, status: "accepted" });
      complete = () => { fixture.bus.emit(REVIEW_REPLY, { requestId, status: "completed", text: "Bug in src/file.ts:4" }); };
    });
    try {
      const browser = new AbortController();
      const record = await fixture.activation.peer.request({ ...fixture.context, signal: browser.signal });
      expect(record).toMatchObject({ status: "running" });
      if (!isReview(record)) throw new Error("Missing review");
      await vi.waitFor(() => { expect(fixture.connect).toHaveBeenCalledOnce(); });
      browser.abort();
      await expect(fixture.request("start")).rejects.toThrow("already running");
      complete();
      await vi.waitFor(async () => { expect(await fixture.request("read", record.id)).toMatchObject({ status: "completed", text: "Bug in src/file.ts:4" }); });
      expect(await fixture.request("list")).toEqual([expect.objectContaining({ id: record.id, text: "", status: "completed" })]);
      expect(fixture.create).toHaveBeenCalledWith({ projectId: "project", workspaceId: "workspace" });
      expect(fixture.connect).toHaveBeenCalledWith({ projectId: "project", workspaceId: "workspace", sessionId: "created-session" });
      expect(fixture.connection.close).toHaveBeenCalledOnce();
      expect(await fixture.activation.peer.request({ ...fixture.context, operation: "list", workspace: { ...fixture.context.workspace, id: "other" } })).toEqual([]);
      await expect(fixture.activation.peer.request({ ...fixture.context, operation: "read", input: record.id, workspace: { ...fixture.context.workspace, id: "other" } })).rejects.toThrow();
      await fixture.stop();
      const store = new ReviewStore(fixture.dataDirectory);
      expect(await store.read(reviewScope("project", "workspace"), record.id)).toMatchObject({ status: "completed", text: "Bug in src/file.ts:4" });
    } finally { await fixture.stop(); }
  });
  it.each(["provider", "create", "connect", "shutdown"])("records %s failure rather than successful findings", async (kind) => {
    const fixture = await setup();
    if (kind === "create") fixture.create.mockRejectedValue(new Error("create failed"));
    if (kind === "connect") fixture.connect.mockRejectedValue(new Error("connect failed"));
    onRequest(fixture.bus, (requestId) => {
      if (kind === "shutdown") fixture.hostLifetime.abort();
      else fixture.bus.emit(REVIEW_REPLY, { requestId, status: "failed", error: "provider failed" });
    });
    try {
      const record = await fixture.request("start");
      if (!isReview(record)) throw new Error("Missing review");
      const store = new ReviewStore(fixture.dataDirectory);
      await vi.waitFor(async () => { expect(await store.read(reviewScope("project", "workspace"), record.id)).toMatchObject({ status: "failed" }); });
    } finally { await fixture.stop(); }
  });
  it("reports stale running files as interrupted, and invalid operations cannot create sessions", async () => {
    const fixture = await setup();
    try {
      await new ReviewStore(fixture.dataDirectory).save(reviewScope("project", "workspace"), { id, status: "running", sessionId: "old-session", createdAt: "2026-09-01", text: "" });
      expect(await fixture.request("read", id)).toMatchObject({ status: "interrupted" });
      expect(await fixture.request("list")).toEqual([expect.objectContaining({ status: "interrupted" })]);
      await expect(fixture.request("existing", "foreign-session")).rejects.toThrow("Unknown review operation");
      expect(fixture.create).not.toHaveBeenCalled();
    } finally { await fixture.stop(); }
  });
  it("surfaces final persistence failure in the panel and logger", async () => {
    const fixture = await setup();
    let complete: () => void = () => { throw new Error("Review not requested yet"); };
    onRequest(fixture.bus, (requestId) => {
      fixture.bus.emit(REVIEW_REPLY, { requestId, status: "accepted" });
      complete = () => { fixture.bus.emit(REVIEW_REPLY, { requestId, status: "completed", text: "Findings" }); };
    });
    try {
      const record = await fixture.request("start");
      if (!isReview(record)) throw new Error("Missing review");
      await vi.waitFor(() => { expect(fixture.connect).toHaveBeenCalledOnce(); });
      const spy = vi.spyOn(ReviewStore.prototype, "save").mockRejectedValue(new Error("disk full"));
      try {
        complete();
        await vi.waitFor(() => { expect(fixture.logger.error).toHaveBeenCalledOnce(); });
        const saved = await fixture.request("read", record.id);
        if (!isReview(saved)) throw new Error("Invalid saved review");
        expect(saved.status).toBe("failed");
        expect(saved.text).toContain("disk full");
      } finally { spy.mockRestore(); }
    } finally { await fixture.stop(); }
  });
});

describe("plugin-owned review files", () => {
  it("uses atomic private records and rejects traversal, symlinks, and corrupt records", async () => {
    const root = await directory();
    const store = new ReviewStore(root);
    const scope = reviewScope("../project", "/workspace");
    const record: Review = { id, createdAt: "2026-09-01", sessionId: "session", status: "completed", text: "<script>untrusted</script>" };
    await store.save(scope, record);
    expect(await store.read(scope, id)).toEqual(record);
    expect(await readdir(join(root, scope))).toEqual([`${id}.json`]);
    await expect(store.read(scope, "../../secret")).rejects.toThrow("Invalid review id");
    const target = join(root, "outside.json");
    await writeFile(target, JSON.stringify(record));
    await rm(join(root, scope, `${id}.json`));
    await symlink(target, join(root, scope, `${id}.json`));
    await expect(store.read(scope, id)).rejects.toThrow();
    await store.save(scope, { ...record, text: "replacement" });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(record);
    await writeFile(join(root, scope, `${id}.json`), "invalid json");
    await expect(store.list(scope)).rejects.toThrow();
    const otherScope = reviewScope("project", "other");
    await symlink(join(root, scope), join(root, otherScope));
    await expect(store.list(otherScope)).rejects.toThrow("must not be a symlink");
  });
});
