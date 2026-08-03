import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ThroughputTracker } from "./throughputTracker.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryFile(name = "throughput.json"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-throughput-"));
  roots.push(root);
  return join(root, name);
}

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

describe("ThroughputTracker persistence", () => {
  it("load() on a missing file is a no-op", async () => {
    const path = await temporaryFile();
    const tracker = new ThroughputTracker(path);
    await tracker.load();
    expect(tracker.throughput("session-1")).toBeUndefined();
  });

  it("load() on a corrupt file logs and starts fresh", async () => {
    const path = await temporaryFile();
    await writeFile(path, "{not-json", "utf8");
    const tracker = new ThroughputTracker(path);
    await tracker.load();
    expect(tracker.throughput("session-1")).toBeUndefined();
    // Subsequent save should overwrite the corrupt file with a valid empty document.
    await tracker.save();
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(parsed).toEqual({ sessions: {} });
  });

  it("save() after completeTurn writes the totals to disk", async () => {
    const path = await temporaryFile();
    const tracker = new ThroughputTracker(path);
    await tracker.load();
    tracker.beginTurn("session-1", { output: 0 }, 0);
    tracker.completeTurn("session-1", { output: 400 }, 1000);
    await tracker.save();
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(parsed).toEqual({
      sessions: {
        "session-1": { totalOutputTokens: 400, totalWallMs: 1000, totalStreamingMs: 0, measuredTurns: 1 },
      },
    });
  });

  it("load() round-trips a saved tracker across instances", async () => {
    const path = await temporaryFile();

    const writer = new ThroughputTracker(path);
    await writer.load();
    writer.beginTurn("session-1", { output: 0 }, 0);
    writer.addStreamingMs("session-1", 200);
    writer.completeTurn("session-1", { output: 400 }, 1000);
    await writer.save();

    const reader = new ThroughputTracker(path);
    await reader.load();
    expect(reader.throughput("session-1")).toEqual({ overall: 400, model: 2000, measuredTurns: 1 });
  });

  it("save() omits sessions that have no completed turn yet", async () => {
    const path = await temporaryFile();
    const tracker = new ThroughputTracker(path);
    await tracker.load();
    tracker.beginTurn("session-1", { output: 0 }, 0);
    await tracker.save();
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(parsed).toEqual({ sessions: {} });
  });

  it("clear() drops the entry from the saved file", async () => {
    const path = await temporaryFile();
    const tracker = new ThroughputTracker(path);
    await tracker.load();
    tracker.beginTurn("session-1", { output: 0 }, 0);
    tracker.completeTurn("session-1", { output: 400 }, 1000);
    tracker.beginTurn("session-2", { output: 0 }, 0);
    tracker.completeTurn("session-2", { output: 200 }, 500);
    await tracker.save();
    tracker.clear("session-1");
    await tracker.save();
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(parsed).toEqual({
      sessions: {
        "session-2": { totalOutputTokens: 200, totalWallMs: 500, totalStreamingMs: 0, measuredTurns: 1 },
      },
    });
  });

  it("a tracker constructed without a filePath stays in-memory only", async () => {
    const tracker = new ThroughputTracker();
    tracker.beginTurn("session-1", { output: 0 }, 0);
    expect(tracker.completeTurn("session-1", { output: 400 }, 1000)).toEqual({ overall: 400, model: undefined, measuredTurns: 1 });
    // save() and load() are no-ops when no filePath is configured.
    await tracker.save();
    await tracker.load();
    expect(tracker.throughput("session-1")).toEqual({ overall: 400, model: undefined, measuredTurns: 1 });
  });

  it("a second turn after load() keeps accumulating against the loaded totals", async () => {
    const path = await temporaryFile();

    const writer = new ThroughputTracker(path);
    await writer.load();
    writer.beginTurn("session-1", { output: 0 }, 0);
    writer.completeTurn("session-1", { output: 400 }, 1000); // 400 tps overall
    await writer.save();

    const reader = new ThroughputTracker(path);
    await reader.load();
    reader.beginTurn("session-1", { output: 400 }, 2000);
    reader.completeTurn("session-1", { output: 800 }, 3000); // +400 output, +1000ms
    // Weighted overall: 800 / 2000 * 1000 = 400 tps; two measured turns.
    expect(reader.throughput("session-1")).toEqual({ overall: 400, model: undefined, measuredTurns: 2 });
  });
});
