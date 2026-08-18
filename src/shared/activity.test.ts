import { describe, expect, it } from "vitest";
import { isSessionActive } from "./activity";
import type { SessionActivity, SessionStatus } from "./apiTypes";

const idleStatus: SessionStatus = {
  sessionId: "s1",
  isStreaming: false,
  isCompacting: false,
  isBashRunning: false,
  pendingMessageCount: 0,
  queuedMessages: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
};

describe("activity helpers", () => {
  it("detects active session states", () => {
    expect(isSessionActive(idleStatus)).toBe(false);
    expect(isSessionActive({ ...idleStatus, isStreaming: true })).toBe(true);
    expect(isSessionActive({ ...idleStatus, pendingMessageCount: 2 })).toBe(true);
  });

  it("does not count a session that is only starting up as doing work", () => {
    // Startup is reported on the activity channel with an "active" phase because
    // a phase really is in progress, but opening a session is not work a user
    // can stop, so the marker is what separates starting from working.
    const startup: SessionActivity = { sessionId: "s1", phase: "active", label: "Opening session", detail: "Starting the Pi session", at: "now", startup: true };

    expect(isSessionActive(undefined, startup)).toBe(false);
    expect(isSessionActive(idleStatus, startup)).toBe(false);
  });

  it("still reports genuine work happening while a session starts up", () => {
    const startup: SessionActivity = { sessionId: "s1", phase: "active", label: "Opening session", at: "now", startup: true };

    // The marker only removes the activity-phase reason for being active, so
    // work the status proves is unaffected by it.
    expect(isSessionActive({ ...idleStatus, isStreaming: true }, startup)).toBe(true);
    expect(isSessionActive({ ...idleStatus, isBashRunning: true }, startup)).toBe(true);
    expect(isSessionActive({ ...idleStatus, isCompacting: true }, startup)).toBe(true);
    expect(isSessionActive({ ...idleStatus, pendingMessageCount: 1 }, startup)).toBe(true);
    // An unmarked active activity is ordinary work and keeps counting.
    expect(isSessionActive(idleStatus, { sessionId: "s1", phase: "active", label: "running tool", at: "now" })).toBe(true);
  });
});
