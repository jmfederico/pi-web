import type { LitElement, ReactiveController } from "lit";
import { localization } from "../localization/browser";
import definitions from "./listReorder.messages";
import { autoscrollStep, dropTarget, insertionSlot, type DropPosition } from "./listReorder";

const messages = localization.registerMessages("core.listReorder", definitions);

interface ReorderOptions<T> {
  items: () => readonly T[];
  enabled: () => boolean;
  onDrop: (item: T, neighbor: T, position: DropPosition) => void;
  onStart: () => void;
  label: (item: T) => string;
}

/** Pointer gestures are ephemeral; each list's parent owns ordering and persistence. */
export class ListReorderController<T extends { id: string }> implements ReactiveController {
  constructor(private readonly host: LitElement, private readonly options: ReorderOptions<T>) {
    host.addController(this);
  }

  private dragged: string | undefined;
  get draggingId(): string | undefined { return this.dragged; }
  private set draggingId(value: string | undefined) { if (this.dragged !== value) { this.dragged = value; this.host.requestUpdate(); } }
  private slot: number | undefined;
  private get dropSlot(): number | undefined { return this.slot; }
  private set dropSlot(value: number | undefined) { if (this.slot !== value) { this.slot = value; this.host.requestUpdate(); } }
  private announcementText = "";
  get announcement(): string { return this.announcementText; }
  private set announcement(value: string) { if (this.announcementText !== value) { this.announcementText = value; this.host.requestUpdate(); } }
  private pointerCandidate: PointerReorderCandidate | undefined;
  private suppressClick = false;
  private autoScrollFrame: number | undefined;
  private lastPointerX: number | undefined;
  private lastPointerY: number | undefined;
  private scrollElement: HTMLElement | null = null;
  private ghost: HTMLElement | undefined;

  hostDisconnected(): void { this.cancel(); }

  begin(event: PointerEvent, item: T): void {
    if (this.pointerCandidate !== undefined) return;
    this.suppressClick = false;
    const items = this.options.items();
    if (!this.options.enabled() || !items.some((candidate) => candidate.id === item.id) || items.length < 2 || event.button !== 0 || !event.isPrimary) return;
    const element = event.currentTarget;
    if (!(element instanceof HTMLElement) || (event.target instanceof Element && event.target.closest(".action-menu, button, a, input, select, textarea") !== null)) return;
    this.announcement = "";
    this.options.onStart();
    const rect = element.getBoundingClientRect();
    const candidate: PointerReorderCandidate = {
      itemId: item.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      element,
      touch: event.pointerType === "touch",
    };
    this.pointerCandidate = candidate;
    this.scrollElement = this.scrollBody();
    this.scrollElement?.addEventListener("scroll", this.onScroll);
    document.addEventListener("pointermove", this.onPointerMove);
    document.addEventListener("pointerup", this.onPointerUp);
    document.addEventListener("pointercancel", this.onPointerCancel);
    document.addEventListener("keydown", this.onDragKeydown, true);
    window.addEventListener("blur", this.cancel);
    document.addEventListener("touchmove", this.blockTouchScroll, { passive: false });
    if (candidate.touch) {
      // A touch drag cannot begin on contact: that gesture belongs to scrolling.
      candidate.longPressTimer = window.setTimeout(() => { this.startDrag(candidate, candidate.startX, candidate.startY); }, LONG_PRESS_MS);
      return;
    }
    try { element.setPointerCapture(event.pointerId); } catch { /* Capture is an optimization; move and up still arrive while the pointer is over the row. */ }
  }

  private pointerCandidateFor(event: PointerEvent): PointerReorderCandidate | undefined {
    const candidate = this.pointerCandidate;
    return candidate?.pointerId === event.pointerId ? candidate : undefined;
  }

