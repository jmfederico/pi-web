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
 * In-memory only; resets on sessiond restart. Add persistence when a restart
 * wiping the average becomes bothersome.
 */
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

export class ThroughputTracker {
  private readonly sessions = new Map<string, Accumulator>();

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
