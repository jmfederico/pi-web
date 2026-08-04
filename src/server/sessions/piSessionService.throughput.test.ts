import { describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

interface MutableStats {
  output: number;
}

function throughputService(stats: MutableStats) {
  const fake = fakeRuntime("session-1", {
    sessionFile: "/tmp/session-1.jsonl",
    sessionManager: fakeSessionManager("/workspace", { getSessionId: () => "session-1" }),
    getSessionStats: () => ({
      sessionId: "session-1",
      totalMessages: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0,
      tokens: { input: 0, output: stats.output, cacheRead: 0, cacheWrite: 0, total: stats.output },
      cost: 0,
    }),
  });
  const events = new CapturingSessionEventHub();
  const service = new PiSessionService(events, {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    createAgentRuntime: runtimeCreator(fake.runtime),
    sessionManager: sessionGateway([sessionRecord("session-1")]),
    heartbeatIntervalMs: 60_000,
  });
  return { fake, service, events };
}

describe("PiSessionService throughput", () => {
  it("publishes overall throughput in session status after a completed turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const stats: MutableStats = { output: 0 };
    const { fake, service } = throughputService(stats);

    await service.status(sessionRef("session-1")); // bring session online

    // Turn: prompt at t=0, turn ends at t=1s with 800 output tokens
    await service.prompt(sessionRef("session-1"), "hello");
    stats.output = 800;
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    fake.emit({ type: "agent_end" });

    const status = await service.status(sessionRef("session-1"));
    expect(status.throughput).toEqual({ overall: 800, model: undefined, measuredTurns: 1 });

    await service.dispose();
    vi.useRealTimers();
  });

  it("publishes model rate from message_start/message_end streaming windows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const stats: MutableStats = { output: 0 };
    const { fake, service } = throughputService(stats);

    await service.status(sessionRef("session-1"));

    // Turn: 1s wall-clock, but only 200ms of model streaming (between message_start and message_end)
    await service.prompt(sessionRef("session-1"), "hello");
    vi.setSystemTime(new Date("2026-01-01T00:00:00.400Z"));
    fake.emit({ type: "message_start" });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.600Z"));
    fake.emit({ type: "message_end" });
    stats.output = 800;
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    fake.emit({ type: "agent_end" });

    const status = await service.status(sessionRef("session-1"));
    // overall: 800 output / 1000ms = 800 tps; model: 800 output / 200ms = 4000 tps
    expect(status.throughput).toEqual({ overall: 800, model: 4000, measuredTurns: 1 });

    await service.dispose();
    vi.useRealTimers();
  });

  it("accumulates throughput across multiple turns as a weighted average", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const stats: MutableStats = { output: 0 };
    const { fake, service } = throughputService(stats);

    await service.status(sessionRef("session-1"));

    // Turn 1: 500 output / 1000ms, no streaming
    stats.output = 0;
    await service.prompt(sessionRef("session-1"), "first");
    stats.output = 500;
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    fake.emit({ type: "agent_end" });

    // Turn 2: +300 output / 1000ms, 500ms streaming
    stats.output = 500;
    await service.prompt(sessionRef("session-1"), "second");
    vi.setSystemTime(new Date("2026-01-01T00:00:01.200Z"));
    fake.emit({ type: "message_start" });
    vi.setSystemTime(new Date("2026-01-01T00:00:01.700Z"));
    fake.emit({ type: "message_end" });
    stats.output = 800;
    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    fake.emit({ type: "agent_end" });

    const status = await service.status(sessionRef("session-1"));
    // Weighted overall: 800 output / 2000ms * 1000 = 400 tps
    // Weighted model: 800 output / 500ms * 1000 = 1600 tps
    expect(status.throughput).toEqual({ overall: 400, model: 1600, measuredTurns: 2 });

    await service.dispose();
    vi.useRealTimers();
  });

  it("does not count agent_end without a preceding prompt (compaction, spurious events)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const stats: MutableStats = { output: 0 };
    const { fake, service } = throughputService(stats);

    await service.status(sessionRef("session-1")); // bring session online

    // Tokens grew (e.g. compaction ran) but no prompt was submitted, so no turn was begun
    stats.output = 500;
    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    fake.emit({ type: "agent_end" });

    const status = await service.status(sessionRef("session-1"));
    expect(status.throughput).toBeUndefined();

    await service.dispose();
    vi.useRealTimers();
  });
});
