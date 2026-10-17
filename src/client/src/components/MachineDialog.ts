import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import "./ModalSurface";
import { uiDialogStyles, uiFormStyles } from "./ui/dialogStyles";

export interface MachineDialogSubmit {
  name: string;
  baseUrl: string;
  token?: string;
}

@customElement("machine-dialog")
export class MachineDialog extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) onSubmit?: (input: MachineDialogSubmit) => void | Promise<void>;
  @property({ attribute: false }) onCancel?: () => void;
  @property() error = "";

  @state() private url = "";
  @state() private name = "";
  @state() private token = "";
  @state() private submitting = false;
  @query("input[name='name']") private nameInput?: HTMLInputElement;

  private nameEdited = false;
  private previousSuggestedName = "";

  private handleUrlInput(event: InputEvent): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    const url = event.target.value;
    const suggestedName = suggestedMachineNameFromUrl(url);
    if (!this.nameEdited || this.name.trim() === "" || this.name === this.previousSuggestedName) this.name = suggestedName;
    this.previousSuggestedName = suggestedName;
    this.url = url;
  }

  private handleNameInput(event: InputEvent): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.nameEdited = true;
    this.name = event.target.value;
  }

  private handleTokenInput(event: InputEvent): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.token = event.target.value;
  }

  // Escape and backdrop presses are owned by the modal surface (routed to
  // `onCancel`); this handler keeps the form's Enter-to-advance behavior.
  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.name === "baseUrl" && machineBaseUrlValidationMessage(this.url) === undefined) {
      event.preventDefault();
      void this.updateComplete.then(() => {
        this.nameInput?.focus();
        this.nameInput?.select();
      });
    }
  }

  private handleSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.submit();
  }

  private async submit(): Promise<void> {
    const input = this.validInput();
    if (input === undefined || this.submitting) return;
    this.submitting = true;
    try {
      await this.onSubmit?.(input);
    } finally {
      if (this.isConnected) this.submitting = false;
    }
  }

  private validInput(): MachineDialogSubmit | undefined {
    const baseUrl = this.url.trim();
    const name = this.name.trim();
    if (baseUrl === "" || name === "" || machineBaseUrlValidationMessage(baseUrl) !== undefined) return undefined;
    const token = this.token.trim();
    return { name, baseUrl, ...(token === "" ? {} : { token }) };
  }

  override render() {
    const hasUrl = this.url.trim() !== "";
    const urlError = hasUrl ? machineBaseUrlValidationMessage(this.url) : undefined;
    const canSubmit = this.validInput() !== undefined && !this.submitting;
    return html`
      <modal-surface
        .onClose=${() => this.onCancel?.()}
        .initialFocus=${"input[name='baseUrl']"}
        .label=${"Add machine"}
        @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}
      >
        <form class="ui-form" aria-describedby=${this.error === "" ? "" : "machine-error"} @submit=${(event: SubmitEvent) => { this.handleSubmit(event); }}>
          <header class="ui-dialog-header">
            <strong class="ui-dialog-title">Add machine</strong>
            <button class="ui-button ui-button--icon" type="button" @click=${() => { this.onCancel?.(); }} aria-label="Close add machine">×</button>
          </header>
          <div class="body ui-dialog-body ui-form-body">
            ${this.error === "" ? null : html`<div id="machine-error" class="dialog-error ui-form-error" role="alert">${this.error}</div>`}
            <label class="ui-form-field">
              Remote PI WEB URL
              <input class="ui-input" name="baseUrl" type="url" aria-describedby="machine-url-help" aria-invalid=${urlError !== undefined ? "true" : "false"} .value=${this.url} @input=${(event: InputEvent) => { this.handleUrlInput(event); }} placeholder="http://dev-box.local:8504" autocomplete="url" inputmode="url" />
            </label>
            <small id="machine-url-help" aria-live="polite" class=${urlError === undefined ? "hint" : "field-error"}>${urlError ?? "Enter the reachable base URL first, including http:// or https://."}</small>
            ${hasUrl ? html`
              <label class="ui-form-field">
                Machine name
                <input class="ui-input" name="name" type="text" aria-describedby="machine-name-help" aria-invalid=${this.name.trim() === "" ? "true" : "false"} .value=${this.name} @input=${(event: InputEvent) => { this.handleNameInput(event); }} placeholder=${this.previousSuggestedName || "Dev Box"} autocomplete="off" />
              </label>
              <small id="machine-name-help" class=${this.name.trim() === "" ? "field-error" : "hint"}>${this.name.trim() === "" ? "Enter a machine name." : "Suggested from the URL. Edit it to use a friendlier sidebar label."}</small>
              <label class="ui-form-field">
                Bearer token <span class="optional">optional</span>
                <input class="ui-input" name="token" type="password" aria-describedby="machine-token-help" .value=${this.token} @input=${(event: InputEvent) => { this.handleTokenInput(event); }} placeholder="Leave blank if the remote machine does not require one" autocomplete="off" />
              </label>
              <small id="machine-token-help" class="hint">If the remote machine requires a token, paste it without the “Bearer” prefix.</small>
            ` : html`<p class="hint intro">After you enter a URL, PI WEB will suggest a machine name and let you add an optional bearer token.</p>`}
          </div>
          <footer class="ui-dialog-footer">
            <button class="ui-button" type="button" @click=${() => { this.onCancel?.(); }}>Cancel</button>
            <button class="ui-button ui-button--primary" type="submit" ?disabled=${!canSubmit}>${this.submitting ? "Adding…" : "Add machine"}</button>
          </footer>
        </form>
      </modal-surface>
    `;
  }

  static override styles = [uiDialogStyles, uiFormStyles, css`
    :host { --ui-dialog-width: 560px; --ui-input-font-family: var(--pi-control-monospace-font-family, var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)); }
    .hint { color: var(--pi-muted); }
    .intro { margin: 4px 0 0; line-height: 1.4; }
    .optional { color: var(--pi-muted); font-weight: 400; }
    .field-error { color: var(--pi-danger); }
  `];
}

export function suggestedMachineNameFromUrl(value: string): string {
  const raw = value.trim();
  if (raw === "") return "";
  const parsed = parseUrlForSuggestion(raw) ?? parseUrlForSuggestion(`http://${raw.replace(/^\/+/u, "")}`);
  if (parsed !== undefined && parsed.hostname !== "") return parsed.hostname.replace(/^\[(.*)\]$/u, "$1");
  return fallbackSuggestedName(raw);
}

export function machineBaseUrlValidationMessage(value: string): string | undefined {
  const raw = value.trim();
  if (raw === "") return "Remote PI WEB URL is required.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Enter a valid URL including http:// or https://.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Use an http:// or https:// URL.";
  if (url.username !== "" || url.password !== "") return "Do not include credentials in the machine URL.";
  if (url.search !== "" || url.hash !== "") return "Do not include a query string or fragment.";
  return undefined;
}

function parseUrlForSuggestion(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function fallbackSuggestedName(value: string): string {
  const withoutProtocol = value.replace(/^[a-z][a-z\d+.-]*:\/\//iu, "");
  const withoutCredentials = withoutProtocol.slice(withoutProtocol.lastIndexOf("@") + 1);
  const host = withoutCredentials.split(/[/?#]/u)[0] ?? "";
  if (host.startsWith("[") && host.includes("]")) return host.slice(1, host.indexOf("]"));
  return host.replace(/:\d+$/u, "");
}
