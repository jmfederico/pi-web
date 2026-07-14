import { LitElement, css, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { secureInputApi, type SecureInputReceipt } from "../api";
import { commandPickerStyles } from "./shared";

@customElement("secure-input-dialog")
export class SecureInputDialog extends LitElement {
  @property() label = "Secret";
  @property({ type: Number }) maxBytes = 4096;
  @property({ attribute: false }) onClose?: () => void;
  @query("input") private input?: HTMLInputElement;
  @state() private submitting = false;
  @state() private revealInput = false;
  @state() private error = "";
  @state() private receipt?: SecureInputReceipt;

  override render() {
    return html`
      <div class="backdrop" @mousedown=${() => { if (!this.submitting) this.close(); }}>
        <section @mousedown=${(event: MouseEvent) => { event.stopPropagation(); }} @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}>
          <header>
            <strong>${this.label}</strong>
            <button type="button" title="Close" ?disabled=${this.submitting} @click=${() => { this.close(); }}>×</button>
          </header>
          <form @submit=${(event: SubmitEvent) => { event.preventDefault(); void this.submit(); }}>
            ${this.receipt === undefined ? html`
              <p>Send sensitive input directly to this PI WEB machine's configured receiver. It will not be added to the chat or session transcript.</p>
              <label for="secure-input-value">${this.label}</label>
              <div class="input-wrap">
                <input id="secure-input-value" name="secure-input-value" type=${this.revealInput ? "text" : "password"} autocomplete="off" autocapitalize="none" spellcheck="false" ?disabled=${this.submitting} autofocus>
                <button type="button" class="reveal" aria-label=${this.revealInput ? `Hide ${this.label}` : `Show ${this.label}`} aria-pressed=${String(this.revealInput)} title=${this.revealInput ? "Hide password" : "Show password"} ?disabled=${this.submitting} @click=${() => { this.toggleRevealInput(); }}>
                  ${this.revealInput ? html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18-1.4 1.4-3.1-3.1A11.7 11.7 0 0 1 12 20C5 20 1 12 1 12a21 21 0 0 1 4.1-5.3L1.6 4.4 3 3Zm4.9 5.5 2 2a2.8 2.8 0 0 0 3.6 3.6l2 2A5.5 5.5 0 0 1 7.9 8.5ZM12 4c7 0 11 8 11 8a20.6 20.6 0 0 1-3.1 4.4l-2.3-2.3a5.5 5.5 0 0 0-7.7-7.7L7.8 4.3A11.8 11.8 0 0 1 12 4Z"></path></svg>` : html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4C5 4 1 12 1 12s4 8 11 8 11-8 11-8-4-8-11-8Zm0 13a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"></path></svg>`}
                </button>
              </div>
              <small>Maximum ${this.maxBytes.toLocaleString()} UTF-8 bytes.</small>
              ${this.error === "" ? null : html`<div class="error-text" role="alert">${this.error}</div>`}
              <div class="actions">
                <button type="button" ?disabled=${this.submitting} @click=${() => { this.close(); }}>Cancel</button>
                <button type="submit" class="primary" ?disabled=${this.submitting}>${this.submitting ? "Sending…" : "Send securely"}</button>
              </div>
            ` : html`
              <p class="success" role="status">Accepted by the configured receiver.</p>
              <dl>
                <dt>Receipt</dt><dd>${this.receipt.receiptId}</dd>
                <dt>Accepted</dt><dd>${new Date(this.receipt.acceptedAt).toLocaleString()}</dd>
              </dl>
              <div class="actions"><button type="button" class="primary" @click=${() => { this.close(); }}>Close</button></div>
            `}
          </form>
        </section>
      </div>
    `;
  }

  protected override firstUpdated(): void {
    this.input?.focus();
  }

  private async submit(): Promise<void> {
    const input = this.input;
    if (input === undefined || this.submitting) return;
    const bytes = new TextEncoder().encode(input.value);
    input.value = "";
    this.revealInput = false;
    this.error = "";
    if (bytes.length === 0) {
      this.error = `${this.label} cannot be empty.`;
      return;
    }
    if (bytes.length > this.maxBytes) {
      bytes.fill(0);
      this.error = `${this.label} exceeds the ${this.maxBytes.toLocaleString()} byte limit.`;
      return;
    }

    this.submitting = true;
    try {
      this.receipt = await secureInputApi.submit(bytes);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      bytes.fill(0);
      this.submitting = false;
      if (this.receipt === undefined) await this.updateComplete.then(() => { this.input?.focus(); });
    }
  }

  private toggleRevealInput(): void {
    if (this.submitting) return;
    this.revealInput = !this.revealInput;
    void this.updateComplete.then(() => { this.input?.focus(); });
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || this.submitting) return;
    event.preventDefault();
    this.close();
  }

  private close(): void {
    const input = this.input;
    if (input != null) input.value = "";
    this.revealInput = false;
    this.onClose?.();
  }

  static override styles = [commandPickerStyles, css`
    form { display: grid; gap: 12px; padding: 14px; overflow: auto; }
    p { margin: 0; color: var(--pi-text-secondary); }
    label, small, dt { color: var(--pi-muted); }
    .input-wrap { position: relative; }
    input { box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 9px 42px 9px 10px; }
    input:focus { border-color: var(--pi-accent); outline: 2px solid color-mix(in srgb, var(--pi-accent) 30%, transparent); }
    .reveal { position: absolute; top: 50%; right: 5px; width: 32px; height: 32px; display: grid; place-items: center; transform: translateY(-50%); border: 0; border-radius: 6px; background: transparent; color: var(--pi-muted); padding: 6px; cursor: pointer; }
    .reveal:hover, .reveal:focus-visible { background: var(--pi-surface-hover); color: var(--pi-text); }
    .reveal svg { width: 20px; height: 20px; fill: currentColor; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; }
    .actions button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; }
    .actions button.primary { border-color: var(--pi-success-border); background: var(--pi-success-surface); color: var(--pi-success); }
    .actions button:disabled { opacity: .6; cursor: wait; }
    .error-text { color: var(--pi-danger); }
    .success { color: var(--pi-success); }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 10px; margin: 0; }
    dd { margin: 0; overflow-wrap: anywhere; }
  `];
}
