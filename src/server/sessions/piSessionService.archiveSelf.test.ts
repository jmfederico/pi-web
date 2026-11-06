import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../piSdk.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, runtimeCreator, sessionGateway, sessionRecord, sessionRef } from "./piSessionService.testSupport.js";
import { SessionNotificationStore } from "./sessionNotificationStore.js";

const id = "self-archive-session";
const ref = sessionRef(id);
const resultMessage = {
  role: "toolResult" as const, toolCallId: "archive-call", toolName: "archive_self", isError: false,
  content: [{ type: "text" as const, text: "Archival requested" }], details: { archiveSelf: true }, timestamp: 0,
};

function fixture() {
  const manager = SessionManager.inMemory(ref.cwd, { id });
  const fake = fakeRuntime(id, { sessionManager: manager });
  const hub = new CapturingSessionEventHub();
  const notifications = new SessionNotificationStore();
  const records = [sessionRecord(id)];
  const gateway = sessionGateway(records);
  const list = vi.fn((cwd: string) => gateway.list(cwd));
  const archive = vi.fn(() => Promise.resolve({ sessionId: id, cwd: ref.cwd, archivedAt: "2026-01-03T00:00:00Z" }));
  const onSessionArchived = vi.fn(() => undefined);
  const service = new PiSessionService(hub, {
    agentDir: "/tmp/pi-web-archive-self-test", modelRuntime: fake.session.modelRuntime,
    sessionManager: { ...gateway, list }, archiveStore: { ...emptyArchiveStore(), archive },
    createAgentRuntime: runtimeCreator(fake.runtime), notificationStore: notifications,
    onSessionArchived, heartbeatIntervalMs: 60_000,
  });
  function request() {
    fake.emit({ type: "message_end", message: resultMessage });
    manager.appendMessage(resultMessage);
    fake.emit({ type: "turn_end" });
  }
  return { service, fake, hub, notifications, manager, archive, list, records, onSessionArchived, request };
}

