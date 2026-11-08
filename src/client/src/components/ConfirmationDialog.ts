import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { LocalizationController } from "../localization/browser";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { uiDialogStyles } from "./ui/dialogStyles";
import "./ModalSurface";

type ConfirmationText = string | (() => string);

export interface ConfirmationRequest {
  title: ConfirmationText;
  message: ConfirmationText;
  confirmLabel: ConfirmationText;
  cancelLabel: ConfirmationText;
}

interface PendingConfirmation {
  prompt: ConfirmationRequest;
  resolve: (confirmed: boolean) => void;
}

function text(value: ConfirmationText): string {
  return typeof value === "function" ? value() : value;
}

/** Owns the prompt and its result, never the action being confirmed. */
@customElement("confirmation-dialog")
export class ConfirmationDialog extends LitElement {
  @state() private pending: PendingConfirmation | undefined;

  constructor() {
    super();
    new LocalizationController(this);
    stylesheetIntegrationCapability.createController(this);
  }

  request(prompt: ConfirmationRequest): Promise<boolean> {
    this.settle(this.pending, false);
    return new Promise((resolve) => { this.pending = { prompt, resolve }; });
  }

  override disconnectedCallback(): void {
    this.settle(this.pending, false);
    super.disconnectedCallback();
  }

  private settle(pending: PendingConfirmation | undefined, confirmed: boolean): void {
    if (pending === undefined || this.pending !== pending) return;
    this.pending = undefined;
    pending.resolve(confirmed);
  }

  override render() {
    const pending = this.pending;
    if (pending === undefined) return nothing;
    const { prompt } = pending;
    const title = text(prompt.title);
    // A replacement gets a fresh surface and safe initial focus; locale changes do not.
    return keyed(pending, html`
      <modal-surface .label=${title} .initialFocus=${"#confirmation-cancel"}
        .onClose=${() => { this.settle(pending, false); }}>
        <header class="ui-dialog-header"><h2 class="ui-dialog-title">${title}</h2></header>
        <div class="ui-dialog-body">${text(prompt.message)}</div>
        <footer class="ui-dialog-footer">
          <button type="button" id="confirmation-cancel" class="ui-button"
            @click=${() => { this.settle(pending, false); }}>${text(prompt.cancelLabel)}</button>
          <button type="button" id="confirmation-confirm" class="ui-button ui-button--primary"
            @click=${() => { this.settle(pending, true); }}>${text(prompt.confirmLabel)}</button>
        </footer>
      </modal-surface>`);
  }

  static override styles = [uiDialogStyles, css`
    :host { display: contents; --ui-dialog-width: 480px; }
    .ui-dialog-body { white-space: pre-wrap; overflow-wrap: anywhere; }
  `];
}
