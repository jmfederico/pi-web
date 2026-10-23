import { describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { SessionNotificationStore } from "./sessionNotificationStore.js";
import { CapturingSessionEventHub, fakeRuntime, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

async function fixture() {
  const hub = new CapturingSessionEventHub();
  const fake = fakeRuntime("compact-session");
  const store = new SessionNotificationStore({ daemonInstanceId: "compaction-test" });
  const service = new PiSessionService(hub, {
    agentDir: "/tmp/pi-web-test-agent",
    modelRuntime: testModelRuntime,
    notificationStore: store,
    createAgentRuntime: runtimeCreator(fake.runtime),
    sessionManager: sessionGateway([sessionRecord("compact-session")]),
    heartbeatIntervalMs: 60_000,
  });
  const ref = sessionRef("compact-session");
  await service.status(ref);
  return { hub, fake, store, service, ref };
}

describe("compaction feedback", () => {
  it.each([
    { reason: "manual", aborted: true, errorMessage: undefined, message: "Compaction cancelled.", severity: "info" },
    { reason: "manual", aborted: false, errorMessage: "Compaction failed: Provider unavailable", message: "Couldn’t compact history. Try again.", severity: "error" },
    { reason: "threshold", aborted: true, errorMessage: undefined, message: "Automatic compaction cancelled.", severity: "info" },
    { reason: "threshold", aborted: false, errorMessage: "Auto-compaction failed: Provider unavailable", message: "Couldn’t compact history. Try again.", severity: "error" },
    { reason: "overflow", aborted: false, errorMessage: "Context overflow recovery failed: Provider unavailable", message: "Couldn’t compact history. Try again.", severity: "error" },
  ])("retains $reason/$severity feedback outside the transcript", async ({ reason, aborted, errorMessage, message, severity }) => {
    const f = await fixture();
    try {
      if (reason === "manual") {
        vi.spyOn(f.fake.session, "compact").mockImplementation(async () => {
          f.fake.emit({ type: "compaction_end", reason, aborted, errorMessage, result: undefined, willRetry: false });
          await Promise.resolve();
          // An extension cancellation need not throw a recognizable abort error.
          throw new Error("Extension stopped compaction");
        });
        await expect(f.service.runCommand(f.ref, "/compact")).resolves.toEqual({ type: "done" });
      } else {
        f.fake.emit({ type: "compaction_end", reason, aborted, errorMessage, result: undefined, willRetry: false });
      }
      // A new snapshot (the browser refresh boundary) retains exactly one notice.
      await vi.waitFor(() => { expect(f.service.notificationInbox(f.ref).notifications).toHaveLength(1); });
      await Promise.resolve();
      const snapshot = f.service.notificationInbox(f.ref);
      expect(snapshot.notifications).toMatchObject([{ message, severity }]);
      expect(f.service.notificationCatalog().sessions).toMatchObject([{ sessionId: f.ref.id, retainedCount: 1 }]);
      expect(f.hub.sessionEvents.filter(({ event }) => event.type === "notifications.inbox")).toHaveLength(1);
      expect(f.hub.sessionEvents.filter(({ event }) => event.type === "notifications.inbox").map(({ sessionId }) => sessionId)).toEqual([f.ref.id]);
      expect(f.hub.sessionEvents.filter(({ event }) => event.type === "command.output" || event.type === "session.error")).toEqual([]);
      expect(f.fake.session.messages).toEqual([]);
      expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.diagnostic")).toEqual(
        aborted ? [] : [{ sessionId: f.ref.id, event: { type: "session.diagnostic", message: errorMessage } }],
      );
      const activityDetails = f.hub.globalEvents.flatMap((event) => event.type === "activity.update" ? [event.activity.detail] : []);
      if (errorMessage !== undefined) expect(activityDetails).not.toContain(errorMessage);
      if (aborted) {
        const activities = f.hub.globalEvents.flatMap((event) => event.type === "activity.update" ? [event.activity] : []);
        expect(activities).toContainEqual(expect.objectContaining({ sessionId: f.ref.id, phase: "idle", label: "compaction cancelled" }));
        expect(activities.some((activity) => activity.phase === "error")).toBe(false);
      }
      const notice = snapshot.notifications[0];
      if (notice === undefined) throw new Error("Expected notification");
      f.service.dismissNotification(f.ref, { daemonInstanceId: snapshot.daemonInstanceId, notificationId: notice.id });
      expect(f.service.notificationInbox(f.ref).notifications).toEqual([]);
    } finally {
      await f.service.dispose();
    }
  });

  it("reports failures before an SDK terminal event without duplicate transcript errors", async () => {
    const f = await fixture();
    try {
      vi.spyOn(f.fake.session, "compact").mockRejectedValue(new Error("Could not stop current operation"));
      await expect(f.service.runCommand(f.ref, "/compact")).resolves.toEqual({ type: "done" });
      await vi.waitFor(() => {
        expect(f.service.notificationInbox(f.ref).notifications).toMatchObject([
          { message: "Couldn’t compact history. Try again.", severity: "error" },
        ]);
      });
      expect(f.hub.sessionEvents.filter(({ event }) => event.type === "command.output" || event.type === "session.error")).toEqual([]);
      expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.diagnostic")).toMatchObject([
        { event: { message: "Compaction failed: Could not stop current operation" } },
      ]);
    } finally {
      await f.service.dispose();
    }
  });

  it("does not duplicate a successful canonical summary in notifications or command output", async () => {
    const f = await fixture();
    try {
      vi.spyOn(f.fake.session, "compact").mockImplementation(async () => {
        f.fake.emit({ type: "entry_appended", entry: { type: "compaction", summary: "Retained context" } });
        f.fake.emit({ type: "compaction_end", reason: "manual", aborted: false, result: { summary: "Retained context" }, willRetry: false });
        await Promise.resolve();
        return { summary: "Retained context", tokensBefore: 123 };
      });
      await expect(f.service.runCommand(f.ref, "/compact")).resolves.toEqual({ type: "done" });
      expect(f.service.notificationInbox(f.ref).notifications).toEqual([]);
      expect(f.hub.sessionEvents.filter(({ event }) => event.type === "command.output" || event.type === "session.error")).toEqual([]);
      expect(f.hub.sessionEvents.filter(({ event }) => event.type === "message.append")).toMatchObject([
        { event: { message: { role: "system", source: "compaction", content: "Compacted history:\n\nRetained context" } } },
      ]);
    } finally {
      await f.service.dispose();
    }
  });
});
