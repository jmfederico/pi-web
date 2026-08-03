/**
 * Per-session average throughput accumulator (tokens/second).
 *
 * Measures end-to-end turn throughput: the time between a prompt being
 * submitted (`beginTurn`) and the turn completing (`completeTurn` on
 * `agent_end`). Token deltas are diffed from cumulative `getSessionStats()`
 * snapshots so the result is immune to pagination, reload, and streaming-only
 * messages that never reach the browser.
 *
 * Two rates are tracked over the same wall-clock interval:
 * - `total` — all tokens (input + output + cache) / elapsed seconds. Tool/bash
 *   time is in the denominator, so a tool-heavy turn looks slow. This is the
 *   "how is the system performing end to end" signal.
 * - `output` — output tokens only / elapsed seconds. This isolates the raw
 *   model emission rate, the "how fast is the model" signal.
 *
 * The average is **weighted** (`ΣΔtokens / Σms`), not a simple mean of per-turn
 * rates: a 2-token fluke turn cannot dominate a 5000-token turn.
 *
 * In-memory only; resets on sessiond restart. Add persistence when a restart
 * wiping the average becomes bothersome.
 */
export interface TurnTokenSnapshot {
  total: number;
  output: number;
}

export interface SessionThroughput {
  /** Total tokens (input + output + cache) per second, weighted across turns. */
  total: number;
  /** Output tokens per second, weighted across turns. */
  output: number;
  measuredTurns: number;
}

interface PendingTurn {
  startMs: number;
  totalAtStart: number;
  outputAtStart: number;
}

interface Accumulator {
  pendingTurn: PendingTurn | undefined;
  totalTokens: number;
  totalOutputTokens: number;
  totalMs: number;
  measuredTurns: number;
}

export class ThroughputTracker {
  private readonly sessions = new Map<string, Accumulator>();

  beginTurn(sessionId: string, snapshot: TurnTokenSnapshot, now: number): void {
    this.accumulator(sessionId).pendingTurn = { startMs: now, totalAtStart: snapshot.total, outputAtStart: snapshot.output };
  }

  /** Finalises the current turn. Returns updated throughput, or `undefined` if no turn was in progress or the turn produced no data. */
  completeTurn(sessionId: string, snapshot: TurnTokenSnapshot, now: number): SessionThroughput | undefined {
    const acc = this.sessions.get(sessionId);
    const pending = acc?.pendingTurn;
    if (acc === undefined || pending === undefined) return undefined;
    acc.pendingTurn = undefined;
    const elapsedMs = now - pending.startMs;
    const totalDelta = snapshot.total - pending.totalAtStart;
    const outputDelta = snapshot.output - pending.outputAtStart;
    // ponytail: skip zero-token / zero-time turns rather than tracking errors
    // explicitly. Covers most error/abort cases; a turn that errored after
    // producing some tokens is still real throughput data, so counting it is
    // acceptable. Upgrade to explicit error detection if that distinction matters.
    if (elapsedMs <= 0 || totalDelta <= 0) return this.throughput(sessionId);
    acc.totalTokens += totalDelta;
    acc.totalOutputTokens += outputDelta;
    acc.totalMs += elapsedMs;
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
    if (acc === undefined || acc.measuredTurns === 0 || acc.totalMs <= 0) return undefined;
    return {
      total: (acc.totalTokens / acc.totalMs) * 1000,
      output: (acc.totalOutputTokens / acc.totalMs) * 1000,
      measuredTurns: acc.measuredTurns,
    };
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private accumulator(sessionId: string): Accumulator {
    let acc = this.sessions.get(sessionId);
    if (acc === undefined) {
      acc = { pendingTurn: undefined, totalTokens: 0, totalOutputTokens: 0, totalMs: 0, measuredTurns: 0 };
      this.sessions.set(sessionId, acc);
    }
    return acc;
  }
}
