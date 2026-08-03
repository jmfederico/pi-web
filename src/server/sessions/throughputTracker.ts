/**
 * Per-session average throughput accumulator (tokens/second).
 *
 * Measures end-to-end turn throughput: the time between a prompt being
 * submitted (`beginTurn`) and the turn completing (`completeTurn` on
 * `agent_end`). Output-token deltas are diffed from cumulative
 * `getSessionStats()` snapshots so the result is immune to pagination,
 * reload, and streaming-only messages that never reach the browser.
 *
 * Two rates share the **same output-token numerator** and differ by
 * denominator — the only honest way to expose "system speed" vs "model speed":
 * - `overall` — output tokens / full turn wall-clock (submit → agent_end).
 *   Tool/bash time is in the denominator, so a tool-heavy turn looks slow.
 *   This is the "how is the system performing end to end" signal.
 * - `model` — output tokens / streaming-only wall-clock, where streaming
 *   time is accumulated from assistant `message_start`→`message_end` windows
 *   (which excludes tool/bash execution). This is the raw model emission rate.
 *
 * Why output-only numerator: the SDK's `getSessionStats().input` sums
 * `usage.input` across every LLM call in the turn, recounting the conversation
 * context once per tool round-trip. It is a billing aggregate, not a
 * throughput, so `input + output` / time is not physically meaningful.
 *
 * The average is **weighted** (`Σoutput / Σtime`), not a simple mean of
 * per-turn rates: a 2-token fluke turn cannot dominate a 5000-token turn.
 *
 * State is persisted to a single JSON file at the configured path. The
 * accumulator totals are written after every completed turn and every
 * `clear()`; the in-flight `pendingTurn` is intentionally not persisted —
 * its streaming time is folded into the totals on the next `agent_end`,
 * so persisting it would require a write on every `message_end` for one
 * value that the next turn replaces anyway. The tracker is in-memory only
 * when constructed without a `filePath`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { piWebDataDir } from "../../config.js";

export interface TurnTokenSnapshot {
  output: number;
}

export interface SessionThroughput {
  /** Output tokens per second over the full turn wall-clock (tools included). */
  overall: number;
  /** Output tokens per second over streaming-only time (tools excluded). `undefined` when no streaming time was recorded. */
  model: number | undefined;
  measuredTurns: number;
}

interface PendingTurn {
  startMs: number;
  outputAtStart: number;
  streamingMs: number;
}

interface Accumulator {
  pendingTurn: PendingTurn | undefined;
  totalOutputTokens: number;
  totalWallMs: number;
  totalStreamingMs: number;
  measuredTurns: number;
}

interface PersistedTotals {
  totalOutputTokens: number;
  totalWallMs: number;
  totalStreamingMs: number;
  measuredTurns: number;
}

interface PersistedFile {
  sessions: Record<string, PersistedTotals>;
}

export function defaultThroughputFilePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebDataDir(env, cwd), "throughput.json");
}

export class ThroughputTracker {
  private readonly sessions = new Map<string, Accumulator>();
  /** Most recent in-flight save. `save()` awaits it so tests and explicit flushes see the latest write. */
  private lastSave: Promise<void> = Promise.resolve();

  constructor(private readonly filePath?: string) {}

  beginTurn(sessionId: string, snapshot: TurnTokenSnapshot, now: number): void {
    this.accumulator(sessionId).pendingTurn = { startMs: now, outputAtStart: snapshot.output, streamingMs: 0 };
  }

  /** Accumulate streaming (model-generating) time within the current turn, from assistant message windows. */
  addStreamingMs(sessionId: string, ms: number): void {
    const pending = this.sessions.get(sessionId)?.pendingTurn;
    if (pending !== undefined && ms > 0) pending.streamingMs += ms;
  }

  /** Finalises the current turn. Returns updated throughput, or `undefined` if no turn was in progress or the turn produced no data. */
  completeTurn(sessionId: string, snapshot: TurnTokenSnapshot, now: number): SessionThroughput | undefined {
    const acc = this.sessions.get(sessionId);
    const pending = acc?.pendingTurn;
    if (acc === undefined || pending === undefined) return undefined;
    acc.pendingTurn = undefined;
    const wallMs = now - pending.startMs;
    const outputDelta = snapshot.output - pending.outputAtStart;
    // ponytail: skip zero-token / zero-time turns rather than tracking errors
    // explicitly. Covers most error/abort cases; a turn that errored after
    // producing some tokens is still real throughput data, so counting it is
    // acceptable. Upgrade to explicit error detection if that distinction matters.
    if (wallMs <= 0 || outputDelta <= 0) return this.throughput(sessionId);
    acc.totalOutputTokens += outputDelta;
    acc.totalWallMs += wallMs;
    acc.totalStreamingMs += pending.streamingMs;
    acc.measuredTurns += 1;
    this.scheduleSave();
    return this.throughput(sessionId);
  }

