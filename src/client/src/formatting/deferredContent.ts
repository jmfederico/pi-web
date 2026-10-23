import type { ReactiveController, ReactiveControllerHost } from "lit";

type Cancel = () => void;
type ContentHost = ReactiveControllerHost & HTMLElement;

/** One enhancement per paint opportunity. Promise/microtask queues do not yield to paint. */
function scheduleContentEnhancement(work: () => void): Cancel {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(work, 0);
  });
  return () => {
    cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
  };
}

const pendingEnhancements = new Set<() => void>();
let cancelScheduledEnhancement: Cancel | undefined;

function scheduleNextEnhancement(): void {
  if (cancelScheduledEnhancement !== undefined || pendingEnhancements.size === 0) return;
  cancelScheduledEnhancement = scheduleContentEnhancement(() => {
    cancelScheduledEnhancement = undefined;
    const next = pendingEnhancements.values().next().value;
    if (next !== undefined) {
      pendingEnhancements.delete(next);
      try { next(); } finally { scheduleNextEnhancement(); }
    }
  });
}

function enqueueEnhancement(work: () => void): Cancel {
  pendingEnhancements.add(work);
  scheduleNextEnhancement();
  return () => {
    pendingEnhancements.delete(work);
    if (pendingEnhancements.size === 0) {
      cancelScheduledEnhancement?.();
      cancelScheduledEnhancement = undefined;
    }
  };
}

/** Visibility owns optional work, never session loading or the readable source. */
export class VisibleContentController implements ReactiveController {
  private observer: IntersectionObserver | undefined;
  private target: Element | undefined;
  private intersecting = false;
  private details: HTMLDetailsElement[] = [];
  private work: (() => void) | undefined;
  private cancelQueued: Cancel | undefined;
  private wasVisible = false;

  constructor(
    private readonly host: ContentHost,
    private readonly visibilityChanged: (visible: boolean) => void = () => { host.requestUpdate(); },
    private readonly getTarget: () => Element | undefined = () => host,
  ) {
    host.addController(this);
  }

  get visible(): boolean {
    return this.host.isConnected && this.intersecting
      && this.host.ownerDocument.visibilityState !== "hidden"
      && this.details.every((details) => details.open);
  }

  hostConnected(): void {
    for (let node: Node | null = this.host.parentNode; node !== null; node = node instanceof ShadowRoot ? node.host : node.parentNode) {
      if (node instanceof HTMLDetailsElement) {
        this.details.push(node);
        node.addEventListener("toggle", this.refresh);
      }
    }
    this.host.ownerDocument.addEventListener("visibilitychange", this.refresh);
    if (typeof IntersectionObserver !== "undefined") {
      this.observer = new IntersectionObserver((entries) => {
        // A batch can contain several transitions for one target. The oldest
        // entry can leave visible content waiting forever for another change.
        for (const entry of entries) {
          if (entry.target === this.target) this.intersecting = entry.isIntersecting;
        }
        this.refresh();
      });
    } else {
      // Older browser engines still yield; disclosure/document gating remains active.
      this.intersecting = true;
    }
    this.hostUpdated();
    this.refresh();
  }

  hostUpdated(): void {
    // Lit may finish a pending update after detach. Do not cache an unobserved
    // target that would prevent the new observer from observing it on reconnect.
    if (!this.host.isConnected) return;
    const target = this.getTarget();
    if (target === this.target) return;
    if (this.target !== undefined) this.observer?.unobserve(this.target);
    this.target = target;
    if (target !== undefined) this.observer?.observe(target);
  }

  hostDisconnected(): void {
    this.cancel();
    this.observer?.disconnect();
    this.observer = undefined;
    this.target = undefined;
    this.intersecting = false;
    this.wasVisible = false;
    for (const details of this.details) details.removeEventListener("toggle", this.refresh);
    this.details = [];
    this.host.ownerDocument.removeEventListener("visibilitychange", this.refresh);
  }

  request(work: () => void): void {
    this.cancel();
    this.work = work;
    this.enqueue();
  }

  cancel(): void {
    this.cancelQueued?.();
    this.cancelQueued = undefined;
    this.work = undefined;
  }

  private readonly refresh = (): void => {
    const visible = this.visible;
    if (!visible) {
      this.cancelQueued?.();
      this.cancelQueued = undefined;
    }
    if (visible !== this.wasVisible) {
      this.wasVisible = visible;
      this.visibilityChanged(visible);
    }
    this.enqueue();
  };

  private enqueue(): void {
    if (!this.visible || this.work === undefined || this.cancelQueued !== undefined) return;
    this.cancelQueued = enqueueEnhancement(() => {
      this.cancelQueued = undefined;
      if (!this.visible) return;
      const work = this.work;
      this.work = undefined;
      work?.();
    });
  }
}
