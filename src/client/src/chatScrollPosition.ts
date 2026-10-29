export type ChatScrollPosition = ChatBottomScrollPosition | ChatAnchorScrollPosition;

export interface ChatBottomScrollPosition {
  mode: "bottom";
}

export interface ChatAnchorScrollPosition {
  mode: "anchor";
  anchorId: string;
  offset: number;
}

export interface ChatScrollViewport {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  getBoundingClientRect(): Pick<DOMRectReadOnly, "top" | "bottom">;
}

export interface ChatScrollElement {
  readonly dataset: { readonly scrollAnchorId?: string | undefined };
  getBoundingClientRect(): Pick<DOMRectReadOnly, "top" | "bottom">;
}

export interface ChatScrollStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ChatScrollScheduler {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

export type ChatScrollSaveResult = "saved" | "skipped";
export type ChatScrollRestoreResult =
  | { status: "bottom" | "restored" | "skipped" }
  | { status: "missing"; position: ChatAnchorScrollPosition };

const SCROLL_STORAGE_PREFIX = "pi-web:chat-scroll:";
const DEFAULT_SAVE_DELAY_MS = 180;
const DEFAULT_NEAR_BOTTOM_THRESHOLD = 48;
const DEFAULT_BOTTOM_SAVE_THRESHOLD = 2;

const browserScrollStorage: ChatScrollStorage = {
  getItem(key: string): string | null {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  },
  setItem(key: string, value: string): void {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, value);
  },
  removeItem(key: string): void {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(key);
  },
};

const browserScrollScheduler: ChatScrollScheduler = {
  setTimeout(callback: () => void, delayMs: number): number {
    return window.setTimeout(callback, delayMs);
  },
  clearTimeout(id: number): void {
    window.clearTimeout(id);
  },
};

export class ChatScrollController {
  private saveTimer: number | undefined;

  constructor(
    private readonly storage: ChatScrollStorage = browserScrollStorage,
    private readonly scheduler: ChatScrollScheduler = browserScrollScheduler,
  ) {}

  dispose(): void {
    this.clearScheduledSave();
  }

  clearScheduledSave(): void {
    if (this.saveTimer === undefined) return;
    this.scheduler.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
  }

  scheduleSave(sessionId: string, save: (sessionId: string) => void, delayMs = DEFAULT_SAVE_DELAY_MS): void {
    this.clearScheduledSave();
    this.saveTimer = this.scheduler.setTimeout(() => {
      this.saveTimer = undefined;
      save(sessionId);
    }, delayMs);
  }

  savePosition(sessionId: string, scroller: ChatScrollViewport | undefined, anchors: ChatScrollElement[], bottomThreshold = DEFAULT_BOTTOM_SAVE_THRESHOLD): ChatScrollSaveResult {
    if (sessionId === "" || scroller === undefined || !hasUsableScrollViewport(scroller)) return "skipped";
    try {
      if (isNearScrollBottom(scroller, bottomThreshold)) {
        const position: ChatBottomScrollPosition = { mode: "bottom" };
        this.storage.setItem(chatScrollStorageKey(sessionId), JSON.stringify(position));
        return "saved";
      }

      const anchor = findScrollAnchor(scroller, anchors);
      if (anchor === undefined) return "skipped";

      const position = captureScrollPosition(scroller, anchor);
      this.storage.setItem(chatScrollStorageKey(sessionId), JSON.stringify(position));
      return "saved";
    } catch {
      return "skipped";
    }
  }

  restorePosition(sessionId: string, scroller: ChatScrollViewport | undefined, anchors: ChatScrollElement[]): ChatScrollRestoreResult {
    const stored = this.readPosition(sessionId);
    if (stored === undefined) return { status: "skipped" };
    return this.restoreExplicitPosition(stored, scroller, anchors);
  }

  restoreExplicitPosition(position: ChatScrollPosition, scroller: ChatScrollViewport | undefined, anchors: ChatScrollElement[]): ChatScrollRestoreResult {
    if (position.mode === "bottom") return this.scrollToBottom(scroller);
    if (scroller === undefined || !hasUsableScrollViewport(scroller)) return { status: "skipped" };
    const anchor = findAnchorById(anchors, position.anchorId);
    if (anchor === undefined) return { status: "missing", position };
    const scrollerTop = scroller.getBoundingClientRect().top;
    const currentOffset = anchor.getBoundingClientRect().top - scrollerTop;
    const adjustment = currentOffset - position.offset;
    // Even assigning the same scrollTop can interrupt native touch/wheel inertia.
    if (adjustment !== 0) scroller.scrollTop += adjustment;
    return { status: "restored" };
  }

