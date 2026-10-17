import type { StylesheetIntegrationCapabilityV1 } from "@jmfederico/pi-web/plugin-api";
import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { TERMINAL_SOFT_KEYS, terminalSoftKeySequence, type TerminalModesSnapshot, type TerminalSoftKeyDefinition } from "./terminalKeys";

const SOFT_KEY_TAP_MOVE_THRESHOLD_PX = 8;
const SYNTHETIC_CLICK_SUPPRESSION_MS = 500;

export interface TerminalSoftKeyInputOptions {
  refocus: boolean;
}

export class TerminalSoftKeys extends LitElement {
  private integration: StylesheetIntegrationCapabilityV1 | undefined;
  private releaseStyles: (() => void) | undefined;

  @property({ attribute: false })
  get stylesheetIntegration(): StylesheetIntegrationCapabilityV1 | undefined { return this.integration; }
  set stylesheetIntegration(value: StylesheetIntegrationCapabilityV1 | undefined) {
    if (value === this.integration) return;
    this.releaseStyles?.();
    this.releaseStyles = undefined;
    this.integration = value;
    if (this.isConnected && this.renderRoot instanceof ShadowRoot) this.releaseStyles = value?.registerRoot(this.renderRoot);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.renderRoot instanceof ShadowRoot) this.releaseStyles ??= this.integration?.registerRoot(this.renderRoot);
  }

  override disconnectedCallback(): void {
    this.releaseStyles?.();
    this.releaseStyles = undefined;
    super.disconnectedCallback();
  }

  @property({ attribute: false }) modes: TerminalModesSnapshot | undefined;
  @property({ type: Boolean }) refocusOnClick = true;
  @property({ attribute: false }) onInput: (data: string, options: TerminalSoftKeyInputOptions) => void = () => undefined;

  private pointerStart: SoftKeyPointerStart | undefined;
  private lastPointerFinishedAt = 0;

  private sendSoftKey(key: TerminalSoftKeyDefinition, options: TerminalSoftKeyInputOptions): void {
    this.onInput(terminalSoftKeySequence(key.id, this.modes), options);
  }

  private onSoftKeyPointerDown(event: PointerEvent, key: TerminalSoftKeyDefinition): void {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    this.pointerStart = { pointerId: event.pointerId, key, clientX: event.clientX, clientY: event.clientY };
  }

  private onSoftKeyPointerMove(event: PointerEvent): void {
    const start = this.pointerStart;
    if (start?.pointerId !== event.pointerId) return;
    if (pointerMovedBeyondTap(start, event)) this.finishSoftKeyPointer();
  }

  private onSoftKeyPointerUp(event: PointerEvent, key: TerminalSoftKeyDefinition): void {
    const start = this.pointerStart;
    if (start?.pointerId !== event.pointerId) return;
    event.preventDefault();
    this.finishSoftKeyPointer();
    if (start.key.id !== key.id || pointerMovedBeyondTap(start, event)) return;
    this.sendSoftKey(key, { refocus: event.pointerType === "mouse" });
  }

  private onSoftKeyPointerCancel(event: PointerEvent): void {
    if (this.pointerStart?.pointerId === event.pointerId) this.finishSoftKeyPointer();
  }

  private finishSoftKeyPointer(): void {
    this.pointerStart = undefined;
    this.lastPointerFinishedAt = Date.now();
  }

  private onSoftKeyClick(event: MouseEvent, key: TerminalSoftKeyDefinition): void {
    if (Date.now() - this.lastPointerFinishedAt < SYNTHETIC_CLICK_SUPPRESSION_MS) {
      event.preventDefault();
      return;
    }
    this.sendSoftKey(key, { refocus: this.refocusOnClick });
  }

  override render() {
    return html`
      <div class="terminal-soft-keys" role="toolbar" aria-label="Terminal soft keys">
        ${TERMINAL_SOFT_KEYS.map((key) => html`
          <button
            type="button"
            class="soft-key"
            title=${key.title}
            aria-label=${key.ariaLabel}
            @pointerdown=${(event: PointerEvent) => { this.onSoftKeyPointerDown(event, key); }}
            @pointermove=${(event: PointerEvent) => { this.onSoftKeyPointerMove(event); }}
            @pointerup=${(event: PointerEvent) => { this.onSoftKeyPointerUp(event, key); }}
            @pointercancel=${(event: PointerEvent) => { this.onSoftKeyPointerCancel(event); }}
            @click=${(event: MouseEvent) => { this.onSoftKeyClick(event, key); }}
          >${key.label}</button>
        `)}
      </div>
    `;
  }

  static override styles = css`
    :host { flex: 0 0 auto; display: block; }
    .terminal-soft-keys { display: flex; align-items: stretch; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; touch-action: pan-x; }
    .terminal-soft-keys::-webkit-scrollbar { display: none; }
    button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; min-width: 32px; height: 32px; border: 0; border-inline-end: 1px solid var(--pi-border-muted); border-radius: 0; background: transparent; color: var(--pi-muted); padding: 0 10px; font: 12px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); cursor: pointer; touch-action: pan-x; -webkit-touch-callout: none; user-select: none; }
    button:hover:not(:disabled), button:active:not(:disabled) { background: var(--pi-surface); color: var(--pi-text); }
    button:focus-visible { outline: 2px solid var(--pi-text-secondary); outline-offset: -3px; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    @media (pointer: coarse) {
      button { min-width: 44px; height: 44px; }
    }
  `;
}

interface SoftKeyPointerStart {
  pointerId: number;
  key: TerminalSoftKeyDefinition;
  clientX: number;
  clientY: number;
}

function pointerMovedBeyondTap(start: SoftKeyPointerStart, event: PointerEvent): boolean {
  return Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > SOFT_KEY_TAP_MOVE_THRESHOLD_PX;
}
