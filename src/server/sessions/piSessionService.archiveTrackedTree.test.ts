import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../piSdk.js";
import { createPiWebCustomToolDefinitions, PiSessionService, type PiSessionListEntry } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, sessionGateway, sessionRecord, sessionRef, stubExtensionToolContext } from "./piSessionService.testSupport.js";
import type { ArchivedSessionRecord, ArchiveSessionInput } from "./sessionArchiveStore.js";
import { SessionNotificationStore } from "./sessionNotificationStore.js";

function fixture() {
  const records: PiSessionListEntry[] = ["root", "child", "grandchild", "independent", "fork"].map((id) => ({
    ...sessionRecord(id),
    ...(["child", "fork"].includes(id) ? { parentSessionPath: sessionRecord("root").path } : {}),
    ...(id === "grandchild" ? { parentSessionPath: sessionRecord("child").path } : {}),
  }));
  const runtimes = new Map(records.map((record) => {
    const manager = SessionManager.inMemory(record.cwd, { id: record.id });
    return [record.id, fakeRuntime(record.id, { sessionManager: manager, sessionFile: record.path })];
  }));
  const runtime = (id: string) => {
    const found = runtimes.get(id);
    if (found === undefined) throw new Error(`Missing fixture runtime: ${id}`);
    return found;
  };
  function link(parent: string, child: string) {
    runtime(parent).session.sessionManager.appendCustomEntry?.("pi-web.subsession.link", {
      spawnedBySessionId: parent, spawnedSessionId: child, spawnedSessionFile: sessionRecord(child).path, cwd: "/workspace",
    });
  }
  link("root", "child");
  link("child", "grandchild");
  // A fork may carry copied links, but they still belong to the original parent.
  runtime("fork").session.sessionManager.appendCustomEntry?.("pi-web.subsession.link", {
    spawnedBySessionId: "root", spawnedSessionId: "child", spawnedSessionFile: sessionRecord("child").path,
  });
  const archived: ArchivedSessionRecord[] = [];
  const toArchived = (input: ArchiveSessionInput): ArchivedSessionRecord => ({
    ...input, originalPath: input.path, archivePath: `/archive/${input.sessionId}.jsonl`, archivedAt: "2026-01-03T00:00:00Z",
  });
  const archiveMany = vi.fn((inputs: readonly ArchiveSessionInput[]) => {
    const saved = inputs.map(toArchived);
    archived.push(...saved);
    return Promise.resolve(saved);
  });
  const list = vi.fn(() => Promise.resolve(records.filter((record) => !archived.some((item) => item.sessionId === record.id))));
  const gateway = sessionGateway(records);
  const notifications = new SessionNotificationStore();
  const restore = vi.fn(() => Promise.resolve());
  const hub = new CapturingSessionEventHub();
  const onSessionArchived = vi.fn(() => undefined);
  const service = new PiSessionService(hub, {
    agentDir: "/tmp/pi-web-archive-tree-test", modelRuntime: runtime("root").session.modelRuntime,
    sessionManager: {
      ...gateway, list,
      open: (path) => {
        const record = records.find((candidate) => candidate.path === path || `/archive/${candidate.id}.jsonl` === path);
        if (record === undefined) throw new Error(`Missing fixture file: ${path}`);
        return runtime(record.id).session.sessionManager;
      },
    },
    archiveStore: { ...emptyArchiveStore(), list: () => Promise.resolve([...archived]),
      get: (id) => Promise.resolve(archived.find((record) => record.sessionId === id)), archiveMany, restore },
    createAgentRuntime: (_factory, options) => Promise.resolve(runtime(options.sessionManager.getSessionId()).runtime),
    notificationStore: notifications, onSessionArchived, heartbeatIntervalMs: 60_000,
  });
  function request(sessionId = "root") {
    const root = runtime(sessionId);
    root.emit({ type: "message_end", message: {
      role: "toolResult", toolName: "archive_self", toolCallId: "archive-call", isError: false, details: { archiveSelf: true },
    } });
    root.emit({ type: "turn_end" });
    root.emit({ type: "agent_settled" });
  }
  return { service, runtime, records, archived, archiveMany, toArchived, list, notifications, hub, onSessionArchived, restore, request };
}

