import type { ChatBehaviors } from "./chatBehaviors";
import { captureScrollPosition, findScrollAnchor, ChatScrollController, type ChatAnchorScrollPosition, type ChatScrollPosition, type ChatScrollScheduler, type ChatScrollStorage } from "./chatScrollPosition";

export interface ChatScrollFlowsHost {
  getScroller(): HTMLDivElement | undefined;
  getAnchors(): HTMLElement[];
  getScopeKey(): string;
  getBehaviors(): ChatBehaviors;
  hasMore(): boolean;
  isHistoryReady(): boolean;
  isLoadingMore(): boolean;
  requestEarlier(): void;
  canRequestEarlier(): boolean;
  getOpenForm(kind?: "ask" | "dialog"): HTMLElement | undefined;
  onFollowingChange?(following: boolean): void;
  requestAnchorMount?(anchorId: string): boolean;
}

export interface ChatScrollFrameScheduler {
  request(callback: () => void): number;
  cancel(id: number): void;
}

export interface ChatScrollPositionOptions {
  storage?: ChatScrollStorage;
  saveScheduler?: ChatScrollScheduler;
}

export interface ChatScrollBeforeRender {
  sessionChanged: boolean;
  previousScopeKey?: unknown;
  prepend: boolean;
}

export interface ChatScrollAfterRender {
  sessionChanged: boolean;
  contentChanged: boolean;
  historyChanged: boolean;
  openedForm: boolean | "ask" | "dialog";
}

type FormAlignment = ChatScrollAfterRender["openedForm"];
type ViewportTarget =
  | { kind: "position"; position: ChatScrollPosition }
  | { kind: "tail"; form: FormAlignment }
  | { kind: "edge"; end: boolean };

const browserFrames: ChatScrollFrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => { cancelAnimationFrame(id); },
};

function canLoadEarlier(host: ChatScrollFlowsHost): boolean {
  return host.hasMore() && !host.isLoadingMore() && host.canRequestEarlier();
}

const BOTTOM_TOLERANCE_PX = 2;

interface TailScrollPosition {
  top: number;
  maxTop: number;
  overscrollBottom: number | undefined;
}

/** Tracks navigation intent and browser rebound; never schedules or writes scroll position. */
class TailFollowState {
  private following = false;
  private lastPosition: TailScrollPosition | undefined;
  private enabled: boolean;

  constructor(private readonly host: ChatScrollFlowsHost) {
    this.enabled = host.getBehaviors().followTail;
  }

  get followingLive(): boolean { return this.following; }

  configure(): void {
    const enabled = this.host.getBehaviors().followTail;
    if (!enabled) this.pause();
    else if (!this.enabled) this.syncFollowingAfterNavigation();
    this.enabled = enabled;
  }

  /** Navigation may choose a mode; ordinary layout changes may not. */
  syncFollowingAfterNavigation(): void {
    if (!this.host.getBehaviors().followTail) return;
    const position = this.readPosition();
    if (position === undefined) return;
    this.lastPosition = position;
    this.setFollowing(position.maxTop - position.top < BOTTOM_TOLERANCE_PX);
  }

  recordScrollBaseline(preserveOverscroll = false): void {
    if (this.host.getBehaviors().followTail) this.lastPosition = this.readPosition(preserveOverscroll);
  }

  onScroll(): void {
    if (!this.host.getBehaviors().followTail) return;
    const position = this.readPosition(true);
    if (position === undefined) return;
    const previous = this.lastPosition;
    this.lastPosition = position;
    if (previous?.maxTop !== position.maxTop) return;
    const atBottom = position.maxTop - position.top < BOTTOM_TOLERANCE_PX;
    const returnedToBottom = position.top > previous.top && atBottom;
    const isBottomRebound = position.overscrollBottom !== undefined || previous.overscrollBottom !== undefined;
    const readingUpward = position.top < previous.top && !atBottom && !isBottomRebound;
    // A stationary event after growth is not navigation. Rebound stays browser-owned.
    if (returnedToBottom) this.setFollowing(true);
    else if (readingUpward) this.pause();
  }

  pause(): void { this.setFollowing(false); }

  startFollowing(): void {
    this.setFollowing(true);
    this.recordScrollBaseline();
  }

  private readPosition(preserveOverscroll = false): TailScrollPosition | undefined {
    const scroller = this.host.getScroller();
    if (scroller === undefined) return undefined;
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const rawTop = scroller.scrollTop;
    // Safari rubber-banding can outlive the bottom it started at during streaming.
    const overscrollBottom = (preserveOverscroll ? this.lastPosition?.overscrollBottom : undefined)
      ?? (rawTop > maxTop ? maxTop : undefined);
    return {
      top: Math.max(0, Math.min(rawTop, maxTop)),
      maxTop,
      overscrollBottom: overscrollBottom !== undefined && rawTop >= overscrollBottom ? overscrollBottom : undefined,
    };
  }