  /** Drops the pending turn without accumulating (e.g. explicit abort before any tokens). */
  discardTurn(sessionId: string): void {
    const acc = this.sessions.get(sessionId);
    if (acc !== undefined) acc.pendingTurn = undefined;
  }

  throughput(sessionId: string): SessionThroughput | undefined {
    const acc = this.sessions.get(sessionId);
    if (acc === undefined || acc.measuredTurns === 0 || acc.totalWallMs <= 0) return undefined;
    return {
      overall: (acc.totalOutputTokens / acc.totalWallMs) * 1000,
      model: acc.totalStreamingMs > 0 ? (acc.totalOutputTokens / acc.totalStreamingMs) * 1000 : undefined,
      measuredTurns: acc.measuredTurns,
    };
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.scheduleSave();
  }

  /**
   * Hydrate accumulated totals from disk. A missing file is a no-op; a corrupt
   * file is logged and treated as empty so a transient write error cannot
   * permanently brick the indicator. Called once at sessiond startup, before
   * the tracker is handed to `PiSessionService`.
   */
  async load(): Promise<void> {
    if (this.filePath === undefined) return;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) return;
      // ponytail: skip a dedicated onError callback; the persistence path is
      // single-purpose and a console.error is enough for an operator. Replace
      // with structured logging when this tracker gains more than one caller.
      console.error("throughput persistence read failed; starting fresh", error);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.error("throughput persistence file is corrupt; starting fresh", error);
      return;
    }
    if (!isRecord(parsed) || !isRecord(parsed["sessions"])) return;
    for (const [sessionId, totals] of Object.entries(parsed["sessions"])) {
      if (!isRecord(totals)) continue;
      const totalOutputTokens = numberOrZero(totals["totalOutputTokens"]);
      const totalWallMs = numberOrZero(totals["totalWallMs"]);
      const totalStreamingMs = numberOrZero(totals["totalStreamingMs"]);
      const measuredTurns = numberOrZero(totals["measuredTurns"]);
      // A row without a valid wall-clock or turn count is the same as a row
      // the running tracker already rejects in `throughput()`; drop it.
      if (totalWallMs <= 0 || measuredTurns <= 0) continue;
      this.sessions.set(sessionId, {
        pendingTurn: undefined,
        totalOutputTokens,
        totalWallMs,
        totalStreamingMs,
        measuredTurns,
      });
    }
  }

  /**
   * Write the current totals to disk. Awaits any in-flight save first, so
   * callers (tests, shutdown flushes) can rely on the file reflecting the
   * latest state by the time the returned Promise resolves. No-op when the
   * tracker was constructed without a `filePath`.
   */
  async save(): Promise<void> {
    if (this.filePath === undefined) return;
    await this.lastSave;
    const promise = this.writeToDisk();
    this.lastSave = promise;
    await promise;
  }

  private scheduleSave(): void {
    if (this.filePath === undefined) return;
    this.lastSave = this.writeToDisk().catch((error: unknown) => {
      // ponytail: swallow save errors and let the next turn overwrite the file.
      // The worst case is losing a few turns of history to a transient I/O
      // error, which the next successful save repairs. Upgrade to a retry
      // queue or an error channel when the operator needs alerting.
      console.error("throughput persistence write failed", error);
    });
  }

  private async writeToDisk(): Promise<void> {
    if (this.filePath === undefined) return;
    const data: PersistedFile = { sessions: {} };
    for (const [sessionId, acc] of this.sessions) {
      // Skip sessions that only have a pending turn — those will be written
      // when (or if) the turn completes.
      if (acc.measuredTurns === 0) continue;
      data.sessions[sessionId] = {
        totalOutputTokens: acc.totalOutputTokens,
        totalWallMs: acc.totalWallMs,
        totalStreamingMs: acc.totalStreamingMs,
        measuredTurns: acc.measuredTurns,
      };
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  private accumulator(sessionId: string): Accumulator {
    let acc = this.sessions.get(sessionId);
    if (acc === undefined) {
      acc = { pendingTurn: undefined, totalOutputTokens: 0, totalWallMs: 0, totalStreamingMs: 0, measuredTurns: 0 };
      this.sessions.set(sessionId, acc);
    }
    return acc;
  }
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