function deferred() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("tracked self-archive trees", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("archives tracked descendants through an archived parent, preserving independent sessions and forks", async () => {
    const f = fixture();
    f.archived.push({ sessionId: "child", cwd: "/workspace", originalPath: sessionRecord("child").path,
      archivePath: "/archive/child.jsonl", parentSessionPath: sessionRecord("root").path, archivedAt: "2026-01-02T00:00:00Z" });
    try {
      for (const id of ["root", "grandchild", "independent", "fork"]) await f.service.status(sessionRef(id));
      f.request();
      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => { expect(f.archiveMany).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ sessionId: "root" }), expect.objectContaining({ sessionId: "grandchild" }),
      ]); });
      expect(f.runtime("root").calls.dispose).toBe(1);
      expect(f.runtime("grandchild").calls.dispose).toBe(1);
      expect(f.runtime("independent").calls.dispose).toBe(0);
      expect(f.runtime("fork").calls.dispose).toBe(0);
      expect(f.service.activeCount()).toBe(2);
      expect(f.onSessionArchived).toHaveBeenCalledOnce();
    } finally { await f.service.dispose(); }
  });

  it("does not inherit archival authority from spawn links copied into a fork", async () => {
    const f = fixture();
    try {
      await f.service.status(sessionRef("fork"));
      await f.service.status(sessionRef("child"));
      f.runtime("child").session.isStreaming = true;
      await f.service.checkSelfArchive("fork");
      f.request("fork");
      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => { expect(f.archiveMany).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ sessionId: "fork" })]); });
      expect(f.runtime("child").calls.dispose).toBe(0);
    } finally { await f.service.dispose(); }
  });

  it.each(["isStreaming", "isCompacting", "isBashRunning", "pendingMessageCount"] as const)("rejects a busy descendant (%s) through the tool before terminating", async (field) => {
    const f = fixture();
    try {
      await f.service.status(sessionRef("root"));
      await f.service.status(sessionRef("grandchild"));
      if (field === "pendingMessageCount") f.runtime("grandchild").session[field] = 1;
      else f.runtime("grandchild").session[field] = true;
      const tool = createPiWebCustomToolDefinitions("/workspace", false, undefined, undefined, false, undefined,
        (id) => f.service.checkSelfArchive(id)).find((item) => item.name === "archive_self");
      if (tool === undefined) throw new Error("Missing archive tool");
      const ctx = stubExtensionToolContext({ sessionManager: { getSessionId: () => "root" } });
      await expect(tool.execute("archive-call", {}, undefined, undefined, ctx)).rejects.toThrow("grandchild");
      expect(f.archiveMany).not.toHaveBeenCalled();
      expect(f.runtime("grandchild").calls.abort).toBe(0);
    } finally { await f.service.dispose(); }
  });

  it("rechecks at settlement, reports all busy descendants and never retries when they finish", async () => {
    const f = fixture();
    try {
      for (const id of ["root", "child", "grandchild"]) await f.service.status(sessionRef(id));
      await f.service.checkSelfArchive("root");
      f.runtime("child").session.isStreaming = true;
      f.runtime("grandchild").session.isStreaming = true;
      f.request();
      await vi.runOnlyPendingTimersAsync();
      expect(f.archiveMany).not.toHaveBeenCalled();
      expect(f.service.activeCount()).toBe(3);
      const notifications = f.notifications.inboxSnapshot("root", "/workspace").notifications;
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({ severity: "error" });
      expect(notifications[0]?.message).toContain("child, grandchild");
      f.runtime("child").session.isStreaming = false;
      f.runtime("grandchild").session.isStreaming = false;
      f.runtime("grandchild").emit({ type: "agent_settled" });
      await vi.runOnlyPendingTimersAsync();
      expect(f.archiveMany).not.toHaveBeenCalled();
    } finally { await f.service.dispose(); }
  });

  it("rejects a descendant submission admitted while the catalog is loading", async () => {
    const f = fixture();
    const metadata = deferred();
    const prompt = deferred();
    try {
      await f.service.status(sessionRef("root"));
      await f.service.status(sessionRef("child"));
      f.list.mockImplementation(async () => { await metadata.promise; return f.records; });
      f.request();
      await vi.runOnlyPendingTimersAsync();
      f.runtime("child").session.prompt = () => prompt.promise;
      await f.service.prompt(sessionRef("child"), "New work");
      metadata.release();
      await vi.runOnlyPendingTimersAsync();
      expect(f.archiveMany).not.toHaveBeenCalled();
      expect(f.runtime("child").calls.abort).toBe(0);
      expect(f.notifications.inboxSnapshot("root", "/workspace").notifications[0]?.message).toContain("child");
    } finally { metadata.release(); prompt.release(); await f.service.dispose(); }
  });

  it.each(["self", "ui"] as const)("blocks descendant starts and reopening until %s tree persistence finishes", async (source) => {
    const f = fixture();
    const persistence = deferred();
    let archival: Promise<unknown> | undefined;
    f.archiveMany.mockImplementation(async (inputs) => { await persistence.promise; return inputs.map(f.toArchived); });
    try {
      await f.service.status(sessionRef("root"));
      await f.service.status(sessionRef("child"));
      if (source === "self") f.request();
      else archival = f.service.archiveTree(sessionRef("root"));
      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => { expect(f.archiveMany).toHaveBeenCalledOnce(); });
      expect(f.runtime("child").calls.dispose).toBe(1);
      for (const id of ["child", "grandchild"]) {
        await expect(f.service.prompt(sessionRef(id), "New work")).rejects.toThrow("archival is in progress");
        expect(f.runtime(id).calls.prompt).toEqual([]);
      }
      persistence.release();
      await archival;
      await vi.runOnlyPendingTimersAsync();
    } finally { persistence.release(); await archival; await f.service.dispose(); }
  });

  it("rejects a descendant still opening without interrupting its startup", async () => {
    const f = fixture();
    const startup = deferred();
    let opening: Promise<unknown> | undefined;
    const bind = vi.fn(() => startup.promise);
    try {
      await f.service.status(sessionRef("root"));
      f.runtime("grandchild").session.bindExtensions = bind;
      opening = f.service.status(sessionRef("grandchild"));
      await vi.waitFor(() => { expect(bind).toHaveBeenCalledOnce(); });
      f.request();
      await vi.runOnlyPendingTimersAsync();
      expect(f.archiveMany).not.toHaveBeenCalled();
      expect(f.notifications.inboxSnapshot("root", "/workspace").notifications[0]?.message).toContain("grandchild");
      startup.release();
      await opening;
      expect(f.runtime("grandchild").calls.dispose).toBe(0);
    } finally { startup.release(); await opening; await f.service.dispose(); }
  });

  it("blocks restore of an archived intermediary until the cascade finishes", async () => {
    const f = fixture();
    const persistence = deferred();
    f.archived.push({ sessionId: "child", cwd: "/workspace", originalPath: sessionRecord("child").path,
      archivePath: "/archive/child.jsonl", parentSessionPath: sessionRecord("root").path, archivedAt: "2026-01-02T00:00:00Z" });
    f.archiveMany.mockImplementation(async (inputs) => { await persistence.promise; return inputs.map(f.toArchived); });
    try {
      await f.service.status(sessionRef("root"));
      f.request();
      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => { expect(f.archiveMany).toHaveBeenCalledOnce(); });
      await expect(f.service.restore(sessionRef("child"))).rejects.toThrow("archival is in progress");
      expect(f.restore).not.toHaveBeenCalled();
      persistence.release();
      await vi.runOnlyPendingTimersAsync();
      await f.service.restore(sessionRef("child"));
      expect(f.restore).toHaveBeenCalledExactlyOnceWith("child");
    } finally { persistence.release(); await f.service.dispose(); }
  });

  it("rejects a stale catalog when an archived intermediary is restored during discovery", async () => {
    const f = fixture();
    const metadata = deferred();
    f.archived.push({ sessionId: "child", cwd: "/workspace", originalPath: sessionRecord("child").path,
      archivePath: "/archive/child.jsonl", parentSessionPath: sessionRecord("root").path, archivedAt: "2026-01-02T00:00:00Z" });
    f.restore.mockImplementation(() => { f.archived.length = 0; return Promise.resolve(); });
    try {
      await f.service.status(sessionRef("root"));
      f.list.mockImplementationOnce(async () => { await metadata.promise; return f.records; });
      f.request();
      await vi.runOnlyPendingTimersAsync();
      await f.service.restore(sessionRef("child"));
      metadata.release();
      await vi.runOnlyPendingTimersAsync();
      expect(f.archiveMany).not.toHaveBeenCalled();
      expect(f.runtime("root").calls.dispose).toBe(0);
      expect(f.notifications.inboxSnapshot("root", "/workspace").notifications[0]?.message).toContain("Session lifecycle changed");
    } finally { metadata.release(); await f.service.dispose(); }
  });

  it("rejects discovery when a restore is already in flight and absent from both catalogs", async () => {
    const f = fixture();
    const restoring = deferred();
    let restore: Promise<void> | undefined;
    f.archived.push({ sessionId: "child", cwd: "/workspace", originalPath: sessionRecord("child").path,
      archivePath: "/archive/child.jsonl", parentSessionPath: sessionRecord("root").path, archivedAt: "2026-01-02T00:00:00Z" });
    f.restore.mockImplementation(() => { f.archived.length = 0; return restoring.promise; });
    try {
      await f.service.status(sessionRef("root"));
      await f.service.status(sessionRef("grandchild"));
      f.runtime("grandchild").session.isStreaming = true;
      f.list.mockResolvedValue(f.records.filter((record) => record.id !== "child"));
      restore = f.service.restore(sessionRef("child"));
      await vi.waitFor(() => { expect(f.restore).toHaveBeenCalledOnce(); });
      f.request();
      await vi.runOnlyPendingTimersAsync();
      expect(f.archiveMany).not.toHaveBeenCalled();
      expect(f.runtime("root").calls.dispose).toBe(0);
      expect(f.notifications.inboxSnapshot("root", "/workspace").notifications[0]?.message).toContain("Session lifecycle changed");
    } finally { restoring.release(); await restore; await f.service.dispose(); }
  });

  it("fails closed when opening a descendant yields a missing or replaced transcript identity", async () => {
    const f = fixture();
    // SessionManager.open creates a fresh identity for a missing file.
    f.runtime("child").session.sessionManager = SessionManager.inMemory("/workspace", { id: "replacement" });
    try {
      await f.service.status(sessionRef("root"));
      f.request();
      await vi.runOnlyPendingTimersAsync();
      expect(f.archiveMany).not.toHaveBeenCalled();
      expect(f.runtime("root").calls.dispose).toBe(0);
      expect(f.notifications.inboxSnapshot("root", "/workspace").notifications[0]?.message).toContain("Session changed while preparing archival: child");
    } finally { await f.service.dispose(); }
  });

  it("reports partial persistence without retrying and releases descendant reservations", async () => {
    const f = fixture();
    f.archiveMany.mockImplementation((inputs) => {
      const first = inputs[0];
      if (first !== undefined) f.archived.push(f.toArchived(first));
      return Promise.reject(new Error("archive disk unavailable"));
    });
    try {
      await f.service.status(sessionRef("root"));
      f.request();
      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => {
        const notifications = f.notifications.inboxSnapshot("root", "/workspace").notifications;
        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toMatchObject({ severity: "error" });
        expect(notifications[0]?.message).toContain("archive disk unavailable");
        expect(notifications[0]?.message).toContain("check the archive before retrying");
      });
      expect(f.archived.map((record) => record.sessionId)).toEqual(["root"]);
      await f.service.prompt(sessionRef("grandchild"), "Continue after failed archival");
      expect(f.runtime("grandchild").calls.prompt).toHaveLength(1);
      await vi.runOnlyPendingTimersAsync();
      expect(f.archiveMany).toHaveBeenCalledOnce();
      expect(f.onSessionArchived).not.toHaveBeenCalled();
    } finally { await f.service.dispose(); }
  });
});