  private setFollowing(following: boolean): void {
    following = following && this.host.getBehaviors().followTail;
    if (this.following === following) return;
    this.following = following;
    this.host.onFollowingChange?.(following);
  }

  reset(): void {
    this.lastPosition = undefined;
    this.setFollowing(false);
  }
}

/** Paging has its own in-flight owner in the host. This flow never moves the viewport. */
class HistoryFlow {
  private frame: number | undefined;
  private requestedAtTop = false;

  constructor(private readonly host: ChatScrollFlowsHost, private readonly frames: ChatScrollFrameScheduler) {}

  schedule(): void {
    if (!this.host.getBehaviors().automaticHistory) return;
    const scroller = this.host.getScroller();
    if (scroller === undefined) return;
    if (scroller.scrollTop > 64) {
      this.requestedAtTop = false;
      this.cancel();
      return;
    }
    // Collapsed pages need not add height. Require leaving/re-entering the top.
    if (this.requestedAtTop || this.frame !== undefined || !canLoadEarlier(this.host)) return;
    this.frame = this.frames.request(() => {
      this.frame = undefined;
      if (!this.host.getBehaviors().automaticHistory || !canLoadEarlier(this.host)) return;
      const scroller = this.host.getScroller();
      if (scroller !== undefined && scroller.scrollTop <= 64) {
        this.requestedAtTop = true;
        this.host.requestEarlier();
      }
    });
  }

  reset(): void {
    this.cancel();
    this.requestedAtTop = false;
  }

  cancel(): void {
    if (this.frame !== undefined) this.frames.cancel(this.frame);
    this.frame = undefined;
  }
}

/** One viewport transaction owns restoration, prepend compensation, tail and form alignment.
 * Rendering/geometry notifications submit intent; only commitViewport may write scroll position.
 */
export class ChatScrollFlows {
  private readonly controller: ChatScrollController;
  private readonly tail: TailFollowState;
  private readonly history: HistoryFlow;
  private frame: number | undefined;
  private restoration: { scopeKey: string; position: ChatScrollPosition } | undefined;
  private requestedHistory = false;
  private correction: { position: ChatAnchorScrollPosition; source: "history" | "mount"; scrollTop: number } | undefined;
  private follow: { form: FormAlignment } | undefined;
  private anchorRounding: { anchorId: string; error: number; scrollTop: number } | undefined;
  private started = false;
  private disposed = false;

  constructor(
    private readonly host: ChatScrollFlowsHost,
    private readonly frames: ChatScrollFrameScheduler = browserFrames,
    positionOptions: ChatScrollPositionOptions = {},
  ) {
    this.controller = new ChatScrollController(positionOptions.storage, positionOptions.saveScheduler);
    this.tail = new TailFollowState(host);
    this.history = new HistoryFlow(host, frames);
  }

  get followingLive(): boolean { return this.tail.followingLive; }

  get restorationAnchor(): string | undefined {
    const position = this.restoration?.position;
    return position?.mode === "anchor" ? position.anchorId : undefined;
  }

  /** A pending measured correction protects its anchor even if estimates move it offscreen. */
  get requiredAnchor(): string | undefined {
    return this.restorationAnchor ?? this.correction?.position.anchorId;
  }

  /** Mounting changes layout, not navigation; preserve the reader through this owner. */
  beforeMountChange(): void {
    if (this.disposed || this.restoration !== undefined || this.tail.followingLive) return;
    this.captureAnchor("mount");
    this.history.cancel();
  }

  private captureAnchor(source: "history" | "mount"): void {
    if (this.correction !== undefined) return;
    const scroller = this.host.getScroller();
    if (scroller === undefined) return;
    const anchor = findScrollAnchor(scroller, this.host.getAnchors());
    if (anchor === undefined) return;
    const position = captureScrollPosition(scroller, anchor);
    if (this.anchorRounding?.anchorId === position.anchorId && this.anchorRounding.scrollTop === scroller.scrollTop) {
      position.offset -= this.anchorRounding.error;
    }
    this.correction = { position, source, scrollTop: scroller.scrollTop };
  }

  beforeRender(change: ChatScrollBeforeRender): void {
    if (this.disposed) return;
    if (change.sessionChanged) {
      if (typeof change.previousScopeKey === "string") this.savePosition(change.previousScopeKey);
      this.resetViewport();
      this.tail.reset();
      this.history.reset();
    } else if (change.prepend && this.restoration === undefined) {
      this.history.cancel();
      this.follow = undefined;
      // Keep the first pre-render anchor until commit, even across several renders.
      if (this.host.getBehaviors().anchorPrepends) this.captureAnchor("history");
      this.cancelFrame();
    }
  }

