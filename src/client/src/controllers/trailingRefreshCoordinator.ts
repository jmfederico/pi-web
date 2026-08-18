interface PendingRefresh {
  promise: Promise<void>;
  latestRefresh: () => Promise<void>;
  phase: "debouncing" | "running";
  trailing: boolean;
  debounceTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  finishDebounce: (() => void) | undefined;
}

/**
 * Shares refresh work requested in the same task and collapses requests made
 * during an active refresh into one trailing pass, without losing later passes.
 * An optional quiet period debounces both the initial and trailing pass.
 */
export class TrailingRefreshCoordinator<Key> {
  private readonly pendingByKey = new Map<Key, PendingRefresh>();

  constructor(private readonly debounceMs = 0) {
    if (!Number.isInteger(debounceMs) || debounceMs < 0) {
      throw new Error("debounceMs must be a non-negative integer");
    }
  }

  request(key: Key, refresh: () => Promise<void>): Promise<void> {
    const existing = this.pendingByKey.get(key);
    if (existing !== undefined) {
      existing.latestRefresh = refresh;
      if (existing.phase === "running") existing.trailing = true;
      else this.rescheduleDebounce(existing);
      return existing.promise;
    }

    const pending: PendingRefresh = {
      promise: Promise.resolve(),
      latestRefresh: refresh,
      phase: "debouncing",
      trailing: false,
      debounceTimer: undefined,
      finishDebounce: undefined,
    };
    pending.promise = Promise.resolve()
      .then(async () => {
        let latestError: unknown;
        let latestFailed: boolean;
        do {
          pending.trailing = false;
          pending.phase = "debouncing";
          if (this.debounceMs > 0) await this.waitForDebounce(pending);
          pending.phase = "running";
          const runRefresh = pending.latestRefresh;
          latestFailed = false;
          try {
            await runRefresh();
          } catch (error) {
            latestError = error;
            latestFailed = true;
          }
        } while (this.hasTrailingRequest(pending));
        if (latestFailed) throw latestError;
      })
      .finally(() => {
        this.cancelDebounce(pending);
        if (this.pendingByKey.get(key) === pending) this.pendingByKey.delete(key);
      });
    this.pendingByKey.set(key, pending);
    return pending.promise;
  }

  private hasTrailingRequest(pending: PendingRefresh): boolean {
    return pending.trailing;
  }

  private waitForDebounce(pending: PendingRefresh): Promise<void> {
    return new Promise((resolve) => {
      pending.finishDebounce = resolve;
      this.rescheduleDebounce(pending);
    });
  }

  private rescheduleDebounce(pending: PendingRefresh): void {
    if (pending.finishDebounce === undefined) return;
    if (pending.debounceTimer !== undefined) globalThis.clearTimeout(pending.debounceTimer);
    pending.debounceTimer = globalThis.setTimeout(() => {
      const finish = pending.finishDebounce;
      pending.debounceTimer = undefined;
      pending.finishDebounce = undefined;
      pending.phase = "running";
      finish?.();
    }, this.debounceMs);
  }

  private cancelDebounce(pending: PendingRefresh): void {
    if (pending.debounceTimer !== undefined) globalThis.clearTimeout(pending.debounceTimer);
    pending.debounceTimer = undefined;
    pending.finishDebounce = undefined;
  }
}
