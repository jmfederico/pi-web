export interface ScrollIdleScheduler {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
  now(): number;
}

// Bare setTimeout/clearTimeout work in both browser and Node test runtimes,
// but their handle types differ; map to plain numeric ids to keep the
// scheduler contract platform-neutral.
function createBrowserScrollIdleScheduler(): ScrollIdleScheduler {
  let nextId = 1;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  return {
    setTimeout(callback: () => void, delayMs: number): number {
      const id = nextId;
      nextId += 1;
      timers.set(id, setTimeout(callback, delayMs));
      return id;
    },
    clearTimeout(id: number): void {
      const handle = timers.get(id);
      if (handle === undefined) return;
      timers.delete(id);
      clearTimeout(handle);
    },
    now(): number {
      return Date.now();
    },
  };
}

export const DEFAULT_SCROLL_IDLE_SETTLE_MS = 160;
export const DEFAULT_SCROLL_IDLE_MAX_WAIT_MS = 2500;

interface ScrollIdleWaiter {
  resolve: () => void;
  maxWaitTimer: number;
}

/**
 * Tracks touch/scroll activity on a scroll container and resolves waiters once
 * scrolling is idle. Chat history prepends use this to apply DOM changes (and
 * their scrollTop corrections) only when there is no in-flight touch or
 * momentum scroll for those writes to cancel.
 */
export class ScrollIdleTracker {
  private touchActive = false;
  private lastActivity = Number.NEGATIVE_INFINITY;
  private readonly waiters = new Set<ScrollIdleWaiter>();
  private checkTimer: number | undefined;

  constructor(
    private readonly scheduler: ScrollIdleScheduler = createBrowserScrollIdleScheduler(),
    private readonly settleMs: number = DEFAULT_SCROLL_IDLE_SETTLE_MS,
  ) {}

  noteTouchStart(): void {
    this.touchActive = true;
  }

  noteTouchEnd(): void {
    this.touchActive = false;
    this.scheduleIdleCheck();
  }

  noteScrollActivity(): void {
    this.lastActivity = this.scheduler.now();
    this.scheduleIdleCheck();
  }

  /** True when no touch is active and scroll events have settled. */
  get isIdle(): boolean {
    return this.isIdleNow();
  }

  /**
   * Resolves once no touch is active and scroll events have settled for the
   * settle window. Resolves anyway after `maxWaitMs` so a continuously
   * scrolling user cannot starve the pending work indefinitely.
   */
  whenIdle(maxWaitMs = DEFAULT_SCROLL_IDLE_MAX_WAIT_MS): Promise<void> {
    return new Promise((resolve) => {
      const waiter: ScrollIdleWaiter = {
        resolve: () => {
          this.waiters.delete(waiter);
          this.scheduler.clearTimeout(waiter.maxWaitTimer);
          resolve();
        },
        maxWaitTimer: 0,
      };
      waiter.maxWaitTimer = this.scheduler.setTimeout(() => {
        waiter.resolve();
      }, maxWaitMs);
      this.waiters.add(waiter);
      if (this.isIdleNow()) waiter.resolve();
      else this.scheduleIdleCheck();
    });
  }

  /** Resolves every pending waiter without resetting activity tracking. */
  flushWaiters(): void {
    for (const waiter of Array.from(this.waiters)) waiter.resolve();
    this.clearIdleCheck();
  }

  dispose(): void {
    this.flushWaiters();
  }

  private isIdleNow(): boolean {
    return !this.touchActive && this.scheduler.now() - this.lastActivity >= this.settleMs;
  }

  private scheduleIdleCheck(): void {
    if (this.waiters.size === 0 || this.touchActive || this.checkTimer !== undefined) return;
    const remaining = Math.max(0, this.settleMs - (this.scheduler.now() - this.lastActivity));
    this.checkTimer = this.scheduler.setTimeout(() => {
      this.checkTimer = undefined;
      if (this.isIdleNow()) this.flushWaiters();
      else this.scheduleIdleCheck();
    }, remaining);
  }

  private clearIdleCheck(): void {
    if (this.checkTimer === undefined) return;
    this.scheduler.clearTimeout(this.checkTimer);
    this.checkTimer = undefined;
  }
}