  afterRender(change: ChatScrollAfterRender): void {
    if (this.disposed) return;
    if (!this.started || change.sessionChanged) {
      this.started = true;
      this.restorePosition();
    } else if (this.restoration !== undefined) {
      if (change.historyChanged) this.requestedHistory = false;
      if (change.contentChanged || change.historyChanged) this.scheduleViewport();
    } else if (this.correction !== undefined) {
      this.scheduleViewport();
    } else if (change.contentChanged || change.openedForm !== false) {
      this.scheduleFollow(change.openedForm);
    }
    this.scheduleHistory();
  }

  onScroll(): void {
    if (this.disposed) return;
    if (this.anchorRounding !== undefined && this.host.getScroller()?.scrollTop !== this.anchorRounding.scrollTop) this.anchorRounding = undefined;
    if (this.restoration === undefined) this.tail.onScroll();
    if (!this.tail.followingLive) this.cancelFollow();
    this.scheduleSave();
    this.scheduleHistory();
  }

  onInteraction(): void {
    if (this.disposed) return;
    this.anchorRounding = undefined;
    if (this.restoration !== undefined) {
      this.resetRestoration();
      this.tail.recordScrollBaseline();
    }
    this.correction = undefined;
    if (this.follow === undefined) this.cancelFrame();
  }

  onUpIntent(): void {
    this.onInteraction();
    if (this.disposed) return;
    this.tail.pause();
    this.cancelFollow();
  }

  onContentLayoutChanged(): void {
    if (this.disposed || this.restoration !== undefined || this.correction !== undefined) return;
    this.scheduleFollow();
  }

  onViewportResize(): void {
    if (this.disposed) return;
    if (this.restoration !== undefined) this.scheduleViewport();
    else if (this.correction === undefined) {
      this.scheduleFollow();
      this.scheduleHistory();
    }
  }

  configure(): void {
    if (this.disposed) return;
    const behaviors = this.host.getBehaviors();
    this.tail.configure();
    if (!behaviors.followTail) this.cancelFollow();
    if (!behaviors.rememberPosition) this.resetRestoration();
    if (!behaviors.automaticHistory) this.history.reset();
    if (!behaviors.anchorPrepends && this.correction?.source === "history") this.correction = undefined;
    if (this.restoration === undefined && this.correction === undefined && this.follow === undefined) this.cancelFrame();
  }

  savePosition(scopeKey = this.host.getScopeKey()): void {
    // Do not overwrite an unresolved saved anchor with incidental geometry.
    if (this.disposed || !this.host.getBehaviors().rememberPosition || scopeKey === "" || this.restoration?.scopeKey === scopeKey) return;
    this.controller.savePosition(scopeKey, this.host.getScroller(), this.host.getAnchors());
  }

  restorePosition(): void {
    if (this.disposed) return;
    this.resetViewport();
    this.history.cancel();
    const scopeKey = this.host.getScopeKey();
    const position = this.host.getBehaviors().rememberPosition ? this.controller.readPosition(scopeKey) : undefined;
    if (position !== undefined) {
      this.restoration = { scopeKey, position };
      this.tail.pause();
      this.scheduleViewport();
    } else if (this.host.getBehaviors().followTail) {
      this.tail.startFollowing();
      this.scheduleFollow(true);
    }
  }

  jumpToEnd(): void { this.jump(true); }
  jumpToTop(): void { this.jump(false); }

  private jump(end: boolean): void {
    if (this.disposed) return;
    this.resetViewport();
    // Explicit navigation is synchronous; queued layout work cannot undo it.
    if (this.commitViewport({ kind: "edge", end }).status === "skipped") return;
    if (end) this.tail.startFollowing();
    else {
      this.tail.pause();
      this.tail.recordScrollBaseline();
    }
    this.scheduleSave();
  }

  private scheduleFollow(form: FormAlignment = false): void {
    if (!this.host.getBehaviors().followTail) return;
    // Establish the new range before native scroll events can precede the frame.
    this.tail.recordScrollBaseline(true);
    if (!this.tail.followingLive) return;
    this.follow = { form: form === false ? this.follow?.form ?? false : form };
    this.scheduleViewport();
  }

  private scheduleViewport(): void {
    if (this.frame !== undefined) return;
    this.frame = this.frames.request(() => {
      this.frame = undefined;
      this.flushViewport();
    });
  }

