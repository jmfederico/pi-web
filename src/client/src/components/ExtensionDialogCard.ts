import { LocalizationController } from "../localization/browser";
import { extensionDialogMessages as messages } from "../extensionDialogMessages";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, svg, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { uiButtonStyles } from "./ui/controlStyles";
import { uiTranscriptStyles } from "./ui/transcriptStyles";
import { uiTranscriptCardStyles } from "./ui/transcriptCardStyles";
import { uiFormStyles } from "./ui/formStyles";
import {
  EXTENSION_DIALOG_INPUT_MAX_LENGTH,
  type ExtensionDialogAnswer,
  type ExtensionDialogCloseReason,
  type PendingExtensionDialog,
} from "../../../shared/apiTypes";
import { PendingFormState, pendingFormKey, type PendingFormIdentity } from "../pendingFormState";
import type { ClosedExtensionDialog } from "../appState";

export type ExtensionDialogAnswerCallback = (dialogId: string, value: ExtensionDialogAnswer) => void | Promise<void>;
export type ExtensionDialogCancelCallback = (dialogId: string) => void | Promise<void>;
export type ExtensionDialogDismissCallback = (dialogId: string) => void;

const COUNTDOWN_TICK_MS = 1_000;

/** Header status label for a closed extension dialog. */
export function extensionDialogCloseLabel(reason: ExtensionDialogCloseReason): string {
  return messages.t(reason);
}

/** Input answers stay hidden unless the user explicitly reveals this card's answer. */
export function extensionDialogCloseSummary(closed: ClosedExtensionDialog, revealInputAnswer = false): string {
  switch (closed.reason) {
    case "answered": {
      const answer = closed.answer;
      // An answered close without an answer value breaks the wire contract;
      // the card still renders rather than crashing the transcript.
      if (answer === undefined) return messages.t("missingAnswer");
      if (closed.dialog.kind === "input" && !revealInputAnswer) return messages.t("hiddenAnswer");
      if (typeof answer === "boolean") return messages.t("booleanAnswer", { answer: answer ? "yes" : "no" });
      return answer === "" ? messages.t("emptyAnswer") : messages.t("textAnswer", { answer });
    }
    case "cancelled": return messages.t("cancelledSummary");
    case "timeout": return messages.t("timeoutSummary");
    case "aborted": return messages.t("abortedSummary");
    case "session-ended": return messages.t("sessionEndedSummary");
  }
}

/**
 * Remaining-time label for an open dialog's auto-cancel deadline. Display
 * only: the daemon owns the real timeout and publishes `dialog.closed`, so a
 * card whose countdown reaches zero simply waits for that event.
 */
export function extensionDialogCountdownText(timeoutAt: string | undefined, nowMs: number): string | undefined {
  if (timeoutAt === undefined) return undefined;
  const deadline = Date.parse(timeoutAt);
  if (!Number.isFinite(deadline)) return undefined;
  const remainingMs = deadline - nowMs;
  if (remainingMs <= 0) return messages.t("imminent");
  const seconds = Math.ceil(remainingMs / 1000);
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    // Floor, not round: rounding yields "1h 60m" in the last half-minute of an hour.
    const minutes = Math.floor((seconds % 3600) / 60);
    return messages.t("hours", { hours, minutes });
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    return messages.t("minutes", { minutes, seconds: seconds % 60 });
  }
  return messages.t("seconds", { seconds });
}

/**
 * One extension dialog opened by `ctx.ui.confirm()`, `ctx.ui.select()`, or
 * `ctx.ui.input()`.
 *
 * The supplied form state owns input and in-flight operations across remounts.
 * Countdown and answer reveal remain card-local; the daemon remains the
 * source of truth for whether the dialog is open. Closed mode renders the
 * settled outcome — a browser-local record that stays until dismissed — for a
 * browser that saw the dialog open.
 */
