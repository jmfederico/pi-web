import { describe, expect, it } from "vitest";
import { ThroughputTracker } from "./throughputTracker.js";

describe("ThroughputTracker", () => {
  it("has no throughput before a completed turn", () => {
    const tracker = new ThroughputTracker();
    expect(tracker.throughput("session-1")).toBeUndefined();
  });

  it("computes throughput for a single turn as tokens per second", () => {
    const tracker = new ThroughputTracker();
    tracker.beginTurn("session-1", { input: 0, output: 0 }, 0);
    const result = tracker.completeTurn("session-1", { input: 600, output: 400 }, 1000);
    expect(result).toEqual({ total: 1000, output: 400, measuredTurns: 1 });
  });

  it("averages across turns weighted by elapsed time, not a simple mean of rates", () => {
    const tracker = new ThroughputTracker();
    // Turn 1: 1000 processed (input+output) / 500 output in 1000ms → 1000 total tps, 500 output tps
    tracker.beginTurn("session-1", { input: 0, output: 0 }, 0);
    tracker.completeTurn("session-1", { input: 500, output: 500 }, 1000);
    // Turn 2: +3000 processed / +300 output in 1000ms → 3000 total tps, 300 output tps
    tracker.beginTurn("session-1", { input: 500, output: 500 }, 1000);
    const result = tracker.completeTurn("session-1", { input: 3200, output: 800 }, 2000);
    // Weighted: 4000 processed / 2000ms * 1000 = 2000 tps; 800 output / 2000ms * 1000 = 400 tps
    expect(result).toEqual({ total: 2000, output: 400, measuredTurns: 2 });
  });

  it("counts only input+output as total, excluding cache reads", () => {
    const tracker = new ThroughputTracker();
    // Snapshot carries only input+output; cache is excluded by the caller.
    tracker.beginTurn("session-1", { input: 0, output: 0 }, 0);
    const result = tracker.completeTurn("session-1", { input: 60, output: 40 }, 1000);
    // 100 processed / 1000ms * 1000 = 100 tps total, not inflated by cache
    expect(result).toEqual({ total: 100, output: 40, measuredTurns: 1 });
  });

  it("skips turns with no token delta (errors that produced nothing)", () => {
    const tracker = new ThroughputTracker();
    tracker.beginTurn("session-1", { input: 0, output: 0 }, 0);
    const result = tracker.completeTurn("session-1", { input: 0, output: 0 }, 1000);
    expect(result).toBeUndefined();
  });

  it("skips turns with zero elapsed time", () => {
    const tracker = new ThroughputTracker();
    tracker.beginTurn("session-1", { input: 0, output: 0 }, 1000);
    const result = tracker.completeTurn("session-1", { input: 300, output: 200 }, 1000);
    expect(result).toBeUndefined();
  });

  it("ignores completeTurn without a matching beginTurn (compaction/abort)", () => {
    const tracker = new ThroughputTracker();
    expect(tracker.completeTurn("session-1", { input: 300, output: 200 }, 1000)).toBeUndefined();
  });

  it("discardTurn clears a pending turn without counting it", () => {
    const tracker = new ThroughputTracker();
    tracker.beginTurn("session-1", { input: 0, output: 0 }, 0);
    tracker.discardTurn("session-1");
    expect(tracker.completeTurn("session-1", { input: 600, output: 400 }, 1000)).toBeUndefined();
  });

  it("clear removes all state for a session", () => {
    const tracker = new ThroughputTracker();
    tracker.beginTurn("session-1", { input: 0, output: 0 }, 0);
    tracker.completeTurn("session-1", { input: 600, output: 400 }, 1000);
    tracker.clear("session-1");
    expect(tracker.throughput("session-1")).toBeUndefined();
  });

  it("tracks sessions independently", () => {
    const tracker = new ThroughputTracker();
    tracker.beginTurn("a", { input: 0, output: 0 }, 0);
    tracker.completeTurn("a", { input: 60, output: 40 }, 100);
    tracker.beginTurn("b", { input: 0, output: 0 }, 0);
    tracker.completeTurn("b", { input: 120, output: 80 }, 200);
    expect(tracker.throughput("a")).toEqual({ total: 1000, output: 400, measuredTurns: 1 });
    expect(tracker.throughput("b")).toEqual({ total: 1000, output: 400, measuredTurns: 1 });
  });
});