describe("agent-requested self-archival", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("waits for settlement and the host prompt receipt, then archives once and invalidates session lists", async () => {
    const f = fixture();
    let release: () => void = () => undefined;
    const prompt = new Promise<void>((resolve) => { release = resolve; });
    f.fake.session.prompt = () => prompt;
    try {
      await f.service.prompt(ref, "Archive when finished");
      f.request();
      f.fake.emit({ type: "agent_end" });
      await vi.runOnlyPendingTimersAsync();
      expect(f.archive).not.toHaveBeenCalled();
      f.fake.emit({ type: "agent_settled" });
      await vi.runOnlyPendingTimersAsync();
      expect(f.archive).not.toHaveBeenCalled();
      release();
      await prompt;
      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => { expect(f.onSessionArchived).toHaveBeenCalledExactlyOnceWith(ref.cwd); });
      expect(f.archive).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: id }));
      expect(f.service.activeCount()).toBe(0);
      f.fake.emit({ type: "agent_settled" });
      await vi.runOnlyPendingTimersAsync();
      expect(f.archive).toHaveBeenCalledOnce();
    } finally { release(); await f.service.dispose(); }
  });

  it.each(["failed-result", "uncommitted-result", "historical-result"] as const)("does not act on a %s", async (scenario) => {
    const f = fixture();
    try {
      if (scenario === "historical-result") f.manager.appendMessage(resultMessage);
      await f.service.status(ref);
      if (scenario !== "historical-result") {
        f.fake.emit({ type: "message_end", message: { ...resultMessage, isError: scenario === "failed-result" } });
      }
      f.fake.emit({ type: "agent_settled" });
      await vi.runOnlyPendingTimersAsync();
      expect(f.archive).not.toHaveBeenCalled();
      expect(f.service.activeCount()).toBe(1);
    } finally { await f.service.dispose(); }
  });

  it.each([
    { type: "message_start", message: { role: "user" } },
    { type: "message_start", message: { role: "custom" } },
    { type: "agent_start" },
    { type: "session_tree" },
    { type: "agent_settled", aborted: true },
  ])("cancels stale intent on $type rather than archiving after later work", async (event) => {
    const f = fixture();
    try {
      await f.service.status(ref);
      f.request();
      f.fake.emit(event);
      f.fake.emit({ type: "agent_settled" });
      await vi.runOnlyPendingTimersAsync();
      expect(f.archive).not.toHaveBeenCalled();
      expect(f.notifications.inboxSnapshot(id, ref.cwd).notifications).toEqual([expect.objectContaining({ severity: "warning" })]);
    } finally { await f.service.dispose(); }
  });

  it("keeps queued messages and cancels the request even if the queue later drains", async () => {
    const f = fixture();
    try {
      await f.service.status(ref);
      f.request();
      f.fake.session.pendingMessageCount = 1;
      f.fake.emit({ type: "agent_settled" });
      await vi.runOnlyPendingTimersAsync();
      expect(f.fake.calls.clearQueue).toBe(0);
      expect(f.archive).not.toHaveBeenCalled();
      f.fake.session.pendingMessageCount = 0;
      f.fake.emit({ type: "agent_settled" });
      await vi.runOnlyPendingTimersAsync();
      expect(f.archive).not.toHaveBeenCalled();
    } finally { await f.service.dispose(); }
  });

  it("cancels when a new submission starts before the deferred archive check", async () => {
    const f = fixture();
    try {
      await f.service.status(ref);
      f.request();
      f.fake.emit({ type: "agent_settled" });
      // Input hooks can consume a command without emitting any agent event.
      await f.service.prompt(ref, "/extension-command");
      await vi.runOnlyPendingTimersAsync();
      expect(f.archive).not.toHaveBeenCalled();
      expect(f.fake.calls.prompt).toHaveLength(1);
    } finally { await f.service.dispose(); }
  });

  it("does not reopen a runtime closed before the deferred archive check", async () => {
    const f = fixture();
    try {
      await f.service.status(ref);
      f.request();
      f.fake.emit({ type: "agent_settled" });
      await f.service.stop(ref);
      await vi.runOnlyPendingTimersAsync();
      expect(f.archive).not.toHaveBeenCalled();
      expect(f.service.activeCount()).toBe(0);
    } finally { await f.service.dispose(); }
  });

  it("blocks incoming work across metadata reads, teardown, and archive persistence", async () => {
    const f = fixture();
    let releaseMetadata: () => void = () => undefined;
    let releaseArchive: () => void = () => undefined;
    const metadata = new Promise<void>((resolve) => { releaseMetadata = resolve; });
    const persistence = new Promise<void>((resolve) => { releaseArchive = resolve; });
    try {
      await f.service.status(ref);
      f.list.mockImplementation(async () => { await metadata; return f.records; });
      f.archive.mockImplementation(async () => { await persistence; return { sessionId: id, cwd: ref.cwd, archivedAt: "2026-01-03T00:00:00Z" }; });
      f.request();
      f.fake.emit({ type: "agent_settled" });
      await vi.runOnlyPendingTimersAsync();
      await expect(f.service.prompt(ref, "New work")).rejects.toThrow("archival is in progress");
      releaseMetadata();
      await metadata;
      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => { expect(f.archive).toHaveBeenCalledOnce(); });
      expect(f.service.activeCount()).toBe(0);
      await expect(f.service.prompt(ref, "Reopen during persistence")).rejects.toThrow("archival is in progress");
      expect(f.fake.calls.prompt).toEqual([]);
      releaseArchive();
      await persistence;
      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => { expect(f.onSessionArchived).toHaveBeenCalledOnce(); });
    } finally { releaseMetadata(); releaseArchive(); await f.service.dispose(); }
  });

  it("waits for admitted archival during disposal and cancels requests not yet admitted", async () => {
    const f = fixture();
    let release: () => void = () => undefined;
    const persistence = new Promise<void>((resolve) => { release = resolve; });
    f.archive.mockImplementation(async () => { await persistence; return { sessionId: id, cwd: ref.cwd, archivedAt: "2026-01-03T00:00:00Z" }; });
    try {
      await f.service.status(ref);
      f.request();
      f.fake.emit({ type: "agent_settled" });
      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => { expect(f.archive).toHaveBeenCalledOnce(); });
      let disposed = false;
      const disposal = f.service.dispose().then(() => { disposed = true; });
      await vi.runOnlyPendingTimersAsync();
      expect(disposed).toBe(false);
      release();
      await disposal;
      expect(f.onSessionArchived).toHaveBeenCalledOnce();
    } finally { release(); await f.service.dispose(); }

    const pending = fixture();
    try {
      await pending.service.status(ref);
      pending.request();
      pending.fake.emit({ type: "agent_settled" });
      await pending.service.dispose();
      await vi.runOnlyPendingTimersAsync();
      expect(pending.archive).not.toHaveBeenCalled();
    } finally { await pending.service.dispose(); }
  });

  it("retains a visible failure after runtime teardown and does not retry", async () => {
    const f = fixture();
    f.archive.mockRejectedValue(new Error("archive disk unavailable"));
    try {
      await f.service.status(ref);
      f.request();
      f.fake.emit({ type: "agent_settled" });
      await vi.runOnlyPendingTimersAsync();
      expect(f.service.activeCount()).toBe(0);
      expect(f.onSessionArchived).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        const failure = f.hub.sessionEvents.find(({ event }) => event.type === "session.error")?.event;
        expect(failure?.type === "session.error" ? failure.message : undefined).toContain("archive disk unavailable");
      });
      const failures = f.notifications.inboxSnapshot(id, ref.cwd).notifications;
      expect(failures).toHaveLength(1);
      expect(failures[0]?.severity).toBe("error");
      expect(failures[0]?.message).toContain("archive disk unavailable");
      await vi.runOnlyPendingTimersAsync();
      expect(f.archive).toHaveBeenCalledOnce();
    } finally { await f.service.dispose(); }
  });
});
