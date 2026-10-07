import { describe, expect, it } from "vitest";
import type { SessionActivity, SessionStatus } from "./api";
import { composerActivityText } from "./composerActivity";

const idle: SessionStatus = { sessionId: "test", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const active: SessionActivity = { sessionId: "test", phase: "active", label: "working", detail: "Reading a file", at: "2026-09-01T00:00:00Z" };

describe("composer runtime activity", () => {
  it("renders no idle status and gives sending precedence", () => {
    expect(composerActivityText(undefined, undefined)).toBeUndefined();
    expect(composerActivityText(idle, undefined)).toBeUndefined();
    expect(composerActivityText(idle, { ...active, phase: "idle", label: "idle" })).toBeUndefined();
    expect(composerActivityText(idle, active, true)).toBe("Sending your message…");
  });
  it.each([
    [{ isCompacting: true, isBashRunning: true, isStreaming: true }, "compacting"],
    [{ isBashRunning: true, isStreaming: true }, "bash"],
    [{ isStreaming: true }, "running"],
    [{ pendingMessageCount: 2 }, "queued"],
  ])("preserves fallback precedence and ignores stale idle activity: %j", (flags, text) => {
    expect(composerActivityText({ ...idle, ...flags }, undefined)).toBe(text);
    expect(composerActivityText({ ...idle, ...flags }, { ...active, phase: "idle", label: "idle" })).toBe(text);
  });
  it("uses live labels/details, including before status is available", () => {
    expect(composerActivityText(undefined, active)).toBe("working: Reading a file");
    expect(composerActivityText(idle, active)).toBe("working: Reading a file");
    expect(composerActivityText(idle, { ...active, detail: "" })).toBe("working");
  });
});
