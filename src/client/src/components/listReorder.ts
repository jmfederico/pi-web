/** Geometry and target selection for pointer-driven list reordering. */

export interface RowRect {
  top: number;
  bottom: number;
}

export type DropPosition = "before" | "after";

export interface DropTarget {
  neighborId: string;
  position: DropPosition;
}

/** Insertion slot in `0…rows.length` whose boundary is nearest the pointer. */
export function insertionSlot(rects: readonly RowRect[], y: number): number {
  let slot = 0;
  for (const rect of rects) if (y > (rect.top + rect.bottom) / 2) slot += 1;
  return slot;
}

/** Neighbor a row dragged from `from` lands against, or undefined when nothing moves.
 * `slot` is an insertion slot in the undragged list, as returned by insertionSlot.
 */
export function dropTarget(items: readonly { id: string }[], from: number, slot: number): DropTarget | undefined {
  if (from < 0 || from >= items.length) return undefined;
  if (slot === from || slot === from + 1) return undefined;
  const remaining = items.filter((_, index) => index !== from);
  const to = slot > from ? slot - 1 : slot;
  const last = remaining[remaining.length - 1];
  if (to >= remaining.length) return last === undefined ? undefined : { neighborId: last.id, position: "after" };
  const first = remaining[0];
  if (first === undefined) return undefined;
  if (to === 0) return { neighborId: first.id, position: "before" };
  const previous = remaining[to - 1];
  return previous === undefined ? undefined : { neighborId: previous.id, position: "after" };
}

/** Pixels to scroll per frame for a pointer near a scrolling list's edges.
 * Negative scrolls up, positive down, 0 means the pointer is inside the dead zone.
 */
export function autoscrollStep(pointerY: number, bounds: RowRect, edgePx: number, maxPx: number): number {
  const topEdge = bounds.top + edgePx;
  if (pointerY < topEdge) return -Math.ceil(Math.min(1, (topEdge - pointerY) / edgePx) * maxPx);
  const bottomEdge = bounds.bottom - edgePx;
  if (pointerY > bottomEdge) return Math.ceil(Math.min(1, (pointerY - bottomEdge) / edgePx) * maxPx);
  return 0;
}