@customElement("extension-dialog-card")
export class ExtensionDialogCard extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @property({ attribute: false }) dialog?: PendingExtensionDialog;
  @property({ attribute: false }) outcome?: ClosedExtensionDialog;
  @property({ attribute: false }) onAnswer?: ExtensionDialogAnswerCallback;
  @property({ attribute: false }) onCancel?: ExtensionDialogCancelCallback;
  @property({ attribute: false }) onDismiss?: ExtensionDialogDismissCallback;

  @property({ attribute: false }) formState: PendingFormState = new PendingFormState();
  @property({ attribute: false }) formScope = "";
  private unsubscribe: (() => void) | undefined;
  private boundState?: PendingFormState;
  private boundKey?: string;

  private get formIdentity(): PendingFormIdentity {
    return { scope: this.formScope, kind: "dialog", requestId: this.outcome?.dialog.dialogId ?? this.dialog?.dialogId ?? "" };
  }
  private get inputValue(): string { return this.formState.get(this.formIdentity).input; }
  private get closing(): boolean { return this.formState.get(this.formIdentity).operation !== undefined; }
  @state() private answerVisible = false;
  @state() private countdownNow = 0;
  private dialogIdentity: string | undefined;
  private countdownTimer: number | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.syncCountdownTimer();
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    this.answerVisible = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.stopCountdownTimer();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    const key = pendingFormKey(this.formIdentity);
    const active = this.isConnected && this.dialog !== undefined && this.outcome === undefined;
    if (!active || this.boundState !== this.formState || this.boundKey !== key || this.unsubscribe === undefined) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.boundState = this.formState;
      this.boundKey = key;
      if (active) this.unsubscribe = this.formState.subscribe(this.formIdentity, () => { this.requestUpdate(); });
    }
    if (!changed.has("dialog") && !changed.has("outcome") && !changed.has("formScope") && !changed.has("formState")) return;
    if (this.outcome !== undefined) this.formState.forgetDialog(this.formScope, this.outcome.dialog.dialogId);
    // Identity is keyed by dialogId, not object identity: status refreshes
    // re-project the same open dialog as a new object and must not wipe a
    // half-typed answer or an in-flight close.
    const identity = this.currentIdentity();
    if (identity !== this.dialogIdentity) {
      this.dialogIdentity = identity;
      this.answerVisible = false;
    }
    this.syncCountdownTimer();
  }

  override render(): TemplateResult | null {
    if (this.outcome !== undefined) return this.renderClosed(this.outcome);
    if (this.dialog !== undefined) return this.renderOpen(this.dialog);
    return null;
  }

  private renderOpen(dialog: PendingExtensionDialog): TemplateResult {
    const countdown = extensionDialogCountdownText(dialog.timeoutAt, this.countdownNow === 0 ? Date.now() : this.countdownNow);
    return html`
      <article class="ui-transcript-surface card open-card" aria-labelledby="extension-dialog-heading">
        <header class="ui-transcript-card-header card-header">
          <h2 id="extension-dialog-heading" dir="auto">${dialog.title}</h2>
          ${countdown === undefined
            ? null
            // Decorative only — no live region: a polite region would queue one
            // announcement per second. The daemon-owned dialog.closed event is
            // the real signal, and the settled card announces the outcome.
            : html`<span class="ui-transcript-card-status header-status countdown">${countdown}</span>`}
        </header>
        ${this.renderOpenBody(dialog)}
      </article>
    `;
  }

  private renderOpenBody(dialog: PendingExtensionDialog): TemplateResult {
    if (dialog.kind === "select") return this.renderSelectBody(dialog);
    if (dialog.kind === "input") return this.renderInputBody(dialog);
    return this.renderConfirmBody(dialog);
  }

  private renderConfirmBody(dialog: PendingExtensionDialog): TemplateResult {
    return html`
      ${dialog.message === undefined ? null : html`<p class="dialog-message" dir="auto">${dialog.message}</p>`}
      <footer class="dialog-footer">
        <button class="ui-button ui-button--compact secondary-action" type="button" ?disabled=${this.closing} @click=${() => { this.cancelDialog(dialog); }}>${messages.t("cancel")}</button>
        <button class="ui-button ui-button--compact secondary-action" type="button" ?disabled=${this.closing} @click=${() => { this.answerDialog(dialog, false); }}>${messages.t("no")}</button>
        <button class="ui-button ui-button--primary primary-action" type="button" ?disabled=${this.closing} @click=${() => { this.answerDialog(dialog, true); }}>${messages.t("yes")}</button>
      </footer>
    `;
  }

  private renderSelectBody(dialog: PendingExtensionDialog): TemplateResult {
    return html`
      <div class="dialog-options" role="group" aria-label=${messages.t("choices")}>
        ${(dialog.options ?? []).map((option) => html`
          <button class="ui-button option-button" dir="auto" type="button" ?disabled=${this.closing} @click=${() => { this.answerDialog(dialog, option); }}>${option}</button>
        `)}
      </div>
      <footer class="dialog-footer">
        <button class="ui-button ui-button--compact secondary-action" type="button" ?disabled=${this.closing} @click=${() => { this.cancelDialog(dialog); }}>${messages.t("cancel")}</button>
      </footer>
    `;
  }

  private renderInputBody(dialog: PendingExtensionDialog): TemplateResult {
    return html`
      <form class="dialog-input-form" @submit=${(event: SubmitEvent) => { this.submitInput(event, dialog); }}>
        <input
          class="ui-input dialog-input"
          type="text"
          name="dialog-answer"
          dir="auto"
          aria-label=${messages.t("yourAnswer")}
          placeholder=${ifDefined(dialog.placeholder)}
          maxlength=${String(EXTENSION_DIALOG_INPUT_MAX_LENGTH)}
          .value=${this.inputValue}
          ?disabled=${this.closing}
          @input=${(event: Event) => { this.changeInput(event); }}
        />
        <footer class="dialog-footer">
          <button class="ui-button ui-button--compact secondary-action" type="button" ?disabled=${this.closing} @click=${() => { this.cancelDialog(dialog); }}>${messages.t("cancel")}</button>
          <button class="ui-button ui-button--primary primary-action" type="submit" ?disabled=${this.closing}>${messages.t(this.closing ? "sending" : "send")}</button>
        </footer>
      </form>
    `;
  }

  private renderClosed(closed: ClosedExtensionDialog): TemplateResult {
    const canReveal = closed.reason === "answered" && closed.dialog.kind === "input" && closed.answer !== undefined;
    const visibilityLabel = messages.t(this.answerVisible ? "hideAnswer" : "seeAnswer");
    return html`
      <article class="ui-transcript-surface card closed-card" aria-labelledby="extension-dialog-closed-heading">
        <header class="ui-transcript-card-header card-header">
          <h2 id="extension-dialog-closed-heading" dir="auto">${closed.dialog.title}</h2>
          <span class=${`ui-transcript-card-status header-status ${closed.reason} ${closed.reason === "answered" ? "ui-transcript-card-status--success" : closed.reason === "cancelled" ? "" : "ui-transcript-card-status--warning"}`}>${extensionDialogCloseLabel(closed.reason)}</span>
          <div class="closed-actions">
            ${canReveal ? html`
              <button
                class="ui-button ui-button--compact ui-button--icon answer-visibility"
                type="button"
                aria-label=${visibilityLabel}
                title=${visibilityLabel}
                aria-expanded=${String(this.answerVisible)}
                aria-controls="extension-dialog-answer"
                @click=${() => { this.answerVisible = !this.answerVisible; }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
                  ${this.answerVisible
                    ? svg`<path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A10 10 0 0 1 12 5c6 0 10 7 10 7a18 18 0 0 1-3 3.8M6.2 6.2A18 18 0 0 0 2 12s4 7 10 7a10 10 0 0 0 5.8-1.8" />`
                    : svg`<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />`}
                </svg>
              </button>
            ` : null}
            <button class="ui-button ui-button--compact secondary-action" type="button" @click=${() => { this.dismissClosed(closed); }}>${messages.t("dismiss")}</button>
          </div>
        </header>
        <p id="extension-dialog-answer" class="closed-summary" dir="auto">${extensionDialogCloseSummary(closed, this.answerVisible)}</p>
      </article>
    `;
  }

  private answerDialog(dialog: PendingExtensionDialog, value: ExtensionDialogAnswer): void {
    const callback = this.onAnswer;
    if (callback !== undefined) this.closeWith(dialog, () => callback(dialog.dialogId, value));
  }

  private cancelDialog(dialog: PendingExtensionDialog): void {
    const callback = this.onCancel;
    if (callback !== undefined) this.closeWith(dialog, () => callback(dialog.dialogId));
  }

  private submitInput(event: SubmitEvent, dialog: PendingExtensionDialog): void {
    event.preventDefault();
    // An empty string is a valid input answer, so Send stays enabled.
    this.answerDialog(dialog, this.inputValue);
  }

  private closeWith(dialog: PendingExtensionDialog, close: () => void | Promise<void>): void {
    if (this.closing || this.outcome !== undefined || this.dialog?.dialogId !== dialog.dialogId) return;
    void this.formState.runExclusive(this.formIdentity, close)
      .catch(() => {
        // The parent controller owns the visible transport error. Keeping this
        // card usable is the only recovery needed at this boundary.
      });
  }

  private changeInput(event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    this.formState.setInput(this.formIdentity, input.value.slice(0, EXTENSION_DIALOG_INPUT_MAX_LENGTH));
  }

  private dismissClosed(closed: ClosedExtensionDialog): void {
    this.onDismiss?.(closed.dialog.dialogId);
  }

  private currentIdentity(): string | undefined {
    if (this.outcome !== undefined) return JSON.stringify(["closed", this.formScope, this.outcome.dialog.dialogId]);
    if (this.dialog !== undefined) return JSON.stringify(["open", this.formScope, this.dialog.dialogId]);
    return undefined;
  }

  private syncCountdownTimer(): void {
    const needsTick = this.isConnected && this.outcome === undefined && this.dialog?.timeoutAt !== undefined;
    if (needsTick && this.countdownTimer === undefined) {
      this.countdownNow = Date.now();
      this.countdownTimer = window.setInterval(() => { this.countdownNow = Date.now(); }, COUNTDOWN_TICK_MS);
      return;
    }
    if (!needsTick) this.stopCountdownTimer();
  }

  private stopCountdownTimer(): void {
    if (this.countdownTimer === undefined) return;
    window.clearInterval(this.countdownTimer);
    this.countdownTimer = undefined;
  }

  static override styles = [uiButtonStyles, uiFormStyles, uiTranscriptStyles, uiTranscriptCardStyles, css`
    :host {
      display: block;
      box-sizing: border-box;
      width: 100%;
      margin: 0 0 14px;
      color: var(--pi-text);
      font: 14px var(--pi-font, system-ui, sans-serif);
      container-type: inline-size;
    }
    h2, p { margin-top: 0; }
    h2 {
      flex: 1 1 0;
      min-width: 0;
      margin-bottom: 0;
      font-size: 14px;
      font-weight: 650;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .header-status { min-width: 0; max-inline-size: 50%; overflow-wrap: anywhere; }
    .closed-card .card-header { gap: 8px; padding-block: 6px; }
    .closed-actions { display: flex; flex: 0 1 auto; min-width: 0; }
    .closed-actions .secondary-action { overflow-wrap: anywhere; }
    .answer-visibility { flex: 0 0 auto; }
    .dialog-message {
      margin: 0;
      padding: 12px 16px;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .dialog-options { display: grid; gap: 0; padding: 12px 16px; }
    .option-button {
      display: block;
      width: 100%;
      color: var(--pi-text);
      text-align: start;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .dialog-input-form { display: grid; }
    .dialog-input {
      width: calc(100% - 32px);
      margin: 12px 16px 0;
    }
    .dialog-footer {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: 0;
      border-top: 1px solid var(--pi-border-muted);
      padding: 12px 16px;
    }
    .dialog-message + .dialog-footer, .dialog-options + .dialog-footer { border-top: 0; }
    .closed-summary {
      margin: 0;
      padding: 12px 16px;
      color: var(--pi-muted);
      font-size: 13px;
      line-height: 1.4;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `];
}

declare global {
  interface HTMLElementTagNameMap {
    "extension-dialog-card": ExtensionDialogCard;
  }
}
