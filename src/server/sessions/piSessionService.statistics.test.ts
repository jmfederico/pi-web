import { afterEach, describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

function fixture() {
  const branch: unknown[] = [];
  const fake = fakeRuntime("session-1", {
    sessionFile: undefined,
    sessionManager: fakeSessionManager("/workspace", {
      getBranch: () => branch,
      getLeafId: () => `entry-${String(branch.length)}`,
      getEntryCount: () => branch.length,
    }),
  });
  const base = fake.session.getSessionStats();
  const calculate = vi.fn(() => ({ ...base, cost: branch.length, contextUsage: { tokens: branch.length * 10, contextWindow: 1000, percent: branch.length } }));
  fake.session.getSessionStats = calculate;
  fake.session.getContextUsage = vi.fn(() => { throw new Error("context must come from statistics"); });
  const hub = new CapturingSessionEventHub();
  const log = vi.fn();
  const service = new PiSessionService(hub, {
    agentDir: "/tmp/pi-web-statistics-test-agent",
    modelRuntime: testModelRuntime,
    createAgentRuntime: runtimeCreator(fake.runtime),
    sessionManager: sessionGateway([]),
    logger: { info: log },
  });
  const statuses = () => hub.globalEvents.flatMap((event) => event.type === "status.update" ? [event.status] : []);
  return { service, fake, branch, calculate, hub, statuses, log };
}

const ref = sessionRef("session-1");
const assistant = { role: "assistant", content: [{ type: "text", text: "answer" }] };

afterEach(() => { vi.useRealTimers(); });

describe("PiSessionService statistics freshness", () => {
  it("delivers stream progress and live operational state without recomputing statistics", async () => {
    vi.useFakeTimers();
    const { service, fake, branch, calculate, hub, statuses } = fixture();
    try {
      await service.start("/workspace");
      fake.session.isStreaming = true;
      fake.emit({ type: "agent_start" });
      branch.push({ type: "message", message: { role: "user", content: "hello" } });
      const statusCount = statuses().length;
      for (let i = 0; i < 10; i += 1) {
        fake.emit({ type: "message_update", message: assistant, assistantMessageEvent: { type: "text_delta", delta: "answer" } });
        fake.emit({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", partialResult: { content: [] } });
        fake.emit({ type: "bash_execution_update", delta: "working" });
        expect(await service.status(ref)).toMatchObject({ isStreaming: true, cost: 0 });
      }
      expect(statuses()).toHaveLength(statusCount);
      expect(hub.sessionEvents.some(({ event }) => event.type === "assistant.delta" && event.text === "answer")).toBe(true);
      expect(hub.sessionEvents.some(({ event }) => event.type === "tool.update")).toBe(true);
      expect(calculate).toHaveBeenCalledTimes(1);

      fake.session.pendingMessageCount = 1;
      fake.emit({ type: "queue_update" });
      expect(statuses().at(-1)).toMatchObject({ isStreaming: true, pendingMessageCount: 1, cost: 0 });
      expect((await service.transcriptSnapshot(ref)).status.cost).toBe(0);
      await service.list("/workspace");
      expect(calculate).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2000);
      expect(statuses().at(-1)).toMatchObject({ isStreaming: true, cost: 1, contextUsage: { tokens: 10 } });
      expect(calculate).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(6000);
      expect(calculate).toHaveBeenCalledTimes(2);
    } finally { await service.dispose(); }
  });

  it("coalesces committed messages and publishes final usage after the session becomes idle", async () => {
    vi.useFakeTimers();
    const { service, fake, branch, calculate, statuses } = fixture();
    try {
      await service.start("/workspace");
      fake.session.isStreaming = true;
      fake.emit({ type: "agent_start" });
      for (let i = 0; i < 5; i += 1) {
        // SDK message_end precedes persistence. Neither it nor turn_end scans history.
        fake.emit({ type: "message_end", message: assistant });
        branch.push({ type: "message", message: assistant });
        fake.emit({ type: "turn_end" });
      }
      fake.session.isStreaming = false;
      fake.emit({ type: "agent_end" });
      fake.emit({ type: "agent_settled" });
      expect(statuses().at(-1)).toMatchObject({ isStreaming: false, messageCount: 5, cost: 0 });
      expect(calculate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1999);
      expect(calculate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(statuses().at(-1)).toMatchObject({ isStreaming: false, messageCount: 5, cost: 5 });
      expect(calculate).toHaveBeenCalledTimes(2);
      const published = statuses().length;
      await vi.advanceTimersByTimeAsync(4000);
      expect(calculate).toHaveBeenCalledTimes(2);
      expect(statuses()).toHaveLength(published);
    } finally { await service.dispose(); }
  });

  it("retains statistics on a refresh failure without suppressing operational updates, then retries", async () => {
    vi.useFakeTimers();
    const { service, fake, branch, calculate, statuses, log } = fixture();
    try {
      await service.start("/workspace");
      branch.push({ type: "message", message: assistant });
      fake.session.isStreaming = true;
      calculate.mockImplementationOnce(() => { throw new Error("statistics unavailable"); });
      await vi.advanceTimersByTimeAsync(2000);
      expect(statuses().at(-1)).toMatchObject({ isStreaming: true, cost: 0 });
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ sessionId: ref.id, error: "statistics unavailable" }), expect.any(String));
      await vi.advanceTimersByTimeAsync(2000);
      expect(statuses().at(-1)).toMatchObject({ cost: 1 });
    } finally { await service.dispose(); }
  });

  it("does not publish or refresh a disposed runtime from a delayed agent-end callback", async () => {
    vi.useFakeTimers();
    const { service, fake, calculate, statuses } = fixture();
    await service.start("/workspace");
    fake.emit({ type: "agent_end" });
    await service.dispose();
    const published = statuses().length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(statuses()).toHaveLength(published);
    expect(calculate).toHaveBeenCalledTimes(1);
  });
});
