import { LocalizationController, localization } from "../localization/browser";
import { projectWorkspaceMessages as messages } from "../projectWorkspaceMessages";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { Project } from "../api";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { createActionMenuController } from "./actionMenu";
import { hasStatusUnread, renderActionActivityIndicator, statusActivityKind } from "./activityBadge";
import type { KeyboardNavigableSection } from "./navigationFocus";
import { activateSelectableRow, focusSelectedOrFirstSelectableRow, handleSelectableRowKeyboard } from "./selectableRow";
import { listStyles } from "./shared";
import { sidebarListStyles } from "./sidebarListStyles";
import { autoscrollStep, dropTarget, insertionSlot, type DropPosition } from "./listReorder";

@customElement("project-list")
export class ProjectList extends LitElement implements KeyboardNavigableSection {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) selected?: Project;
  /** Status tree of the machine these projects belong to; absent means no indicators. */
  @property({ attribute: false }) statusSnapshot: MachineStatusSnapshot | undefined;
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ attribute: false }) onSelect?: (project: Project) => void;
  @property({ attribute: false }) onClose?: (project: Project) => void;
  @property({ attribute: false }) onMove?: (project: Project, direction: -1 | 1) => void;
  /** Place a dragged project next to a visible neighbor; the parent owns persistence. */
  @property({ attribute: false }) onReorder?: (project: Project, neighbor: Project, position: DropPosition) => void;
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @property({ attribute: false }) onFocusPreviousSection?: () => void | Promise<void>;
  @property({ attribute: false }) onFocusNextSection?: () => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;
  @state() private openMenuProjectId: string | undefined;
  @state() private draggingProjectId: string | undefined;
  @state() private dropSlot: number | undefined;
  readonly actionMenu = createActionMenuController(this, () => {
    if (this.openMenuProjectId === undefined) return undefined;
    const row = [...this.renderRoot.querySelectorAll<HTMLElement>("[data-project-id]")].find((item) => item.dataset["projectId"] === this.openMenuProjectId);
    return row?.querySelector<HTMLElement>(".action-menu-toggle") ?? undefined;
  }, () => { this.openMenuProjectId = undefined; });

  private focusedControl: HTMLElement | undefined;
  private focusAfterReorder: HTMLElement | undefined;
  private pointerCandidate: PointerReorderCandidate | undefined;
  private suppressClick = false;
  private autoScrollFrame: number | undefined;
  private lastPointerY: number | undefined;
  private ghost: HTMLElement | undefined;

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("projects")) {
      this.focusAfterReorder = this.focusedControl;
      this.clearDrag();
      this.pointerCandidate = undefined;
    }
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("projects") && this.focusAfterReorder?.isConnected === true) {
      const control = this.focusAfterReorder;
      const target = control instanceof HTMLButtonElement && control.disabled
        ? control.closest(".action-menu-panel")?.querySelector<HTMLElement>("button[data-move]:not(:disabled)")
        : control;
      target?.focus({ preventScroll: true });
    }
    this.focusAfterReorder = undefined;
    if (changed.has("projects") && this.openMenuProjectId !== undefined && !this.projects.some((project) => project.id === this.openMenuProjectId)) this.openMenuProjectId = undefined;
    if (changed.has("collapsed") && this.collapsed) this.openMenuProjectId = undefined;
  }

  async focusSelectedOrFirst(): Promise<boolean> {
    await this.updateComplete;
    return focusSelectedOrFirstSelectableRow(this.renderRoot, { fallbackSelector: ".section-toggle" });
  }

  override render() {
    return html`
      <section>
        <h2 class="ui-toolbar">${this.renderHeading()}</h2>
        ${this.collapsed ? null : html`
          <div class="list-body">
            ${repeat(this.projects, (project) => project.id, (project, index) => html`
              <div
                class=${`action-row ${this.selected?.id === project.id ? "selected" : ""} ${this.draggingProjectId === project.id ? "dragging" : ""} ${dropClass(this.dropPosition(index))}`.trim()}
                tabindex="0"
                data-project-id=${project.id}
                @focusin=${(event: FocusEvent) => { this.focusedControl = event.target instanceof HTMLElement ? event.target : undefined; }}
                @focusout=${() => { this.focusedControl = undefined; }}
                title=${project.path}
                @pointerdown=${(event: PointerEvent) => { this.beginPointerReorder(event, project); }}
                @pointermove=${(event: PointerEvent) => { this.movePointerReorder(event); }}
                @pointerup=${(event: PointerEvent) => { this.endPointerReorder(event, true); }}
                @pointercancel=${(event: PointerEvent) => { this.endPointerReorder(event, false); }}
                @contextmenu=${(event: MouseEvent) => { if (this.draggingProjectId !== undefined) event.preventDefault(); }}
                @click=${(event: MouseEvent) => {
                  if (this.consumeDragClick()) { event.preventDefault(); event.stopPropagation(); return; }
                  activateSelectableRow(event, () => this.onSelect?.(project));
                }}
                @keydown=${(event: KeyboardEvent) => { this.handleProjectKeydown(event, project); }}
              >
                <div class="action-main">
                  <span class="workspace-primary"><span class="workspace-primary-label"><bdi>${project.name}</bdi></span></span><small><bdi dir="ltr">${project.path}</bdi></small>
                  ${this.renderActivity(project)}
                </div>
                <div class="action-menu">
                  <button class="ui-button ui-button--icon action-menu-toggle" title=${messages.t("projectActions")} aria-label=${messages.t("actionsFor", { name: project.name })} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(project.id); }}>⋯</button>
                  ${this.openMenuProjectId === project.id ? html`
                    <div popover="auto" class="action-menu-panel ui-menu" @click=${(event: MouseEvent) => { event.stopPropagation(); }}>
                      ${this.onMove === undefined ? null : html`
                        <button class="ui-button ui-menu-item" data-move ?disabled=${index === 0} @click=${() => { this.onMove?.(project, -1); }}>${messages.t("moveUp")}</button>
                        <button class="ui-button ui-menu-item" data-move ?disabled=${index === this.projects.length - 1} @click=${() => { this.onMove?.(project, 1); }}>${messages.t("moveDown")}</button>
                      `}
                      <button class="ui-button ui-menu-item" title=${messages.t("closeProject")} @click=${() => { this.close(project); }}>${messages.t("close")}</button>
                    </div>
                  ` : null}
                </div>
              </div>
            `)}
          </div>
        `}
      </section>
    `;
  }

  private handleProjectKeydown(event: KeyboardEvent, project: Project): void {
    if (event.key === "Escape" && this.draggingProjectId !== undefined) {
      event.preventDefault();
      this.cancelPointerCandidate();
      this.clearDrag();
      return;
    }
    handleSelectableRowKeyboard(event, {
      activate: () => this.onSelect?.(project),
      previousSection: this.onFocusPreviousSection === undefined ? undefined : () => { void this.onFocusPreviousSection?.(); },
      nextSection: this.onFocusNextSection === undefined ? undefined : () => { void this.onFocusNextSection?.(); },
      cancel: this.onCancelKeyboardNavigation === undefined ? undefined : () => { void this.onCancelKeyboardNavigation?.(); },
    });
  }

  private renderHeading() {
    if (!this.collapsible) return html`<span>${messages.t("projects")}</span>`;
    const selectedSummary = this.selected?.name ?? messages.t("noProject");
    const selectedTitle = this.selected?.path ?? selectedSummary;
    return html`<button class="ui-button ui-toolbar-title section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} ${messages.t("projects")}</span>${this.collapsed ? html`<small class="section-selected" title=${selectedTitle}>${selectedSummary}</small>` : null}</span><small class="section-count">${localization.number(this.projects.length)}</small></button>`;
  }

  private renderActivity(project: Project) {
    const flags = this.statusSnapshot?.projects[project.id];
    const kind = statusActivityKind(flags);
    const unreadLabel = hasStatusUnread(flags) ? messages.t("projectUnread") : undefined;
    return renderActionActivityIndicator(kind, kind === "terminal" ? messages.t("projectTerminal") : messages.t("projectActive"), unreadLabel);
  }

  private beginPointerReorder(event: PointerEvent, project: Project): void {
    if (this.onReorder === undefined || event.button !== 0) return;
    const element = event.currentTarget;
    if (!(element instanceof HTMLElement) || (event.target instanceof Element && event.target.closest(".action-menu") !== null)) return;
    this.cancelPointerCandidate();
    this.suppressClick = false;
    this.openMenuProjectId = undefined;
    const rect = element.getBoundingClientRect();
    const candidate: PointerReorderCandidate = {
      projectId: project.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      element,
      touch: event.pointerType === "touch",
    };
    this.pointerCandidate = candidate;
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
    if (this.draggingProjectId === undefined) {
      const distance = Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY);
      if (candidate.touch) {
        // Moving before the long press elapses means the user wanted to scroll.
        if (distance > LONG_PRESS_MOVE_TOLERANCE_PX) this.cancelPointerCandidate();
        return;
      }
      if (Math.abs(event.clientY - candidate.startY) < DRAG_THRESHOLD_PX) return;
      this.startDrag(candidate, event.clientX, event.clientY);
    }
    this.lastPointerY = event.clientY;
    this.dropSlot = this.slotForPointer(event.clientY);
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
    this.draggingProjectId = candidate.projectId;
    this.suppressClick = true;
    this.lastPointerY = clientY;
    this.dropSlot = this.slotForPointer(clientY);
    // The contact that started the drag may already have begun a text selection or callout.
    window.getSelection()?.removeAllRanges();
    if (candidate.touch) {
      // touch-action is fixed at gesture start, so block scrolling for the rest of this gesture.
      document.addEventListener("touchmove", this.blockTouchScroll, { passive: false });
      if ("vibrate" in navigator) navigator.vibrate(12);
    }
    this.showGhost(candidate, clientX, clientY);
    this.syncAutoScroll();
  }

  private endPointerReorder(event: PointerEvent, commit: boolean): void {
    const candidate = this.pointerCandidateFor(event);
    if (candidate === undefined) return;
    this.pointerCandidate = undefined;
    if (candidate.longPressTimer !== undefined) clearTimeout(candidate.longPressTimer);
    try { candidate.element.releasePointerCapture(candidate.pointerId); } catch { /* Already released. */ }
    const draggedId = this.draggingProjectId;
    const slot = this.dropSlot;
    this.clearDrag();
    if (!commit || draggedId === undefined || slot === undefined) return;
    const from = this.projects.findIndex((project) => project.id === draggedId);
    const target = dropTarget(this.projects, from, slot);
    const dragged = this.projects[from];
    const neighbor = this.projects.find((project) => project.id === target?.neighborId);
    if (target === undefined || dragged === undefined || neighbor === undefined) return;
    this.onReorder?.(dragged, neighbor, target.position);
  }

  private cancelPointerCandidate(): void {
    const candidate = this.pointerCandidate;
    if (candidate === undefined) return;
    this.pointerCandidate = undefined;
    if (candidate.longPressTimer !== undefined) clearTimeout(candidate.longPressTimer);
    try { candidate.element.releasePointerCapture(candidate.pointerId); } catch { /* Already released. */ }
  }

  private clearDrag(): void {
    this.draggingProjectId = undefined;
    this.dropSlot = undefined;
    this.lastPointerY = undefined;
    this.stopAutoScroll();
    this.removeGhost();
    document.removeEventListener("touchmove", this.blockTouchScroll);
  }

  private readonly blockTouchScroll = (event: TouchEvent): void => { event.preventDefault(); };

  /** A fixed copy of the row under the pointer, so the dragged project stays identifiable
   * after autoscroll or the pointer moves it outside the list.
   */
  private showGhost(candidate: PointerReorderCandidate, clientX: number, clientY: number): void {
    this.removeGhost();
    const clone = candidate.element.cloneNode(true);
    if (!(clone instanceof HTMLElement)) return;
    clone.classList.add("pi-drag-ghost");
    clone.removeAttribute("data-project-id");
    clone.removeAttribute("tabindex");
    clone.setAttribute("aria-hidden", "true");
    clone.querySelector(".action-menu")?.remove();
    const rowStyle = getComputedStyle(candidate.element);
    Object.assign(clone.style, {
      position: "fixed",
      left: "0",
      top: "0",
      zIndex: "6",
      margin: "0",
      width: px(candidate.element.getBoundingClientRect().width),
      pointerEvents: "none",
      boxSizing: "border-box",
      background: "var(--pi-surface)",
      border: "1px solid var(--pi-border)",
      borderRadius: "8px",
      boxShadow: "0 10px 24px rgba(0, 0, 0, 0.45)",
      overflow: "hidden",
      font: rowStyle.font,
      color: rowStyle.color,
    });
    const sourceMain = candidate.element.querySelector(".action-main");
    const targetMain = clone.querySelector(".action-main");
    if (sourceMain instanceof HTMLElement && targetMain instanceof HTMLElement) {
      for (const child of [...targetMain.children]) {
        if (!child.classList.contains("workspace-primary") && child.tagName !== "SMALL") child.remove();
      }
      const mainStyle = getComputedStyle(sourceMain);
      // The row chrome lives on the ghost itself; the copy carries text metrics and layout.
      Object.assign(targetMain.style, {
        background: "transparent",
        border: "0",
        color: mainStyle.color,
        padding: mainStyle.padding,
        font: mainStyle.font,
        display: "block",
        boxSizing: "border-box",
        width: "100%",
      });
      copyComputedLayout(candidate.element.querySelector(".workspace-primary"), targetMain.querySelector(".workspace-primary"));
      copyComputedLayout(candidate.element.querySelector("small"), targetMain.querySelector("small"));
    }
    this.ghost = clone;
    document.body.append(clone);
    this.moveGhost(clientX, clientY);
  }

  private moveGhost(clientX: number, clientY: number): void {
    const ghost = this.ghost;
    const candidate = this.pointerCandidate;
    if (ghost === undefined || candidate === undefined) return;
    ghost.style.transform = `translate(${px(clientX - candidate.grabX)}, ${px(clientY - candidate.grabY)})`;
  }

  private removeGhost(): void {
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
    return atEnd && clientY > rect.bottom - AUTOSCROLL_EDGE_PX ? this.projects.length : slot;
  }

  private scrollBody(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>(".list-body");
  }

  private autoScrollStepPx(): number {
    const body = this.scrollBody();
    const pointerY = this.lastPointerY;
    if (body === null || pointerY === undefined || this.draggingProjectId === undefined) return 0;
    if (body.scrollHeight <= body.clientHeight) return 0;
    const rect = body.getBoundingClientRect();
    return autoscrollStep(pointerY, { top: rect.top, bottom: rect.bottom }, AUTOSCROLL_EDGE_PX, AUTOSCROLL_MAX_PX);
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

  private consumeDragClick(): boolean {
    if (!this.suppressClick) return false;
    this.suppressClick = false;
    return true;
  }

  private rowRects(): { top: number; bottom: number }[] {
    return [...this.renderRoot.querySelectorAll<HTMLElement>("[data-project-id]")].map((row) => {
      const rect = row.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });
  }

  /** Indicator boundary for a row, or undefined for the dragged row and its immediate neighbor. */
  private dropPosition(index: number): DropPosition | undefined {
    const slot = this.dropSlot;
    const draggedId = this.draggingProjectId;
    if (slot === undefined || draggedId === undefined) return undefined;
    const from = this.projects.findIndex((project) => project.id === draggedId);
    if (slot === from || slot === from + 1) return undefined;
    if (slot === index) return "before";
    return slot === this.projects.length && index === this.projects.length - 1 ? "after" : undefined;
  }

  private toggleMenu(projectId: string) {
    if (this.openMenuProjectId === projectId) {
      this.openMenuProjectId = undefined;
      return;
    }
    this.openMenuProjectId = projectId;
  }

  private close(project: Project) {
    this.openMenuProjectId = undefined;
    if (confirm(messages.t("confirmClose", { name: project.name }))) this.onClose?.(project);
  }

  static override styles = [listStyles, sidebarListStyles];
}

interface PointerReorderCandidate {
  projectId: string;
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

const DRAG_THRESHOLD_PX = 4;
const LONG_PRESS_MS = 350;
const LONG_PRESS_MOVE_TOLERANCE_PX = 8;
const AUTOSCROLL_EDGE_PX = 36;
const AUTOSCROLL_MAX_PX = 14;

/** Layout the component stylesheet would give the row, but the ghost lives outside the shadow root. */
const GHOST_LAYOUT_PROPERTIES = ["display", "align-items", "gap", "margin", "padding", "font-size", "font-weight", "line-height", "color", "white-space", "overflow", "text-overflow", "min-width"];

function copyComputedLayout(source: Element | null, target: Element | null): void {
  if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement)) return;
  const style = getComputedStyle(source);
  for (const property of GHOST_LAYOUT_PROPERTIES) target.style.setProperty(property, style.getPropertyValue(property));
}

function px(value: number): string {
  return `${String(value)}px`;
}

function dropClass(position: DropPosition | undefined): string {
  return position === undefined ? "" : `drop-${position}`;
}
