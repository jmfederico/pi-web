import { describe, expect, it } from "vitest";
import { conversationActivityText } from "./ConversationLayout";
import type { SessionActivity, SessionStatus } from "../api";

const idle: SessionStatus = {
  sessionId: "test", isStreaming: false, isCompacting: false, isBashRunning: false,
  pendingMessageCount: 0, queuedMessages: [], cost: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const activity: SessionActivity = { sessionId: "test", phase: "active", label: "Working", at: "2026-10-21T00:00:00Z" };

describe("conversation activity", () => {
  it("keeps idle conversations quiet and prioritizes sending", () => {
    expect(conversationActivityText(undefined, undefined, false)).toBeUndefined();
    expect(conversationActivityText(idle, undefined, false)).toBeUndefined();
    expect(conversationActivityText({ ...idle, isStreaming: true }, activity, true)).toBe("Sending your message…");
  });

  it.each([
    [{ isCompacting: true, isStreaming: true }, "compacting"],
    [{ isBashRunning: true }, "bash"],
    [{ isStreaming: true }, "running"],
    [{ pendingMessageCount: 2 }, "queued"],
  ])("uses status when activity is missing or stale: %j", (status, label) => {
    expect(conversationActivityText({ ...idle, ...status }, undefined, false)).toBe(label);
    expect(conversationActivityText({ ...idle, ...status }, { ...activity, phase: "idle" }, false)).toBe(label);
  });

  it("retains active activity details independently of transcript content", () => {
    expect(conversationActivityText(idle, { ...activity, detail: "Receiving response" }, false)).toBe("Working: Receiving response");
    expect(conversationActivityText(undefined, activity, false)).toBe("Working");
  });
});
