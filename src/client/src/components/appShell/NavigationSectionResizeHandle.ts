import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { NAVIGATION_SECTION_MIN_HEIGHT, navigationSectionHeightFromDrag, navigationSectionHeightFromKeyboard } from "../../appShell/navigationSectionResizeController";

export interface NavigationSectionMeasurement {
  height: number;
  maxHeight: number;
}

interface ActiveResize {
  pointerId: number;
  startY: number;
  startHeight: number;
  handle: HTMLElement;
  moved: boolean;
}

@customElement("navigation-section-resize-handle")
export class NavigationSectionResizeHandle extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property() sectionLabel = "";
  @property() controls = "";
  @property({ attribute: false }) measurement: NavigationSectionMeasurement = { height: 44, maxHeight: 44 };
  @property({ attribute: false }) onResize?: (height: number) => void;
  @property({ attribute: false }) onReset?: () => void;
  private active: ActiveResize | undefined;
  private lastTapAt = 0;

  override disconnectedCallback(): void {
    this.finishResize();
    super.disconnectedCallback();
  }

  private commit(height: number): number {
    const { maxHeight } = this.measurement;
    const nextHeight = Math.round(Math.max(NAVIGATION_SECTION_MIN_HEIGHT, Math.min(height, maxHeight)));
    this.onResize?.(nextHeight);
    return nextHeight;
  }

  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    this.active = { pointerId: event.pointerId, startY: event.clientY, startHeight: this.measurement.height, handle, moved: false };
    this.toggleAttribute("resizing", true);
  }

  private pointerMove(event: PointerEvent): void {
    if (this.active?.pointerId !== event.pointerId) return;
    event.preventDefault();
    const delta = event.clientY - this.active.startY;
    if (Math.abs(delta) <= 4 && !this.active.moved) return;
    this.active.moved = true;
    const proposedHeight = this.active.startHeight + delta;
    const height = this.commit(navigationSectionHeightFromDrag(this.active.startHeight, this.active.startY, event.clientY));
    if (proposedHeight < NAVIGATION_SECTION_MIN_HEIGHT || proposedHeight > this.measurement.maxHeight) {
      // Discard overshoot so reversing at either limit moves the divider immediately.
      this.active.startY = event.clientY;
      this.active.startHeight = height;
    }
  }

  private pointerUp(event: PointerEvent): void {
    const active = this.active;
    if (active?.pointerId !== event.pointerId) return;
    this.finishResize();
    if (!active.moved) {
      const now = Date.now();
      if (now - this.lastTapAt <= 420) {
        this.lastTapAt = 0;
        this.onReset?.();
      } else this.lastTapAt = now;
    } else this.lastTapAt = 0;
  }

  private finishResize(): void {
    const active = this.active;
    if (active === undefined) return;
    this.active = undefined;
    if (active.handle.hasPointerCapture(active.pointerId)) active.handle.releasePointerCapture(active.pointerId);
    this.toggleAttribute("resizing", false);
  }

  private keyDown(event: KeyboardEvent): void {
    const { height, maxHeight } = this.measurement;
    const next = event.key === "End" ? maxHeight : navigationSectionHeightFromKeyboard(height, event.key, { largeStep: event.shiftKey });
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    this.commit(next);
  }

  override render() {
    return html`<div
      role="separator" tabindex="0" aria-orientation="horizontal"
      aria-label=${`Resize ${this.sectionLabel}`}
      title=${`Resize ${this.sectionLabel}. Double-click or double-tap to reset.`}
      aria-controls=${this.controls}
      aria-valuemin="44" aria-valuemax=${String(Math.round(this.measurement.maxHeight))}
      aria-valuenow=${String(Math.round(this.measurement.height))}
      @pointerdown=${(event: PointerEvent) => { this.pointerDown(event); }}
      @pointermove=${(event: PointerEvent) => { this.pointerMove(event); }}
      @pointerup=${(event: PointerEvent) => { this.pointerUp(event); }}
      @pointercancel=${() => { this.finishResize(); }}
      @lostpointercapture=${() => { this.finishResize(); }}
      @keydown=${(event: KeyboardEvent) => { this.keyDown(event); }}
      @dblclick=${() => { this.finishResize(); this.onReset?.(); }}
    ></div>`;
  }

  static override styles = css`
    /* Overlay the section's border without consuming any of its layout space. */
    :host { display: block; position: relative; flex: 0 0 0px; z-index: 4; }
    [role="separator"] { position: absolute; inset: -8px 0; cursor: row-resize; touch-action: none; outline: none; }
    [role="separator"]::after { content: ""; position: absolute; top: 50%; inset-inline: 0; height: 1px; transform: translateY(-50%); background: transparent; transition: height .12s ease, background .12s ease, opacity .12s ease; }
    [role="separator"]:hover::after, [role="separator"]:focus-visible::after,
    :host([resizing]) [role="separator"]::after { height: 3px; background: var(--pi-accent); opacity: .72; }
  `;
}
