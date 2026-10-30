import { describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, testModelRuntime } from "./piSessionService.testSupport.js";

describe("read-only session catalog", () => {
  it("lists cold conversations without opening a runtime or leaking transcript/file fields", async () => {
    const gateway = sessionGateway([{ ...sessionRecord("cold"), firstMessage: "private text" }]);
    const open = vi.spyOn(gateway, "open");
    const createRuntime = vi.fn(runtimeCreator(fakeRuntime().runtime));
    const events = new CapturingSessionEventHub();
    const service = new PiSessionService(events, { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway, archiveStore: emptyArchiveStore(), createAgentRuntime: createRuntime });
    try {
      expect(await service.listCatalogSessions("/workspace")).toEqual([
        { id: "cold", cwd: "/workspace", archived: false, archivedAt: null, runtime: "not-hosted", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:01:00.000Z" },
      ]);
      expect(open).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
      expect(service.activeCount()).toBe(0);
    } finally {
      await service.dispose();
    }
  });

  it("reports already-hosted idle/busy sessions, without assigning runtime state to a cloned file", async () => {
    const fake = fakeRuntime("live");
    const gateway = sessionGateway([]);
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway, archiveStore: emptyArchiveStore(), createAgentRuntime: runtimeCreator(fake.runtime) });
    try {
      await service.start("/workspace");
      expect((await service.listCatalogSessions("/workspace"))[0]?.runtime).toBe("idle");
      fake.session.isStreaming = true;
      expect((await service.listCatalogSessions("/workspace"))[0]?.runtime).toBe("busy");
      fake.session.isStreaming = false;
      gateway.list = () => Promise.resolve([sessionRecord("live")]);
      expect((await service.listCatalogSessions("/workspace"))[0]?.runtime).toBe("not-hosted");
    } finally {
      await service.dispose();
    }
  });

  it("keeps scanner dates for hosted files rather than treating header creation as last activity", async () => {
    const disk = { ...sessionRecord("live"), path: "/tmp/live.jsonl", modified: new Date("2026-02-01T00:00:00.000Z") };
    const fake = fakeRuntime("live", { sessionManager: fakeSessionManager("/workspace", { getHeader: () => ({ timestamp: "2025-01-01T00:00:00.000Z" }) }) });
    const gateway = sessionGateway([disk]);
    const createRuntime = vi.fn(runtimeCreator(fake.runtime));
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway, archiveStore: emptyArchiveStore(), createAgentRuntime: createRuntime });
    try {
      await service.start("/workspace");
      const callsBeforeRead = createRuntime.mock.calls.length;
      expect(await service.listCatalogSessions("/workspace")).toEqual([
        { id: "live", cwd: "/workspace", archived: false, archivedAt: null, runtime: "idle", created: disk.created.toISOString(), modified: disk.modified.toISOString() },
      ]);
      expect(createRuntime).toHaveBeenCalledTimes(callsBeforeRead);
    } finally {
      await service.dispose();
    }
  });

  it.each(["2026-01-01T01:00:00+01:00", undefined, "invalid"])("does not fabricate hosted-only modification or creation dates (header %s)", async (timestamp) => {
    const fake = fakeRuntime("live", { sessionManager: fakeSessionManager("/workspace", { getHeader: () => timestamp === undefined ? undefined : { timestamp } }) });
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: sessionGateway([]), archiveStore: emptyArchiveStore(), createAgentRuntime: runtimeCreator(fake.runtime) });
    try {
      await service.start("/workspace");
      expect(await service.listCatalogSessions("/workspace")).toEqual([
        { id: "live", cwd: "/workspace", archived: false, runtime: "idle", archivedAt: null, modified: null, created: timestamp === "2026-01-01T01:00:00+01:00" ? "2026-01-01T00:00:00.000Z" : null },
      ]);
    } finally {
      await service.dispose();
    }
  });

  it("projects stored archive dates, scanner fallbacks, and legacy unknown dates without private fields", async () => {
    const archivedAt = "2026-03-01T00:00:00.000Z";
    const fallback = sessionRecord("fallback");
    const gateway = sessionGateway([fallback]);
    const open = vi.spyOn(gateway, "open");
    const createRuntime = vi.fn(runtimeCreator(fakeRuntime().runtime));
    const store = emptyArchiveStore();
    store.list = () => Promise.resolve([
      { sessionId: "stored", cwd: "/workspace", archivedAt, originalPath: "/private/original.jsonl", archivePath: "/private/archive.jsonl", created: "2025-01-01T00:00:00.000Z", modified: "2025-02-01T00:00:00.000Z", messageCount: 1, firstMessage: "private transcript" },
      { sessionId: "fallback", cwd: "/workspace", archivedAt },
      { sessionId: "legacy", cwd: "/workspace", archivedAt, archivePath: "/private/legacy.jsonl" },
    ]);
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway, archiveStore: store, createAgentRuntime: createRuntime });
    try {
      expect(await service.listCatalogSessions("/workspace")).toEqual([
        { id: "fallback", cwd: "/workspace", archived: true, archivedAt, runtime: "not-hosted", created: fallback.created.toISOString(), modified: fallback.modified.toISOString() },
        { id: "stored", cwd: "/workspace", archived: true, archivedAt, runtime: "not-hosted", created: "2025-01-01T00:00:00.000Z", modified: "2025-02-01T00:00:00.000Z" },
        { id: "legacy", cwd: "/workspace", archived: true, archivedAt, created: null, modified: null, runtime: "not-hosted" },
      ]);
      expect(open).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
      expect(service.activeCount()).toBe(0);
    } finally {
      await service.dispose();
    }
  });

  it("rejects cancelled reads before touching storage", async () => {
    const gateway = sessionGateway([]);
    const list = vi.spyOn(gateway, "list");
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway, archiveStore: emptyArchiveStore() });
    try {
      await expect(service.listCatalogSessions("/workspace", AbortSignal.abort())).rejects.toThrow();
      expect(list).not.toHaveBeenCalled();
    } finally {
      await service.dispose();
    }
  });
});
