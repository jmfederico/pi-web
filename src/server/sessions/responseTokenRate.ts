export interface ResponseTokenRateSample {
  outputTokens: number;
  at: Date;
}

/** Calculates generated output tokens per second for one agent response. */
export function responseTokensPerSecond(start: ResponseTokenRateSample, end: ResponseTokenRateSample): number | undefined {
  const tokenDelta = end.outputTokens - start.outputTokens;
  const elapsedMilliseconds = end.at.getTime() - start.at.getTime();
  if (!Number.isFinite(tokenDelta) || tokenDelta <= 0 || !Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds <= 0) return undefined;
  return tokenDelta / (elapsedMilliseconds / 1000);
}

/** Keeps the current/most-recent generated-response rate scoped to a live session runtime. */
export class ResponseTokenRateTracker<T extends object> {
  private readonly starts = new WeakMap<T, { outputTokens: number; at?: Date }>();
  private readonly rates = new WeakMap<T, number>();

  begin(session: T, outputTokens: number): void {
    this.starts.set(session, { outputTokens });
    this.rates.delete(session);
  }

  hasStarted(session: T): boolean {
    return this.starts.get(session)?.at !== undefined;
  }

  startTiming(session: T, at: Date): void {
    const start = this.starts.get(session);
    if (start === undefined || start.at !== undefined) return;
    start.at = at;
  }

  sample(session: T, sample: ResponseTokenRateSample): void {
    const start = this.starts.get(session);
    if (start?.at === undefined) return;
    const rate = responseTokensPerSecond({ outputTokens: start.outputTokens, at: start.at }, sample);
    if (rate !== undefined) this.rates.set(session, rate);
  }

  rate(session: T): number | undefined {
    return this.rates.get(session);
  }
}