  private movePointerReorder(event: PointerEvent): void {
    const candidate = this.pointerCandidateFor(event);
    if (candidate === undefined) return;
    if (this.draggingId === undefined) {
      const distance = Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY);
      if (candidate.touch) {
        // Moving before the long press elapses means the user wanted to scroll.
        if (distance > LONG_PRESS_MOVE_TOLERANCE_PX) this.cancel();
        return;
      }
      if (Math.abs(event.clientY - candidate.startY) < DRAG_THRESHOLD_PX) return;
      this.startDrag(candidate, event.clientX, event.clientY);
    }
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.dropSlot = this.isOverList(event.clientX, event.clientY) ? this.slotForPointer(event.clientY) : undefined;
    this.moveGhost(event.clientX, event.clientY);
    this.syncAutoScroll();
    event.preventDefault();
  }

  private startDrag(candidate: PointerReorderCandidate, clientX: number, clientY: number): void {
    if (this.pointerCandidate !== candidate) return;
    if (candidate.longPressTimer !== undefined) {
      clearTimeout(candidate.longPressTimer);
      candidate.longPressTimer = undefined;
    }
    this.draggingId = candidate.itemId;
    this.suppressClick = true;
    this.lastPointerX = clientX;
    this.lastPointerY = clientY;
    this.dropSlot = this.slotForPointer(clientY);
    // The contact that started the drag may already have begun a text selection or callout.
    window.getSelection()?.removeAllRanges();
    try { candidate.element.setPointerCapture(candidate.pointerId); } catch { /* Document listeners also track uncaptured pointers. */ }
    this.showGhost(candidate, clientX, clientY);
    this.syncAutoScroll();
  }

  private endPointerReorder(event: PointerEvent, commit: boolean): void {
    const candidate = this.pointerCandidateFor(event);
    if (candidate === undefined) return;
    const draggedId = this.draggingId;
    const slot = this.isOverList(event.clientX, event.clientY) ? this.slotForPointer(event.clientY) : undefined;
    this.cancel();
    if (!commit || draggedId === undefined || slot === undefined) return;
    const from = this.options.items().findIndex((item) => item.id === draggedId);
    const target = dropTarget(this.options.items(), from, slot);
    const dragged = this.options.items()[from];
    const neighbor = this.options.items().find((item) => item.id === target?.neighborId);
    if (target === undefined || dragged === undefined || neighbor === undefined) return;
    this.options.onDrop(dragged, neighbor, target.position);
    this.announcement = messages.t(target.position === "before" ? "movedBefore" : "movedAfter", { name: this.options.label(dragged), neighbor: this.options.label(neighbor) });
  }

  private cancelPointerCandidate(): void {
    const candidate = this.pointerCandidate;
    if (candidate === undefined) return;
    this.pointerCandidate = undefined;
    if (candidate.longPressTimer !== undefined) clearTimeout(candidate.longPressTimer);
    try { candidate.element.releasePointerCapture(candidate.pointerId); } catch { /* Already released. */ }
  }

  private clearDrag(): void {
    this.draggingId = undefined;
    this.dropSlot = undefined;
    this.lastPointerX = undefined;
    this.lastPointerY = undefined;
    this.scrollElement?.removeEventListener("scroll", this.onScroll);
    this.scrollElement = null;
    this.stopAutoScroll();
    this.removeGhost();
    document.removeEventListener("touchmove", this.blockTouchScroll);
  }

  /** Implicit touch capture transfers from a descendant to the row when lifted. */
  handleLostPointerCapture(event: PointerEvent): void {
    const candidate = this.pointerCandidateFor(event);
    if (event.target === candidate?.element) this.cancel();
  }

  private readonly onScroll = (): void => {
    const x = this.lastPointerX;
    const y = this.lastPointerY;
    if (this.draggingId === undefined || x === undefined || y === undefined) return;
    this.dropSlot = this.isOverList(x, y) ? this.slotForPointer(y) : undefined;
    this.syncAutoScroll();
  };

  private readonly onPointerMove = (event: PointerEvent): void => { this.movePointerReorder(event); };
  private readonly onPointerUp = (event: PointerEvent): void => { this.endPointerReorder(event, true); };
  private readonly onPointerCancel = (event: PointerEvent): void => { this.endPointerReorder(event, false); };
  private readonly onDragKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
  };

  readonly cancel = (): void => {
    this.cancelPointerCandidate();
    this.clearDrag();
    document.removeEventListener("pointermove", this.onPointerMove);
    document.removeEventListener("pointerup", this.onPointerUp);
    document.removeEventListener("pointercancel", this.onPointerCancel);
    document.removeEventListener("keydown", this.onDragKeydown, true);
    window.removeEventListener("blur", this.cancel);
  };

  private readonly blockTouchScroll = (event: TouchEvent): void => {
    if (this.draggingId !== undefined && event.touches.length === 1) event.preventDefault();
    else if (event.touches.length > 1) this.cancel();
  };

  private isOverList(clientX: number, clientY: number): boolean {
    const rect = this.scrollBody()?.getBoundingClientRect();
    return rect !== undefined && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  /** A manual popover escapes clipping/containing blocks without leaving the themed shadow root. */
  private showGhost(candidate: PointerReorderCandidate, clientX: number, clientY: number): void {
    this.removeGhost();
    const clone = candidate.element.cloneNode(true);
    if (!(clone instanceof HTMLElement)) return;
    clone.classList.remove("dragging", "drop-before", "drop-after");
    clone.classList.add("list-drag-preview");
    clone.removeAttribute("data-reorder-id");
    clone.removeAttribute("data-reorder-group-id");
    for (const name of ["data-project-id", "data-workspace-id", "data-session-id"]) clone.removeAttribute(name);
    clone.removeAttribute("tabindex");
    clone.setAttribute("aria-hidden", "true");
    clone.inert = true;
    clone.popover = "manual";
    clone.querySelector(".action-menu")?.remove();
    clone.style.width = px(Math.max(0, candidate.element.getBoundingClientRect().width - PREVIEW_INSET_PX * 2));
    // Preserve scoped theme selectors as well as the component's styles.
    this.host.renderRoot.querySelector("section")?.append(clone);
    this.ghost = clone;
    clone.showPopover();
    this.moveGhost(clientX, clientY);
  }

  private moveGhost(clientX: number, clientY: number): void {
    const ghost = this.ghost;
    const candidate = this.pointerCandidate;
    if (ghost === undefined || candidate === undefined) return;
    ghost.style.transform = `translate(${px(clientX - candidate.grabX + PREVIEW_INSET_PX)}, ${px(clientY - candidate.grabY)})`;
  }

  private removeGhost(): void {
    this.ghost?.hidePopover();
    this.ghost?.remove();
    this.ghost = undefined;
  }

  /** Insertion slot for a pointer position inside a clipping, scrollable list.
   * Once the list cannot scroll further, a pointer parked in the bottom edge zone
   * means "end of list", not "first row still hidden below the fold".
   */
  private slotForPointer(clientY: number): number {
    const slot = insertionSlot(this.rowRects(), clientY);
    const body = this.scrollBody();
    if (body === null || body.scrollHeight <= body.clientHeight + 1) return slot;
    const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
    const rect = body.getBoundingClientRect();
    return atEnd && clientY > rect.bottom - AUTOSCROLL_EDGE_PX ? this.options.items().length : slot;
  }

  private scrollBody(): HTMLElement | null {
    return this.host.renderRoot.querySelector<HTMLElement>(".list-body");
  }

  private autoScrollStepPx(): number {
    const body = this.scrollBody();
    const pointerY = this.lastPointerY;
    if (body === null || pointerY === undefined || this.draggingId === undefined || this.dropSlot === undefined) return 0;
    if (body.scrollHeight <= body.clientHeight) return 0;
    const rect = body.getBoundingClientRect();
    const step = autoscrollStep(pointerY, { top: rect.top, bottom: rect.bottom }, AUTOSCROLL_EDGE_PX, AUTOSCROLL_MAX_PX);
    const rows = this.rowRects();
    // Pinned roots share a scroller with unpinned sessions. Do not scroll past the reorderable group.
    if (step > 0 && (rows.at(-1)?.bottom ?? rect.bottom) <= rect.bottom) return 0;
    if (step < 0 && (rows[0]?.top ?? rect.top) >= rect.top) return 0;
    return step;
  }

  /** Keep scrolling while the pointer waits near an edge; the drop slot follows the rows under it. */
  private syncAutoScroll(): void {
    if (this.autoScrollStepPx() === 0) {
      this.stopAutoScroll();
      return;
    }
    if (this.autoScrollFrame !== undefined) return;
    const step = () => {
      this.autoScrollFrame = undefined;
      const body = this.scrollBody();
      const delta = this.autoScrollStepPx();
      if (body === null || delta === 0) return;
      const before = body.scrollTop;
      body.scrollTop = before + delta;
      const pointerY = this.lastPointerY;
      if (pointerY !== undefined) this.dropSlot = this.slotForPointer(pointerY);
      // Stop at either end instead of scheduling frames that cannot move the list.
      if (body.scrollTop === before) return;
      this.autoScrollFrame = requestAnimationFrame(step);
    };
    this.autoScrollFrame = requestAnimationFrame(step);
  }

  private stopAutoScroll(): void {
    if (this.autoScrollFrame === undefined) return;
    cancelAnimationFrame(this.autoScrollFrame);
    this.autoScrollFrame = undefined;
  }

  consumeClick(): boolean {
    if (!this.suppressClick) return false;
    this.suppressClick = false;
    return true;
  }

  private rowRects(): { top: number; bottom: number }[] {
    const members = [...this.host.renderRoot.querySelectorAll<HTMLElement>("[data-reorder-group-id]")];
    return [...this.host.renderRoot.querySelectorAll<HTMLElement>("[data-reorder-id]")].map((row) => {
      const rect = row.getBoundingClientRect();
      const group = members.filter((member) => member.dataset["reorderGroupId"] === row.dataset["reorderId"]);
      const bottom = Math.max(rect.bottom, ...group.map((member) => member.getBoundingClientRect().bottom));
      row.style.setProperty("--reorder-group-height", px(bottom - rect.top));
      return { top: rect.top, bottom };
    });
  }

  /** Indicator boundary for a row, or undefined for the dragged row and its immediate neighbor. */
  rowClass(id: string): string {
    if (this.draggingId === undefined) return "";
    const index = this.options.items().findIndex((item) => item.id === id);
    const position = this.dropPosition(index);
    return `${this.draggingId === id ? "dragging" : ""} ${position === undefined ? "" : `drop-${position}`}`;
  }

  private dropPosition(index: number): DropPosition | undefined {
    const slot = this.dropSlot;
    const draggedId = this.draggingId;
    if (slot === undefined || draggedId === undefined) return undefined;
    const from = this.options.items().findIndex((item) => item.id === draggedId);
    if (slot === from || slot === from + 1) return undefined;
    if (slot === index) return "before";
    return slot === this.options.items().length && index === this.options.items().length - 1 ? "after" : undefined;
  }


}

interface PointerReorderCandidate {
  itemId: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** Pointer offset inside the row, so the ghost keeps the grabbed point under the finger. */
  grabX: number;
  grabY: number;
  element: HTMLElement;
  touch: boolean;
  longPressTimer?: number | undefined;
}

// Expose both ends of the insertion line behind the top-layer preview.
const PREVIEW_INSET_PX = 12;
const DRAG_THRESHOLD_PX = 4;
const LONG_PRESS_MS = 350;
const LONG_PRESS_MOVE_TOLERANCE_PX = 8;
const AUTOSCROLL_EDGE_PX = 36;
const AUTOSCROLL_MAX_PX = 14;

function px(value: number): string {
  return `${String(value)}px`;
}
