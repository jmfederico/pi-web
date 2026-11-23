export const VIEWPORT_POSITION_REPAIR_DELAY_MS = 250;

export interface ViewportPositionRepairScheduler {
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(id: number): void;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
  scrollTo(x: number, y: number): void;
  readonly documentElement: { scrollTop: number } | undefined;
  readonly body: { scrollTop: number } | undefined;
  readonly viewportScale?: number | undefined;
}

export class ViewportPositionRepairer {
  private repairFrame: number | undefined;
  private repairTimer: number | undefined;

  constructor(private readonly scheduler: ViewportPositionRepairScheduler = createBrowserViewportPositionRepairScheduler()) {}

  repair(shouldRepair: boolean): void {
    if (!shouldRepair) {
      this.clear();
      return;
    }

    this.resetViewportScroll();
    if (this.repairFrame !== undefined) this.scheduler.cancelAnimationFrame(this.repairFrame);
    this.repairFrame = this.scheduler.requestAnimationFrame(() => {
      this.repairFrame = undefined;
      this.resetViewportScroll();
      this.repairFrame = this.scheduler.requestAnimationFrame(() => {
        this.repairFrame = undefined;
        this.resetViewportScroll();
      });
    });

    if (this.repairTimer !== undefined) this.scheduler.clearTimeout(this.repairTimer);
    this.repairTimer = this.scheduler.setTimeout(() => {
      this.repairTimer = undefined;
      this.resetViewportScroll();
    }, VIEWPORT_POSITION_REPAIR_DELAY_MS);
  }

  clear(): void {
    if (this.repairFrame !== undefined) {
      this.scheduler.cancelAnimationFrame(this.repairFrame);
      this.repairFrame = undefined;
    }
    if (this.repairTimer !== undefined) {
      this.scheduler.clearTimeout(this.repairTimer);
      this.repairTimer = undefined;
    }
  }

  repairNow(): void {
    this.resetViewportScroll();
  }

  private resetViewportScroll(): void {
    // Resume retries may still be pending when the user starts pinch zooming.
    if ((this.scheduler.viewportScale ?? 1) !== 1) return;
    this.scheduler.scrollTo(0, 0);
    const documentElement = this.scheduler.documentElement;
    if (documentElement !== undefined) documentElement.scrollTop = 0;
    const body = this.scheduler.body;
    if (body !== undefined) body.scrollTop = 0;
  }
}

export function createBrowserViewportPositionRepairScheduler(): ViewportPositionRepairScheduler {
  return {
    get viewportScale(): number | undefined {
      return window.visualViewport?.scale;
    },
    requestAnimationFrame(callback: () => void): number {
      return window.requestAnimationFrame(callback);
    },
    cancelAnimationFrame(id: number): void {
      window.cancelAnimationFrame(id);
    },
    setTimeout(callback: () => void, delayMs: number): number {
      return window.setTimeout(callback, delayMs);
    },
    clearTimeout(id: number): void {
      window.clearTimeout(id);
    },
    scrollTo(x: number, y: number): void {
      window.scrollTo(x, y);
    },
    get documentElement(): { scrollTop: number } | undefined {
      return typeof document === "undefined" ? undefined : document.documentElement;
    },
    get body(): { scrollTop: number } | undefined {
      return typeof document === "undefined" ? undefined : document.body;
    },
  };
}
