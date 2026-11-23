// While the iPad Shortcuts bar is up, the visual viewport is shorter than the
// layout viewport and Safari lets any unconsumed drag pan the whole page. CSS
// cannot prevent that pan, so this guard cancels only drags that no panel would
// scroll. It prevents the movement rather than repairing it afterwards.
//
// Hardware keyboards (which bring up the Shortcuts bar) often include a
// trackpad, whose scrolling arrives as wheel events rather than touches.
//
// Safari commits a gesture to scrolling on its first touchmove; later moves are
// no longer cancelable. Ambiguous first moves must therefore be decided by what
// could scroll under the finger, not by waiting for a clear direction.

/** Leave system edge swipes (Safari back/forward) alone. */
const EDGE_SWIPE_WIDTH = 24;

export interface PanScroller {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export interface DragScrollers {
  readonly vertical: readonly PanScroller[];
  readonly horizontal: boolean;
}

/**
 * Decide whether a drag would reach the page. `deltaY` is the finger movement:
 * positive drags down (scrolls content toward its top).
 */
export function dragWouldPanPage(scrollers: DragScrollers, deltaX: number, deltaY: number): boolean {
  const mostlyHorizontal = Math.abs(deltaX) > Math.abs(deltaY);
  if (scrollers.vertical.length === 0) return !(scrollers.horizontal && mostlyHorizontal);
  if (deltaY === 0 || mostlyHorizontal) return false;
  return scrollers.vertical.every((scroller) => deltaY > 0
    ? scroller.scrollTop <= 0
    : scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1);
}

export class ViewportPanGuard {
  private active = false;
  private scrollers: DragScrollers = { vertical: [], horizontal: false };
  private exempt = false;
  private lastX = 0;
  private lastY = 0;
  constructor(private readonly target: Pick<Document, "addEventListener" | "removeEventListener"> = document) {}

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active) {
      this.target.addEventListener("touchstart", this.onTouchStart, { passive: true });
      this.target.addEventListener("touchmove", this.onTouchMove, { passive: false });
      this.target.addEventListener("wheel", this.onWheel, { passive: false });
    } else {
      this.target.removeEventListener("touchstart", this.onTouchStart);
      this.target.removeEventListener("touchmove", this.onTouchMove);
      this.target.removeEventListener("wheel", this.onWheel);
      this.scrollers = { vertical: [], horizontal: false };
    }
  }

  private readonly onTouchStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (touch === undefined) return;
    this.lastX = touch.clientX;
    this.lastY = touch.clientY;
    const path = event.composedPath().filter((node): node is HTMLElement => node instanceof HTMLElement);
    // Editing gestures (caret and selection drags) stay native.
    this.exempt = event.touches.length > 1
      || touch.clientX < EDGE_SWIPE_WIDTH || touch.clientX > window.innerWidth - EDGE_SWIPE_WIDTH
      || path.some((element) => element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement || element.isContentEditable);
    this.scrollers = this.exempt
      ? { vertical: [], horizontal: false }
      : { vertical: path.filter(isVerticalScroller), horizontal: path.some(isHorizontalScroller) };
  };

  private readonly onTouchMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (touch === undefined || event.touches.length > 1) return;
    const deltaX = touch.clientX - this.lastX;
    const deltaY = touch.clientY - this.lastY;
    this.lastX = touch.clientX;
    this.lastY = touch.clientY;
    if (!this.exempt && event.cancelable && dragWouldPanPage(this.scrollers, deltaX, deltaY)) event.preventDefault();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    // Trackpad pinch zoom arrives as ctrl+wheel and must stay native.
    if (event.ctrlKey) return;
    const path = event.composedPath().filter((node): node is HTMLElement => node instanceof HTMLElement);
    const scrollers = { vertical: path.filter(isVerticalScroller), horizontal: path.some(isHorizontalScroller) };
    // Wheel deltas move content; finger deltas move the opposite way.
    if (event.cancelable && dragWouldPanPage(scrollers, -event.deltaX, -event.deltaY)) event.preventDefault();
  };
}

// The root and body are the page this guard protects, never an absorbing panel.
function isPageElement(element: HTMLElement): boolean {
  return element === document.documentElement || element === document.body;
}

function isVerticalScroller(element: HTMLElement): boolean {
  if (isPageElement(element) || element.scrollHeight <= element.clientHeight + 1) return false;
  const overflowY = getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll";
}

function isHorizontalScroller(element: HTMLElement): boolean {
  if (isPageElement(element) || element.scrollWidth <= element.clientWidth + 1) return false;
  const overflowX = getComputedStyle(element).overflowX;
  return overflowX === "auto" || overflowX === "scroll";
}
