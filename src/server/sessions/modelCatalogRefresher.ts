import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Tick hourly and let pi decide when a fetch is actually due: pi treats stored
 * catalogs as fresh for REMOTE_CATALOG_REFRESH_INTERVAL_MS (4h) and skips the
 * network entirely on an unforced refresh inside that window. Ticking at
 * exactly 4h would land a few seconds short of the window every time, because
 * pi stamps `checkedAt` only after a fetch completes, so every other tick would
 * be skipped and the real cadence would be ~8h. A shorter interval removes that
 * off-by-one-latency skip, tolerates clock skew, and costs nothing when the
 * cache is fresh, because scheduled runs never set `force`.
 */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
/** Give the daemon a moment to finish startup before the first network refresh. */
const DEFAULT_INITIAL_DELAY_MS = 15_000;
/**
 * Bound every catalog refresh so a stalled provider fetch cannot run forever.
 * One run covers every refreshable provider under a single signal, so this is a
 * whole-cycle budget for a background job, not pi's 15s startup budget.
 */
const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * Wait this long before the single follow-up attempt that a timed-out or failed
 * run earns, so a transient network problem does not cost a whole interval.
 */
const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1000;

/**
 * Scheduled runs defer to pi's freshness gate; forced runs bypass it because
 * the caller knows the cached catalog is wrong (for example after a login).
 */
type RefreshMode = "scheduled" | "forced";

/** A queued follow-up must keep the strongest mode requested while a run was in flight. */
const strongestMode = (left: RefreshMode | undefined, right: RefreshMode): RefreshMode =>
  left === "forced" || right === "forced" ? "forced" : "scheduled";

/** Whether a run finished with a complete picture, or earned a retry. */
type RunOutcome = "complete" | "incomplete";

/** Minimal structured-logging seam for refresh lifecycle and non-fatal failures. */
export interface ModelCatalogRefresherLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface ModelCatalogRefresherOptions {
  runtime: Pick<ModelRuntime, "refresh">;
  logger?: ModelCatalogRefresherLogger;
  /**
   * When true the operator asked for offline behavior, so no network refresh is
   * ever attempted. Injected from the daemon environment instead of read from
   * `process.env` here, so the decision stays explicit and testable.
   */
  offline?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
}

const noopLogger: ModelCatalogRefresherLogger = {
  info() { /* no-op */ },
  warn() { /* no-op */ },
  error() { /* no-op */ },
};

/**
 * Refreshes provider model catalogs over the network on a background schedule.
 *
 * The shared ModelRuntime keeps its own refreshes local-only (pi 0.84 does so
 * by default, and pi-web request paths pass `allowNetwork: false` explicitly —
 * see authService.ts), so they stay fast. This refresher is the single place
 * that deliberately performs network refreshes —
 * bounded by an abort timeout, serialized through one in-flight run, stopped by
 * `dispose()` even mid-flight, and off any request path. `requestRefresh()`
 * additionally asks for a prompt forced refresh after events that change what
 * should be listed, such as provider logins, where the cached catalog is known
 * to be wrong.
 *
 * When the operator asked for offline behavior (`PI_OFFLINE` / `PI_WEB_OFFLINE`),
 * the refresher performs no network I/O at all and the cached catalogs in
 * models-store.json are used as they are.
 */
export class ModelCatalogRefresher {
  private readonly runtime: Pick<ModelRuntime, "refresh">;
  private readonly logger: ModelCatalogRefresherLogger;
  private readonly offline: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private initialTimer?: NodeJS.Timeout;
  private intervalTimer?: NodeJS.Timeout;
  private retryTimer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> | undefined;
  private queuedMode: RefreshMode | undefined;
  private started = false;
  private disposed = false;
  /**
   * Aborted by `dispose()` so a refresh already in flight stops with the
   * refresher instead of holding its fetch open for the rest of the timeout
   * budget, which would delay daemon shutdown.
   */
  private readonly lifetime = new AbortController();

  constructor(options: ModelCatalogRefresherOptions) {
    this.runtime = options.runtime;
    this.logger = options.logger ?? noopLogger;
    this.offline = options.offline ?? false;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  /** Idempotent: a second call keeps the timers the first call installed. */
  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    if (this.offline) {
      this.logger.info({}, "offline mode is enabled; skipping background model catalog refreshes");
      return;
    }
    this.initialTimer = setTimeout(() => { this.queueRefresh("scheduled"); }, this.initialDelayMs);
    this.initialTimer.unref();
    this.intervalTimer = setInterval(() => { this.queueRefresh("scheduled"); }, this.intervalMs);
    this.intervalTimer.unref();
  }

