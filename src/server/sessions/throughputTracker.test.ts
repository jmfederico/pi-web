import { describe, expect, it } from "vitest";
import { ThroughputTracker } from "./throughputTracker.js";

describe("ThroughputTracker", () => {
  it("has no throughput before a completed turn", () => {
    const tracker = new ThroughputTracker();
    expect(tracker.throughput("session-1")).toBeUndefined();
  });

  it("computes overall throughput for a single turn from output tokens over wall-clock", () => {
    const tracker = new ThroughputTracker();
    tracker.beginTurn("session-1", { output: 0 }, 0);
    const result = tracker.completeTurn("session-1", { output: 400 }, 1000);
    expect(result).toEqual({ overall: 400, model: undefined, measuredTurns: 1 });
  });

  it("reports model rate when streaming time was accumulated", () => {
    const tracker = new ThroughputTracker();
    tracker.beginTurn("session-1", { output: 0 }, 0);
    tracker.addStreamingMs("session-1", 200); // 400 output / 200ms * 1000 = 2000 tps
    const result = tracker.completeTurn("session-1", { output: 400 }, 1000);
    // overall: 400 / 1000ms = 400 tps; model: 400 / 200ms = 2000 tps
    expect(result).toEqual({ overall: 400, model: 2000, measuredTurns: 1 });
  });

  it("omits model rate when no streaming time was recorded", () => {
    const tracker = new ThroughputTracker();
    tracker.beginTurn("session-1", { output: 0 }, 0);
    const result = tracker.completeTurn("session-1", { output: 400 }, 1000);
    expect(result?.model).toBeUndefined();
  });

  it("averages across turns weighted by elapsed time, not a simple mean of rates", () => {
    const tracker = new ThroughputTracker();
    // Turn 1: 500 output / 1000ms overall (no streaming)
    tracker.beginTurn("session-1", { output: 0 }, 0);
    tracker.completeTurn("session-1", { output: 500 }, 1000);
    // Turn 2: +300 output / 1000ms overall, 500ms streaming
    tracker.beginTurn("session-1", { output: 500 }, 1000);
    tracker.addStreamingMs("session-1", 500);
    const result = tracker.completeTurn("session-1", { output: 800 }, 2000);
    // Weighted overall: 800 output / 2000ms * 1000 = 400 tps
    // Weighted model: 800 output / 500ms * 1000 = 1600 tps
    expect(result).toEqual({ overall: 400, model: 1600, measuredTurns: 2 });
  });

  it("skips turns with no output-token delta (errors that produced nothing)", () => {
    const tracker = new ThroughputTracker();
    tracker.beginTurn("session-1", { output: 0 }, 0);
    const result = tracker.completeTurn("session-1", { output: 0 }, 1000);
    expect(result).toBeUndefined();
  });

  it("skips turns with zero elapsed time", () => {
    const tracker = new ThroughputTracker();
    tracker.beginTurn("session-1", { output: 0 }, 1000);
    const result = tracker.completeTurn("session-1", { output: 500 }, 1000);
    expect(result).toBeUndefined();
  });

  it("ignores completeTurn without a matching beginTurn (compaction/abort)", () => {
    const tracker = new ThroughputTracker();
    expect(tracker.completeTurn("session-1", { output: 200 }, 1000)).toBeUndefined();
  });

  it("ignores addStreamingMs when no turn is in progress", () => {
    const tracker = new ThroughputTracker();
    tracker.addStreamingMs("session-1", 200);
    tracker.beginTurn("session-1", { output: 0 }, 0);
    const result = tracker.completeTurn("session-1", { output: 400 }, 1000);
    expect(result?.model).toBeUndefined();
  });

  it("discardTurn clears a pending turn without counting it", () => {
    const tracker = new ThroughputTracker();
    tracker.beginTurn("session-1", { output: 0 }, 0);
    tracker.discardTurn("session-1");
    expect(tracker.completeTurn("session-1", { output: 400 }, 1000)).toBeUndefined();
  });

  it("clear removes all state for a session", () => {
    const tracker = new ThroughputTracker();
    tracker.beginTurn("session-1", { output: 0 }, 0);
    tracker.completeTurn("session-1", { output: 400 }, 1000);
    tracker.clear("session-1");
    expect(tracker.throughput("session-1")).toBeUndefined();
  });

  it("tracks sessions independently", () => {
    const tracker = new ThroughputTracker();
    tracker.beginTurn("a", { output: 0 }, 0);
    tracker.completeTurn("a", { output: 40 }, 100);
    tracker.beginTurn("b", { output: 0 }, 0);
    tracker.completeTurn("b", { output: 80 }, 200);
    expect(tracker.throughput("a")).toEqual({ overall: 400, model: undefined, measuredTurns: 1 });
    expect(tracker.throughput("b")).toEqual({ overall: 400, model: undefined, measuredTurns: 1 });
  });
});