  readPosition(sessionId: string): ChatScrollPosition | undefined {
    if (sessionId === "") return undefined;
    try {
      const raw = this.storage.getItem(chatScrollStorageKey(sessionId));
      if (raw === null || raw === "") return undefined;
      const value: unknown = JSON.parse(raw);
      return isScrollPosition(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  scrollToBottom(scroller: ChatScrollViewport | undefined): ChatScrollRestoreResult {
    if (scroller === undefined || !hasUsableScrollViewport(scroller)) return { status: "skipped" };
    scroller.scrollTop = scroller.scrollHeight;
    return { status: "bottom" };
  }
}

/** Preserve local bookmarks; ambiguous legacy remote bookmarks are not migrated. */
export function chatScrollScopeKey(machineId: string, sessionId: string): string {
  if (sessionId === "" || machineId === "local") return sessionId;
  return JSON.stringify(["machine", machineId, sessionId]);
}

export function chatScrollStorageKey(sessionId: string): string {
  return `${SCROLL_STORAGE_PREFIX}${sessionId}`;
}

export function isScrollPosition(value: unknown): value is ChatScrollPosition {
  if (typeof value !== "object" || value === null || !("mode" in value)) return false;
  if (value.mode === "bottom") return true;
  return value.mode === "anchor"
    && "anchorId" in value
    && typeof value.anchorId === "string"
    && value.anchorId !== ""
    && "offset" in value
    && typeof value.offset === "number";
}

export function hasUsableScrollViewport(scroller: Pick<ChatScrollViewport, "clientHeight" | "scrollHeight">): boolean {
  return scroller.clientHeight > 0 && scroller.scrollHeight > 0;
}

export function distanceFromScrollBottom(scroller: Pick<ChatScrollViewport, "scrollHeight" | "scrollTop" | "clientHeight">): number {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
}

export function isNearScrollBottom(scroller: Pick<ChatScrollViewport, "scrollHeight" | "scrollTop" | "clientHeight">, threshold = DEFAULT_NEAR_BOTTOM_THRESHOLD): boolean {
  return distanceFromScrollBottom(scroller) < threshold;
}

export function captureScrollPosition(scroller: ChatScrollViewport, anchor: ChatScrollElement): ChatAnchorScrollPosition {
  const chatTop = scroller.getBoundingClientRect().top;
  return {
    mode: "anchor",
    anchorId: anchorIdForElement(anchor) ?? "",
    offset: anchor.getBoundingClientRect().top - chatTop,
  };
}

/** Prefer a visible anchor; otherwise use the nearest usable anchor to the viewport top.
 * Equal distances prefer the earlier element in DOM order.
 */
export function findScrollAnchor<T extends ChatScrollElement>(scroller: ChatScrollViewport, anchors: T[]): T | undefined {
  const scrollerRect = scroller.getBoundingClientRect();
  let nearestAbove: T | undefined;
  let nearestAboveOffset = Number.NEGATIVE_INFINITY;
  let nearestBelow: T | undefined;
  let nearestBelowOffset = Number.POSITIVE_INFINITY;
  let nearestOutside: T | undefined;
  let nearestOutsideDistance = Number.POSITIVE_INFINITY;

  for (const anchor of anchors) {
    if (anchorIdForElement(anchor) === undefined) continue;
    const rect = anchor.getBoundingClientRect();
    if (rect.bottom <= rect.top) continue;
    const offset = rect.top - scrollerRect.top;
    if (rect.bottom < scrollerRect.top || rect.top > scrollerRect.bottom) {
      if (Math.abs(offset) < nearestOutsideDistance) {
        nearestOutside = anchor;
        nearestOutsideDistance = Math.abs(offset);
      }
      continue;
    }
    if (offset <= 0 && offset > nearestAboveOffset) {
      nearestAbove = anchor;
      nearestAboveOffset = offset;
    } else if (offset > 0 && offset < nearestBelowOffset) {
      nearestBelow = anchor;
      nearestBelowOffset = offset;
    }
  }

  return nearestAbove ?? nearestBelow ?? nearestOutside;
}

function findAnchorById<T extends ChatScrollElement>(anchors: T[], anchorId: string): T | undefined {
  return anchors.find((anchor) => {
    if (anchorIdForElement(anchor) !== anchorId) return false;
    // Closed native disclosures retain their body DOM, but not its geometry.
    const rect = anchor.getBoundingClientRect();
    return rect.bottom > rect.top;
  });
}

function anchorIdForElement(element: ChatScrollElement): string | undefined {
  return element.dataset.scrollAnchorId !== undefined && element.dataset.scrollAnchorId !== "" ? element.dataset.scrollAnchorId : undefined;
}
