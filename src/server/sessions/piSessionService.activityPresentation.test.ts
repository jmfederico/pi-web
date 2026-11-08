import { describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

async function fixture() {
  const hub = new CapturingSessionEventHub();
  const fake = fakeRuntime("activity", { isStreaming: true });
  const service = new PiSessionService(hub, {
    agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime,
    sessionManager: sessionGateway([sessionRecord("activity")]),
    createAgentRuntime: runtimeCreator(fake.runtime), heartbeatIntervalMs: 2_000,
  });
  await service.status(sessionRef("activity"));
  const activities = () => hub.globalEvents.flatMap((event) => event.type === "activity.update" ? [event.activity] : []);
  return { hub, fake, service, activities };
}

describe("runtime activity presentation", () => {
  it("emits explicit kinds and raw fallback/detail values on both channels", async () => {
    const f = await fixture();
    try {
      const cases = [
        ["agent_start", "agentRunning", "agent running"],
        ["turn_end", "turnComplete", "turn complete"],
        ["message_start", "messageStarted", "message started"],
        ["message_end", "messageComplete", "message complete"],
        ["message_update", "receivingResponse", "receiving response"],
        ["tool_execution_start", "runningTool", "running tool"],
        ["tool_execution_end", "toolComplete", "tool complete"],
        ["bash_execution_start", "runningBash", "running bash"],
        ["bash_execution_end", "bashComplete", "bash complete"],
      ];
      for (const [type, kind, label] of cases) {
        f.fake.emit({ type, toolName: "raw_tool العربية <x>" });
        expect(f.activities().at(-1)).toMatchObject({ label, runtimePresentation: { kind } });
      }
      f.fake.emit({ type: "tool_execution_end", isError: true, toolName: "raw_tool العربية <x>" });
      const failed = f.activities().at(-1);
      expect(failed).toMatchObject({ phase: "error", label: "tool failed", detail: "raw_tool العربية <x>", runtimePresentation: { kind: "toolFailed" } });
      expect(f.hub.sessionEvents.map(({ event }) => event)).toContainEqual({ type: "activity.update", activity: failed });
      f.fake.emit({ type: "future_runtime_event" });
      expect(f.activities().at(-1)).toMatchObject({ label: "future runtime event", runtimePresentation: { kind: "event", value: "future_runtime_event" } });
    } finally { await f.service.dispose(); }
  });

  it("keeps a running tool presented while that tool streams output", async () => {
    const f = await fixture();
    try {
      f.fake.emit({ type: "tool_execution_start", toolName: "bash" });
      f.fake.emit({ type: "tool_execution_update", toolCallId: "call", toolName: "bash", partialResult: { content: [] } });
      const streaming = f.activities().at(-1);
      expect(streaming).toMatchObject({ phase: "active", label: "running tool", detail: "bash", runtimePresentation: { kind: "runningTool" } });
      expect(f.hub.sessionEvents.map(({ event }) => event)).toContainEqual({ type: "activity.update", activity: streaming });
    } finally { await f.service.dispose(); }
  });

  it("leaves the running activity unchanged when a session entry is appended mid-turn", async () => {
    const f = await fixture();
    try {
      f.fake.emit({ type: "tool_execution_start", toolName: "bash" });
      const running = f.activities().at(-1);
      const published = f.activities().length;
      f.fake.emit({ type: "entry_appended", entry: { type: "custom", customType: "background.notice" } });
      expect(f.activities()).toHaveLength(published);
      expect(f.activities().at(-1)).toBe(running);
    } finally { await f.service.dispose(); }
  });

  it("retains kinds and raw tool details through heartbeat re-publication, then clears stale activity", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = await fixture();
    try {
      f.fake.emit({ type: "tool_execution_start", toolName: "raw tool" });
      const before = f.activities().at(-1);
      await vi.advanceTimersByTimeAsync(2_001);
      expect(f.activities().at(-1)).toMatchObject({ label: "running tool", detail: "raw tool", runtimePresentation: { kind: "runningTool" } });
      expect(f.activities().length).toBeGreaterThan(1);
      expect(f.activities().at(-1)).not.toBe(before);
      f.fake.session.isStreaming = false;
      await f.service.status(sessionRef("activity"));
      f.fake.emit({ type: "agent_settled" });
      expect(f.activities().at(-1)).toMatchObject({ phase: "idle", label: "idle", runtimePresentation: { kind: "idle" } });
      expect(f.activities().at(-1)).not.toHaveProperty("detail");
    } finally { await f.service.dispose(); vi.useRealTimers(); }
  });

  it("derives heartbeat presentation from status when no prior activity exists", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = await fixture();
    try {
      await vi.advanceTimersByTimeAsync(2_001);
      expect(f.activities().at(-1)).toMatchObject({ label: "agent running", runtimePresentation: { kind: "agentRunning" } });
    } finally { await f.service.dispose(); vi.useRealTimers(); }
  });

  it("distinguishes app-authored compaction details from raw diagnostics", async () => {
    const f = await fixture();
    try {
      f.fake.emit({ type: "compaction_end", reason: "threshold", aborted: true });
      expect(f.activities().at(-1)).toMatchObject({ label: "compaction cancelled", detail: "Automatic compaction cancelled.", runtimePresentation: { kind: "compactionCancelled", detailKind: "automaticCompactionCancelled" } });
      f.fake.emit({ type: "compaction_end", reason: "manual", aborted: false, errorMessage: "raw diagnostic العربية" });
      expect(f.activities().at(-1)).toMatchObject({ label: "compaction failed", detail: "Couldn’t compact history. Try again.", runtimePresentation: { kind: "compactionFailed", detailKind: "compactionFailed" } });
      expect(f.hub.sessionEvents.map(({ event }) => event)).toContainEqual({ type: "session.diagnostic", message: "raw diagnostic العربية" });
    } finally { await f.service.dispose(); }
  });
});