  private flushViewport(): void {
    if (this.disposed) return;
    // One winner per frame. A remembered position outranks prepend compensation;
    // both outrank tail/form alignment. Measurement happens after child renders.
    const restoration = this.restoration;
    const correction = this.correction;
    const follow = this.follow;
    this.follow = undefined;
    this.correction = undefined;
    if (restoration !== undefined) {
      if (restoration.scopeKey !== this.host.getScopeKey()) return;
      const result = this.commitViewport({ kind: "position", position: restoration.position });
      if (result.status === "restored" || result.status === "bottom") {
        this.restoration = undefined;
        if (restoration.position.mode === "anchor") this.recordAnchorRounding(restoration.position);
        this.tail.syncFollowingAfterNavigation();
      } else if (result.status === "missing") {
        this.tail.pause();
        this.tail.recordScrollBaseline();
        // A retained address outside the mounted window is not missing history.
        if (this.host.requestAnchorMount?.(result.position.anchorId) === true) return;
        if (this.host.isHistoryReady() && !this.host.hasMore()) this.restoration = undefined;
        else if (this.host.isHistoryReady() && !this.requestedHistory && canLoadEarlier(this.host)) {
          this.requestedHistory = true;
          this.host.requestEarlier();
        }
      }
    } else if (correction !== undefined) {
      // Native scrolling can continue after input dispatch. Retire snapshots
      // predating that movement, but not the browser's exact clamp to a shorter
      // range: that is layout, and preserving the reader is still our job.
      const scroller = this.host.getScroller();
      const clampedTop = scroller === undefined ? undefined : Math.min(correction.scrollTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
      if (correction.source !== "mount" || scroller?.scrollTop === correction.scrollTop || scroller?.scrollTop === clampedTop) {
        const result = this.commitViewport({ kind: "position", position: correction.position });
        if (result.status === "restored") {
          this.recordAnchorRounding(correction.position);
          this.tail.recordScrollBaseline();
        }
      }
    } else if (follow !== undefined && this.tail.followingLive) {
      const result = this.commitViewport({ kind: "tail", form: follow.form });
      if (result.status === "restored") this.tail.syncFollowingAfterNavigation();
      else if (result.status === "bottom") this.tail.recordScrollBaseline();
    }
    this.scheduleHistory();
  }

  private recordAnchorRounding(position: ChatAnchorScrollPosition): void {
    const scroller = this.host.getScroller();
    const anchor = this.host.getAnchors().find((element) => element.dataset["scrollAnchorId"] === position.anchorId && element.getBoundingClientRect().height > 0);
    if (scroller === undefined || anchor === undefined) return;
    // Keep the logical reading offset across repeated corrections, rather than
    // accumulating browser scrollTop rounding in each newly captured snapshot.
    this.anchorRounding = {
      anchorId: position.anchorId,
      error: captureScrollPosition(scroller, anchor).offset - position.offset,
      scrollTop: scroller.scrollTop,
    };
  }

  /** The only application-owned transcript scroll-write boundary. */
  private commitViewport(target: ViewportTarget) {
    const scroller = this.host.getScroller();
    if (target.kind === "position") return this.controller.restoreExplicitPosition(target.position, scroller, this.host.getAnchors());
    if (scroller === undefined) return { status: "skipped" } as const;
    if (target.kind === "edge") {
      scroller.scrollTop = target.end ? scroller.scrollHeight : 0;
      return { status: target.end ? "bottom" : "restored" } as const;
    }
    const form = target.form === false ? undefined : this.host.getOpenForm(typeof target.form === "string" ? target.form : undefined);
    if (form === undefined) {
      scroller.scrollTop = scroller.scrollHeight;
      return { status: "bottom" } as const;
    }
    scroller.scrollTop += form.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    return { status: "restored" } as const;
  }

  private scheduleHistory(): void {
    if (this.restoration === undefined && this.correction === undefined) this.history.schedule();
  }

  private scheduleSave(): void {
    if (!this.host.getBehaviors().rememberPosition || this.restoration !== undefined) return;
    this.controller.scheduleSave(this.host.getScopeKey(), (scopeKey) => {
      if (scopeKey === this.host.getScopeKey()) this.savePosition(scopeKey);
    });
  }

  private cancelFollow(): void {
    this.follow = undefined;
    if (this.restoration === undefined && this.correction === undefined) this.cancelFrame();
  }

  private resetRestoration(): void {
    this.controller.clearScheduledSave();
    this.restoration = undefined;
    this.requestedHistory = false;
  }

  private cancelFrame(): void {
    if (this.frame !== undefined) this.frames.cancel(this.frame);
    this.frame = undefined;
  }

  private resetViewport(): void {
    this.cancelFrame();
    this.resetRestoration();
    this.correction = undefined;
    this.follow = undefined;
    this.anchorRounding = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.savePosition();
    this.disposed = true;
    this.resetViewport();
    this.history.cancel();
  }
}
