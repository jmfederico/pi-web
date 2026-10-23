import { describe, expect, it } from "vitest";
import type { GlobalSessionEvent } from "../sessionSocket";
import { SessionWorkTransitions } from "./sessionWorkTransitions";

function status(sessionId: string, active: boolean): Extract<GlobalSessionEvent, { type: "status.update" }> {
  return {
    type: "status.update",
    status: { sessionId, isStreaming: active, isCompacting: false, isBashRunning: false, pendingMessageCount: 0,
      queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 },
  };
}

function activity(sessionId: string, active: boolean, startup = false): Extract<GlobalSessionEvent, { type: "activity.update" }> {
  return { type: "activity.update", activity: { sessionId, phase: active ? "active" : "idle", label: "Work", at: "now", ...(startup ? { startup: true } : {}) } };
}

describe("SessionWorkTransitions", () => {
  it("observes work becoming idle independently for each session and machine", () => {
    const work = new SessionWorkTransitions();
    expect(work.observe("local", status("a", true))).toBeUndefined();
    expect(work.observe("local", status("b", false))).toBeUndefined();
    expect(work.observe("remote", status("a", false))).toBeUndefined();
    expect(work.observe("local", status("a", false))).toBe("a");
    expect(work.observe("local", status("a", false))).toBeUndefined();
  });

  it("observes a complete turn even when active and idle events arrive in one render frame", () => {
    const work = new SessionWorkTransitions();
    work.observe("local", activity("a", true));
    expect(work.observe("local", activity("a", false))).toBe("a");
  });

  it("waits for runtime work to stop even if the activity label becomes idle first", () => {
    const work = new SessionWorkTransitions();
    work.observe("local", status("a", true));
    work.observe("local", activity("a", true));
    expect(work.observe("local", activity("a", false))).toBeUndefined();
    expect(work.observe("local", status("a", false))).toBe("a");
  });

  it("lets authoritative idle status clear an outdated active label without a second completion", () => {
    const work = new SessionWorkTransitions();
    work.observe("local", activity("a", true));
    expect(work.observe("local", status("a", false))).toBe("a");
    expect(work.observe("local", activity("a", false))).toBeUndefined();
  });

  it("does not interpret opening a session as work, but still observes running work during startup", () => {
    const work = new SessionWorkTransitions();
    work.observe("local", activity("a", true, true));
    expect(work.observe("local", activity("a", false))).toBeUndefined();
    work.observe("local", activity("a", true, true));
    work.observe("local", status("a", true));
    expect(work.observe("local", status("a", false))).toBe("a");
  });

  it("seeds work already running when an authoritative snapshot arrives before any active event", () => {
    const work = new SessionWorkTransitions();
    const snapshot = work.snapshotObserver("local", "a");
    expect(snapshot(status("a", true).status)).toBeUndefined();
    expect(work.observe("local", status("a", false))).toBe("a");
  });

  it("does not let a late snapshot replace a newer runtime event", () => {
    const work = new SessionWorkTransitions();
    const snapshot = work.snapshotObserver("local", "a");
    work.observe("local", status("a", false));
    snapshot(status("a", true).status);
    expect(work.observe("local", status("a", false))).toBeUndefined();
  });

  it("does not revive observations from a snapshot started before disposal", () => {
    const work = new SessionWorkTransitions();
    const snapshot = work.snapshotObserver("local", "a");
    work.clear();
    snapshot(status("a", true).status);
    expect(work.observe("local", status("a", false))).toBeUndefined();
  });

  it("releases its observations on disposal", () => {
    const work = new SessionWorkTransitions();
    work.observe("local", status("a", true));
    work.clear();
    expect(work.observe("local", status("a", false))).toBeUndefined();
  });
});
