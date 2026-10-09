import { describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { SessionNotificationStore } from "./sessionNotificationStore.js";
import { CapturingSessionEventHub, emptyArchiveStore, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

function fixture() {
  const store = new SessionNotificationStore({ daemonInstanceId: "cold-inbox-test" });
  const gateway = sessionGateway([sessionRecord("persisted")]);
  const createAgentRuntime = vi.fn(() => Promise.reject(new Error("Inbox reads must not open an agent")));
  const archiveStore = emptyArchiveStore();
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir: "/tmp/pi-web-test-agent",
    modelRuntime: testModelRuntime,
    notificationStore: store,
    sessionManager: gateway,
    archiveStore,
    createAgentRuntime,
    heartbeatIntervalMs: 60_000,
  });
  return { service, store, gateway, archiveStore, createAgentRuntime };
}

describe("PiSessionService cold notification inbox", () => {
  it("returns an empty inbox for a persisted session without creating a runtime or generation", async () => {
    const f = fixture();
    try {
      const snapshot = await f.service.notificationInbox(sessionRef("persisted"));
      expect(snapshot).toEqual({
        daemonInstanceId: "cold-inbox-test",
        catalogRevision: 0,
        summary: { sessionId: "persisted", cwd: "/workspace", inboxRevision: 0, retainedCount: 0, discardedCount: 0 },
        notifications: [],
        dismissThrough: { order: 0, overflowWatermark: 0 },
      });
      expect(f.store.currentGeneration("persisted", "/workspace")).toBeUndefined();
      expect(f.service.activeCount()).toBe(0);
      expect(f.createAgentRuntime).not.toHaveBeenCalled();
    } finally {
      await f.service.dispose();
    }
  });

  it("rejects missing, abbreviated and wrong-workspace identities", async () => {
    const f = fixture();
    try {
      for (const ref of [sessionRef("missing"), sessionRef("persist"), sessionRef("persisted", "/other")]) {
        await expect(f.service.notificationInbox(ref)).rejects.toThrow("Session not found");
      }
      expect(f.createAgentRuntime).not.toHaveBeenCalled();
    } finally {
      await f.service.dispose();
    }
  });

  it("preserves notifications registered during the durable identity lookup", async () => {
    const f = fixture();
    const resolveSessionFile = f.gateway.resolveSessionFile.bind(f.gateway);
    const lookup = vi.spyOn(f.gateway, "resolveSessionFile").mockImplementation(async (cwd, id) => {
      const registration = f.store.registerSession(id, cwd);
      f.store.addNotification(registration.generation, "startup notice", "warning");
      return resolveSessionFile(cwd, id);
    });
    try {
      const snapshot = await f.service.notificationInbox(sessionRef("persisted"));
      expect(snapshot.notifications).toMatchObject([{ message: "startup notice", severity: "warning" }]);
      expect(await f.service.notificationInbox(sessionRef("persisted"))).toEqual(snapshot);
      expect(lookup).toHaveBeenCalledOnce();
    } finally {
      await f.service.dispose();
    }
  });

  it("keeps archived notifications disabled even when their original file resolves", async () => {
    const f = fixture();
    vi.spyOn(f.archiveStore, "get").mockResolvedValue({ sessionId: "persisted", cwd: "/workspace", archivedAt: "2026-01-01T00:00:00.000Z" });
    const lookup = vi.spyOn(f.gateway, "resolveSessionFile");
    try {
      await expect(f.service.notificationInbox(sessionRef("persisted"))).rejects.toThrow("Session not found");
      expect(lookup).not.toHaveBeenCalled();
      expect(f.createAgentRuntime).not.toHaveBeenCalled();
    } finally {
      await f.service.dispose();
    }
  });

  it("keeps revision watermarks after stopping a persisted session without registering it again", async () => {
    const f = fixture();
    const registration = f.store.registerSession("persisted", "/workspace");
    f.store.addNotification(registration.generation, "old notice", "info");
    const mutations = f.store.clearSession("persisted", "runtime-close");
    try {
      const snapshot = await f.service.notificationInbox(sessionRef("persisted"));
      expect(snapshot.summary.inboxRevision).toBe(mutations[0]?.inboxEvent.summary.inboxRevision);
      expect(snapshot.notifications).toEqual([]);
      expect(f.store.currentGeneration("persisted", "/workspace")).toBeUndefined();
    } finally {
      await f.service.dispose();
    }
  });

  it("propagates lookup failures instead of synthesizing an empty inbox", async () => {
    const f = fixture();
    vi.spyOn(f.gateway, "resolveSessionFile").mockRejectedValue(new Error("storage unavailable"));
    try {
      await expect(f.service.notificationInbox(sessionRef("persisted"))).rejects.toThrow("storage unavailable");
    } finally {
      await f.service.dispose();
    }
  });
});
