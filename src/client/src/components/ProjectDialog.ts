import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { api, trustApi, type FileSuggestion } from "../api";
import type { ProjectTrustChoice } from "../controllers/projectController";
import { css } from "lit";
import "./ModalSurface";
import { uiDialogStyles, uiFormStyles, uiSelectionStyles } from "./ui/dialogStyles";

/** Server-resolved trust state for the entered path, keyed on the decided path. */
interface ProjectTrustState {
  path: string;
  decision: boolean | null;
  trusted: boolean;
  loading: boolean;
  error?: string;
}

@customElement("project-dialog")
export class ProjectDialog extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) onSubmit?: (path: string, create: boolean, trust: ProjectTrustChoice | undefined) => void;
  @property({ attribute: false }) onCancel?: () => void;
  @property() machineId = "local";
  @state() private path = "";
  @state() private createMissing = true;
  @state() private suggestions: FileSuggestion[] = [];
  @state() private selected = 0;
  @state() private loading = false;
  @state() private suggestionError = false;
  @state() private trust: ProjectTrustState | undefined;
  @state() private trustTouched = false;
  @query("input") private pathInput?: HTMLInputElement;

  // Separate staleness counters: setPath fires both loaders, so a shared one
  // would make the trust read invalidate every in-flight suggestions request
  // (leaving "Loading folders…" up forever).
  private suggestionRequestId = 0;
  private trustRequestId = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.loadSuggestions();
  }

  private async loadSuggestions() {
    const requestId = ++this.suggestionRequestId;
    this.loading = true;
    this.suggestionError = false;
    this.suggestions = [];
    try {
      const suggestions = await api.projectDirectories(this.path, this.machineId);
      if (requestId !== this.suggestionRequestId) return;
      this.suggestions = suggestions;
      this.selected = Math.min(this.selected, Math.max(0, suggestions.length - 1));
    } catch {
      if (requestId === this.suggestionRequestId) this.suggestionError = true;
    } finally {
      if (requestId === this.suggestionRequestId) this.loading = false;
    }
  }

  private setPath(value: string) {
    this.path = value;
    this.selected = 0;
    this.trustTouched = false;
    void this.loadSuggestions();
    void this.loadTrust();
  }

  private pick(suggestion: FileSuggestion) {
    this.setPath(suggestion.path);
  }

  private submit() {
    if (this.path.trim() === "") return;
    this.onSubmit?.(this.path, this.createMissing, this.trust === undefined ? undefined : { trusted: this.trust.trusted, changed: this.trustTouched });
  }

  private onPathInput(event: InputEvent) {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.setPath(event.target.value);
  }

  private onCreateMissingChange(event: InputEvent) {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.createMissing = event.target.checked;
  }

  /**
   * Server-resolved existing trust for the entered path (never the raw path
   * trusted verbatim). Dropped when a newer path input or an explicit user
   * toggle supersedes it, so a stale read can not clobber the user's choice.
   */
  private async loadTrust() {
    const requestId = ++this.trustRequestId;
    const trimmed = this.path.trim();
    if (trimmed === "") {
      if (requestId === this.trustRequestId) this.trust = undefined;
      return;
    }
    if (requestId === this.trustRequestId) {
      // Keep the previous value visible (cosmetic continuity) while the read
      // for the new path is in flight; the result replaces it either way.
      this.trust = {
        path: trimmed,
        decision: this.trust?.decision ?? null,
        trusted: this.trust?.trusted ?? false,
        loading: true,
      };
    }
    try {
      const result = await trustApi.projectTrust(trimmed, this.machineId);
      if (requestId !== this.trustRequestId || this.trustTouched) return;
      this.trust = { path: result.path, decision: result.decision, trusted: result.trusted, loading: false };
    } catch (error) {
      if (requestId !== this.trustRequestId || this.trustTouched) return;
      this.trust = { path: trimmed, decision: null, trusted: false, loading: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private onTrustChange(checked: boolean) {
    this.trustTouched = true;
    if (this.trust !== undefined) this.trust = { ...this.trust, trusted: checked, loading: false };
  }

  private renderTrustChoice() {
    const unavailable = this.trust === undefined || this.trust.loading || this.trust.error !== undefined;
    return html`
      <label class="check ui-checkbox-field">
        <input type="checkbox" aria-describedby=${this.trust?.error === undefined ? "project-trust-help" : "project-trust-help project-trust-error"} .checked=${this.trust?.trusted ?? false} ?disabled=${unavailable} @change=${(event: InputEvent) => { if (event.target instanceof HTMLInputElement) this.onTrustChange(event.target.checked); }} />
        <span>Trust this project</span>
      </label>
      <small id="project-trust-help" class="trust-hint">
        Trusting lets pi load this project's .pi settings, extensions, skills, and packages.
        Extensions and packages can execute code on this machine. Only trust projects you know and trust.
        <a href="https://pi.dev/docs/latest/security" target="_blank" rel="noreferrer">Learn about project trust</a>
      </small>
      ${this.trust?.error === undefined ? null : html`
        <small id="project-trust-error" class="trust-error ui-form-error" role="alert">Could not check project trust: ${this.trust.error}. Retry to load the existing trust decision.</small>
        <button class="ui-button" type="button" @click=${() => { void this.loadTrust(); }}>Retry trust check</button>
      `}
    `;
  }

  // Escape and backdrop presses are owned by the modal surface (routed to
  // `onCancel`). The remaining keys stay scoped to the path input — their home
  // before the migration — so Enter/Tab on the footer buttons and checkbox keep
  // their native behavior.
  private onKeyDown(event: KeyboardEvent) {
    if (event.target !== this.pathInput) return;
    if (event.key === "Enter") {
      event.preventDefault();
      this.submit();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      this.selected = Math.min(this.selected + 1, Math.max(0, this.suggestions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.selected = Math.max(0, this.selected - 1);
    } else if (event.key === "Tab") {
      const suggestion = this.suggestions[this.selected];
      if (suggestion === undefined) return;
      event.preventDefault();
      this.pick(suggestion);
    }
  }

  override render() {
    return html`
      <modal-surface
        .onClose=${() => this.onCancel?.()}
        .initialFocus=${"input"}
        .label=${"Add project"}
        @keydown=${(event: KeyboardEvent) => { this.onKeyDown(event); }}
      >
        <form class="ui-form" @submit=${(event: SubmitEvent) => { event.preventDefault(); }}>
        <header class="ui-dialog-header">
          <strong class="ui-dialog-title">Add project</strong>
          <button class="ui-button ui-button--icon" type="button" @click=${() => { this.onCancel?.(); }} aria-label="Close add project">×</button>
        </header>
        <div class="body ui-dialog-body ui-form-body">
          <small id="project-machine-help" class="machine-hint">${this.machineId === "local" ? "Folders on the local machine (where PI WEB runs)." : `Folders on remote machine: ${this.machineId}.`} Paths are on this machine, not your browser's device.</small>
          <label class="ui-form-field">
            Project folder
            <input class="ui-input" aria-describedby=${this.suggestionError ? "project-machine-help project-folder-error" : "project-machine-help project-folder-status"} .value=${this.path} @input=${(event: InputEvent) => { this.onPathInput(event); }} placeholder="/path/to/project or ~/code/project" />
          </label>
          ${this.suggestionError ? html`
            <div id="project-folder-error" class="trust-error ui-form-error" role="alert">Could not load folders on this machine. Check the connection and retry, or enter a folder path.</div>
            <button class="ui-button" type="button" @click=${() => { void this.loadSuggestions(); }}>Retry folder lookup</button>
          ` : null}
          <div id="project-folder-status" class="suggestions ui-selection-list" aria-live="polite">
            ${this.loading ? html`<div class="hint">Loading folders…</div>` : null}
            ${this.suggestions.map((suggestion, index) => html`
              <button type="button" class=${`ui-button ui-selection-option ${index === this.selected ? "selected" : ""}`} @click=${() => { this.pick(suggestion); }}>
                ${suggestion.path}
              </button>
            `)}
            ${!this.loading && !this.suggestionError && this.suggestions.length === 0 ? html`<div class="hint">No matching folders. Enter a new path to create it.</div>` : null}
          </div>
          <label class="check ui-checkbox-field">
            <input type="checkbox" .checked=${this.createMissing} @change=${(event: InputEvent) => { this.onCreateMissingChange(event); }} />
            Create the folder if it does not exist
          </label>
          ${this.renderTrustChoice()}
        </div>
        <footer class="ui-dialog-footer">
          <button class="ui-button" type="button" @click=${() => { this.onCancel?.(); }}>Cancel</button>
          <button class="ui-button ui-button--primary" type="button" ?disabled=${this.path.trim() === ""} @click=${() => { this.submit(); }}>Add project</button>
        </footer>
        </form>
      </modal-surface>
    `;
  }

  static override styles = [uiDialogStyles, uiFormStyles, uiSelectionStyles, css`
    :host { --ui-dialog-max-height: 700px; --ui-input-font-family: var(--pi-control-monospace-font-family, var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)); }
    .suggestions { min-height: 90px; max-height: 320px; }
    .suggestions button { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 13px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
    .hint { padding: 12px; color: var(--pi-muted); }
    .trust-error { color: var(--pi-danger, #c0392b); }
    .trust-hint, .machine-hint { color: var(--pi-muted); line-height: 1.3; }
    .trust-hint a { color: var(--pi-accent); }
  `];
}
