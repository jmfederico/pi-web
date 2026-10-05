import { renderHeroIcon } from "../heroicons";
import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { clampPanelWidth, panelResizeConstraints, panelWidthFromDrag, panelWidthFromKeyboard, type PanelResizeConstraints, type ResizablePanelSide } from "../../appShell/panelResizeController";

export type PanelEdgeSide = ResizablePanelSide;

interface ActivePanelResize {
  pointerId: number;
  startClientX: number;
  startWidth: number;
  handle: HTMLElement;
  moved: boolean;
}

const RESIZE_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);
const DOUBLE_TAP_RESET_MS = 420;
const TAP_MOVE_TOLERANCE_PX = 4;

@customElement("app-panel-edge-control")
export class AppPanelEdgeControl extends LitElement {
  @property({ reflect: true }) side: PanelEdgeSide = "navigation";
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ type: Boolean }) resizable = false;
  @property({ type: Number }) panelWidth?: number;
  @property({ type: Number }) minWidth?: number;
  @property({ type: Number }) maxWidth?: number;
  @property() controls = "";
  @property() resizeLabel = "Resize panel";
  @property() expandLabel = "Expand panel";
  @property() collapseLabel = "Collapse panel";
  @property({ attribute: false }) onToggle?: () => void;
  @property({ attribute: false }) onResizeStart?: () => number | undefined;
  @property({ attribute: false }) onResize?: (width: number) => void;
  @property({ attribute: false }) onResizeEnd?: () => void;
  @property({ attribute: false }) onReset?: () => void;

  private activeResize: ActivePanelResize | undefined;
  private lastTapAt = 0;

  override disconnectedCallback(): void {
    this.finishActiveResize();
    super.disconnectedCallback();
  }

  override render() {
    const label = this.collapsed ? this.expandLabel : this.collapseLabel;
    return html`
      ${this.renderResizeHandle()}
      <button
        type="button"
        class="edge-button"
        title=${label}
        aria-label=${label}
        aria-controls=${this.controls}
        aria-expanded=${String(!this.collapsed)}
        @click=${() => { this.onToggle?.(); }}
      >${this.renderIcon()}</button>
    `;
  }

  private renderResizeHandle() {
    if (!this.resizable) return nothing;
    const constraints = this.resizeConstraints();
    return html`
      <div
        class="resize-handle"
        role="separator"
        tabindex="0"
        aria-label=${this.resizeLabel}
        title=${`${this.resizeLabel}. Double-click or double-tap to reset.`}
        aria-controls=${this.controls}
        aria-orientation="vertical"
        aria-valuemin=${String(constraints.minWidth)}
        aria-valuemax=${String(constraints.maxWidth)}
        aria-valuenow=${this.resizeAriaValueNow()}
        @pointerdown=${(event: PointerEvent) => { this.onResizePointerDown(event); }}
        @pointermove=${(event: PointerEvent) => { this.onResizePointerMove(event); }}
        @pointerup=${(event: PointerEvent) => { this.onResizePointerUp(event); }}
        @pointercancel=${(event: PointerEvent) => { this.onResizePointerCancel(event); }}
        @dblclick=${(event: MouseEvent) => { this.onResizeDoubleClick(event); }}
        @keydown=${(event: KeyboardEvent) => { this.onResizeKeyDown(event); }}
      ></div>
    `;
  }

  private resizeAriaValueNow() {
    return this.panelWidth === undefined ? nothing : String(Math.round(this.panelWidth));
  }

  private renderIcon() {
    return renderHeroIcon(this.iconDirection() === "left" ? "chevron-left" : "chevron-right", "edge-icon");
  }

  private iconDirection(): "left" | "right" {
    if (this.side === "navigation") return this.collapsed ? "right" : "left";
    return this.collapsed ? "left" : "right";
  }

  private onResizePointerDown(event: PointerEvent): void {
    if (!this.resizable || event.button !== 0) return;
    const handle = event.currentTarget;
    if (!(handle instanceof HTMLElement)) return;
    const startWidth = this.resizeStartWidth();
    if (startWidth === undefined) return;

    event.preventDefault();
    event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    this.activeResize = { pointerId: event.pointerId, startClientX: event.clientX, startWidth, handle, moved: false };
    this.toggleAttribute("resizing", true);
  }

  private onResizePointerMove(event: PointerEvent): void {
    const activeResize = this.activeResize;
    if (activeResize?.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (Math.abs(event.clientX - activeResize.startClientX) <= TAP_MOVE_TOLERANCE_PX) return;
    activeResize.moved = true;
    this.commitPanelWidth(panelWidthFromDrag(this.side, activeResize.startWidth, activeResize.startClientX, event.clientX, this.resizeConstraints()));
  }

  private onResizePointerUp(event: PointerEvent): void {
    const activeResize = this.activeResize;
    if (activeResize?.pointerId !== event.pointerId) return;
    event.preventDefault();
    this.finishActiveResize();
    if (!activeResize.moved) this.registerTapForReset();
  }

  private onResizePointerCancel(event: PointerEvent): void {
    if (this.activeResize?.pointerId !== event.pointerId) return;
    this.finishActiveResize();
  }

  private onResizeDoubleClick(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.resetPanelSize();
  }

  private onResizeKeyDown(event: KeyboardEvent): void {
    if (!this.resizable || !RESIZE_KEYS.has(event.key)) return;
    const currentWidth = this.resizeStartWidth();
    if (currentWidth === undefined) return;
    const nextWidth = panelWidthFromKeyboard(this.side, currentWidth, event.key, { largeStep: event.shiftKey, constraints: this.resizeConstraints() });
    if (nextWidth === undefined) return;

    event.preventDefault();
    event.stopPropagation();
    this.commitPanelWidth(nextWidth);
    this.onResizeEnd?.();
  }

  private registerTapForReset(): void {
    const now = Date.now();
    if (now - this.lastTapAt <= DOUBLE_TAP_RESET_MS) {
      this.lastTapAt = 0;
      this.resetPanelSize();
      return;
    }
    this.lastTapAt = now;
  }

  private resetPanelSize(): void {
    this.finishActiveResize();
    this.onReset?.();
  }

  private resizeStartWidth(): number | undefined {
    const width = this.onResizeStart?.() ?? this.panelWidth;
    if (width === undefined) return undefined;
    return clampPanelWidth(this.side, width, this.resizeConstraints());
  }

  private commitPanelWidth(width: number): void {
    this.onResize?.(clampPanelWidth(this.side, width, this.resizeConstraints()));
  }

  private finishActiveResize(): void {
    const activeResize = this.activeResize;
    if (activeResize === undefined) return;
    try {
      activeResize.handle.releasePointerCapture(activeResize.pointerId);
    } catch {
      // Pointer capture may already be gone if the browser canceled the drag.
    }
    this.activeResize = undefined;
    this.toggleAttribute("resizing", false);
    this.onResizeEnd?.();
  }

  private resizeConstraints(): PanelResizeConstraints {
    const defaults = panelResizeConstraints(this.side);
    return {
      ...defaults,
      minWidth: this.minWidth ?? defaults.minWidth,
      maxWidth: this.maxWidth ?? defaults.maxWidth,
    };
  }

  static override styles = css`
    :host { position: relative; min-width: 0; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: visible; background: var(--pi-border-muted); z-index: 2; }
    :host([side="navigation"]) { grid-column: 2; }
    :host([side="workspace"]) { grid-column: 4; }
    .resize-handle { position: absolute; inset: 0 -6px; z-index: 0; cursor: col-resize; touch-action: none; outline: none; }
    .resize-handle::after { content: ""; position: absolute; top: 0; bottom: 0; left: 50%; width: 1px; transform: translateX(-50%); background: transparent; transition: width .12s ease, background .12s ease, opacity .12s ease; }
    .resize-handle:hover::after, .resize-handle:focus-visible::after, :host([resizing]) .resize-handle::after { width: 3px; background: var(--pi-accent); opacity: .72; }
    .edge-button { position: relative; z-index: 1; box-sizing: border-box; display: grid; place-items: center; width: 18px; height: 48px; padding: 0; border: 1px solid var(--pi-border-muted); border-radius: 999px; background: var(--pi-bg); color: var(--pi-muted); opacity: .75; cursor: pointer; }
    .edge-button:hover, .edge-button:focus-visible { color: var(--pi-text); background: var(--pi-surface-hover); opacity: 1; }
    :host([side="navigation"][collapsed]) .edge-button { transform: translateX(calc(50% - .5px)); }
    :host([side="workspace"][collapsed]) .edge-button { transform: translateX(calc(-50% + .5px)); }
    .edge-icon { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
    @media (max-width: 1180px) {
      :host([side="navigation"]) { grid-row: 1 / 3; }
      :host([side="workspace"]) { display: none; }
    }
    @media (max-width: 760px) {
      :host([side="navigation"]) { display: none; }
    }
  `;
}