  /**
   * Ask for an immediate refresh that bypasses pi's freshness gate, for callers
   * that know the cached catalog is stale (auth changes). Coalesces with
   * concurrent and overlapping requests, and is a no-op in offline mode so auth
   * changes never trigger network I/O either.
   */
  requestRefresh(): void {
    this.queueRefresh("forced");
  }

  /**
   * Whether a network catalog refresh is running right now. Read-only: callers
   * that report what a slow operation is concurrent with need this fact, and
   * must not be able to change the refresh schedule by asking for it.
   */
  isRefreshInFlight(): boolean {
    return this.inflight !== undefined;
  }

  /** Terminal: stops the schedule, drops any queued follow-up, and aborts an in-flight run. */
  dispose(): void {
    this.disposed = true;
    if (this.initialTimer !== undefined) clearTimeout(this.initialTimer);
    if (this.intervalTimer !== undefined) clearInterval(this.intervalTimer);
    this.clearRetryTimer();
    this.lifetime.abort();
  }

  /**
   * Single entry point for every refresh trigger. Only one run is ever in
   * flight; overlapping requests collapse into one follow-up that keeps the
   * strongest mode asked for, so a forced request is never downgraded.
   */
  private queueRefresh(mode: RefreshMode, isRetry = false): void {
    if (this.disposed || this.offline) return;
    // Any fresh trigger supersedes a pending retry, which keeps retries from
    // stacking up behind normal activity.
    if (!isRetry) this.clearRetryTimer();
    if (this.inflight !== undefined) {
      this.queuedMode = strongestMode(this.queuedMode, mode);
      return;
    }
    // runCycle() reports every failure through the logger and never rejects.
    this.inflight = this.runCycle(mode, isRetry);
  }

  /** One run plus the follow-up it leads to: a queued request, a single retry, or nothing. */
  private async runCycle(mode: RefreshMode, isRetry: boolean): Promise<void> {
    const outcome = await this.run(mode);
    this.inflight = undefined;
    const queued = this.queuedMode;
    this.queuedMode = undefined;
    if (queued !== undefined) {
      // A request that arrived during the run replaces any retry this run would
      // have earned; it runs now instead.
      this.queueRefresh(queued);
      return;
    }
    // Only a first attempt earns a retry, so a failing provider can never turn
    // into a retry loop.
    if (outcome === "incomplete" && !isRetry) this.scheduleRetry(mode);
  }

  private scheduleRetry(mode: RefreshMode): void {
    if (this.disposed) return;
    this.logger.info({ retryDelayMs: this.retryDelayMs, mode }, "scheduling one model catalog refresh retry");
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.queueRefresh(mode, true);
    }, this.retryDelayMs);
    this.retryTimer.unref();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === undefined) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async run(mode: RefreshMode): Promise<RunOutcome> {
    try {
      const result = await this.runtime.refresh({
        allowNetwork: true,
        force: mode === "forced",
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs)]),
      });
      if (result.aborted && this.lifetime.signal.aborted) {
        this.logStoppedByDispose();
        return "incomplete";
      }
      if (result.aborted) {
        this.logger.warn({ timeoutMs: this.timeoutMs }, "model catalog refresh timed out; keeping cached catalogs");
      }
      if (result.errors.size > 0) {
        const providers = [...result.errors.entries()].map(([providerId, error]) => `${providerId}: ${error.message}`);
        this.logger.warn({ providers }, "model catalog refresh failed for some providers; keeping cached catalogs");
      }
      return result.aborted || result.errors.size > 0 ? "incomplete" : "complete";
    } catch (error: unknown) {
      if (this.lifetime.signal.aborted) this.logStoppedByDispose();
      else this.logger.error({ err: error }, "model catalog refresh failed; keeping cached catalogs");
      return "incomplete";
    }
  }

  /** A shutdown abort is expected, so it must not be reported as a timeout or a fault. */
  private logStoppedByDispose(): void {
    this.logger.info({}, "model catalog refresh aborted by dispose; keeping cached catalogs");
  }
}
