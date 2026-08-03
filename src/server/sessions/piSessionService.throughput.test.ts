import { describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

interface MutableStats {
  total: number;
  output: number;
}

function throughputService(stats: MutableStats) {
  const fake = fakeRuntime("session-1", {
    sessionFile: "/tmp/session-1.jsonl",
    sessionManager: fakeSessionManager("/workspace", { getSessionId: () => "session-1" }),
    getSessionStats: () => ({
      sessionId: "session-1",
      totalMessages: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0,
      tokens: { input: 0, output: stats.output, cacheRead: 0, cacheWrite: 0, total: stats.total },
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
  it("publishes throughput in session status after a completed turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const stats: MutableStats = { total: 0, output: 0 };
    const { fake, service } = throughputService(stats);

    await service.status(sessionRef("session-1")); // bring session online

    // Turn: prompt submitted at t=0, turn ends at t=1s with 2000 total / 800 output tokens
    await service.prompt(sessionRef("session-1"), "hello");
    stats.total = 2000;
    stats.output = 800;
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    fake.emit({ type: "agent_end" });

    const status = await service.status(sessionRef("session-1"));
    expect(status.throughput).toEqual({ total: 2000, output: 800, measuredTurns: 1 });

    await service.dispose();
    vi.useRealTimers();
  });

  it("accumulates throughput across multiple turns as a weighted average", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const stats: MutableStats = { total: 0, output: 0 };
    const { fake, service } = throughputService(stats);

    await service.status(sessionRef("session-1"));

    // Turn 1: 1000 total / 500 output in 1000ms
    stats.total = 0; stats.output = 0;
    await service.prompt(sessionRef("session-1"), "first");
    stats.total = 1000; stats.output = 500;
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    fake.emit({ type: "agent_end" });

    // Turn 2: +3000 total / +300 output in 1000ms
    stats.total = 1000; stats.output = 500;
    await service.prompt(sessionRef("session-1"), "second");
    stats.total = 4000; stats.output = 800;
    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    fake.emit({ type: "agent_end" });

    const status = await service.status(sessionRef("session-1"));
    // Weighted: 4000 total / 2000ms * 1000 = 2000 tps; 800 output / 2000ms * 1000 = 400 tps
    expect(status.throughput).toEqual({ total: 2000, output: 400, measuredTurns: 2 });

    await service.dispose();
    vi.useRealTimers();
  });

  it("does not count agent_end without a preceding prompt (compaction, spurious events)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const stats: MutableStats = { total: 0, output: 0 };
    const { fake, service } = throughputService(stats);

    await service.status(sessionRef("session-1")); // bring session online

    // Tokens grew (e.g. compaction ran) but no prompt was submitted, so no turn was begun
    stats.total = 500;
    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    fake.emit({ type: "agent_end" });

    const status = await service.status(sessionRef("session-1"));
    expect(status.throughput).toBeUndefined();

    await service.dispose();
    vi.useRealTimers();
  });
});
