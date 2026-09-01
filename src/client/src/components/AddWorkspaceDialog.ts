import { LitElement, css, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { api, type FileSuggestion } from "../api";
import "./ModalSurface";

/** Directory browser plus workspace name; the owning provider decides what the name means. */
@customElement("add-workspace-dialog")
export class AddWorkspaceDialog extends LitElement {
  @property({ attribute: false }) onSubmit?: (parentPath: string, name: string) => void;
  @property({ attribute: false }) onCancel?: () => void;
  @property() machineId = "local";
  /** Registered project path; its parent folder is where the browser opens. */
  @property() projectPath = "";
  @property({ type: Boolean }) busy = false;
  @property() error = "";
  @state() private location = "";
  @state() private entries: FileSuggestion[] = [];
  @state() private loading = false;
  @state() private browseError = "";
  @state() private name = "";
  @query("input.name") private nameInput?: HTMLInputElement;

  private browseRequestId = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    this.browse(parentDirectory(this.projectPath));
  }

  private browse(path: string): void {
    this.location = path;
    void this.loadEntries();
  }

  private async loadEntries(): Promise<void> {
    const requestId = ++this.browseRequestId;
    this.loading = true;
    this.browseError = "";
    try {
      const entries = await api.projectDirectories(`${trimTrailingSlash(this.location)}/`, this.machineId);
      if (requestId !== this.browseRequestId) return;
      this.entries = entries;
    } catch (error) {
      if (requestId !== this.browseRequestId) return;
      this.entries = [];
      this.browseError = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestId === this.browseRequestId) this.loading = false;
    }
  }

  private submit(): void {
    if (!this.canSubmit()) return;
    this.onSubmit?.(trimTrailingSlash(this.location), this.name.trim());
  }

  private canSubmit(): boolean {
    return !this.busy && this.name.trim() !== "" && this.location !== "";
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.target !== this.nameInput || event.key !== "Enter") return;
    event.preventDefault();
    this.submit();
  }

  override render() {
    const parent = parentDirectory(this.location);
    return html`
      <modal-surface
        .onClose=${() => this.onCancel?.()}
        .initialFocus=${"input.name"}
        .label=${"Add workspace"}
        @keydown=${(event: KeyboardEvent) => { this.onKeyDown(event); }}
      >
        <header>
          <strong>Add workspace</strong>
          <button @click=${() => { this.onCancel?.(); }} aria-label="Close">×</button>
        </header>
        <div class="body">
          <label>
            Create in
            <output class="location">${this.location}</output>
          </label>
          <div class="browser" role="listbox" aria-label="Folders">
            ${parent === this.location ? null : html`
              <button role="option" aria-selected="false" @click=${() => { this.browse(parent); }}>../</button>
            `}
            ${this.loading ? html`<div class="hint">Loading folders…</div>` : null}
            ${this.entries.map((entry) => html`
              <button role="option" aria-selected="false" @click=${() => { this.browse(trimTrailingSlash(entry.path)); }}>
                ${basename(entry.path)}/
              </button>
            `)}
            ${!this.loading && this.entries.length === 0 && this.browseError === "" ? html`<div class="hint">No folders here.</div>` : null}
            ${this.browseError === "" ? null : html`<div class="hint error">${this.browseError}</div>`}
          </div>
          <label>
            Workspace name
            <input
              class="name"
              .value=${this.name}
              placeholder="feature-name"
              @input=${(event: InputEvent) => { if (event.target instanceof HTMLInputElement) this.name = event.target.value; }}
            />
          </label>
          ${this.error === "" ? null : html`<div class="error">${this.error}</div>`}
        </div>
        <footer>
          <button @click=${() => { this.onCancel?.(); }}>Cancel</button>
          <button class="primary" ?disabled=${!this.canSubmit()} @click=${() => { this.submit(); }}>
            ${this.busy ? "Creating…" : "Create workspace"}
          </button>
        </footer>
      </modal-surface>
    `;
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 30; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    modal-surface { --modal-surface-place-items: start center; --modal-surface-backdrop-padding: min(12vh, 90px) 0 0; --modal-surface-width: min(720px, calc(100vw - 40px)); --modal-surface-max-height: min(700px, calc(100vh - 40px)); }
    header, footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px; border-bottom: 1px solid var(--pi-border); }
    footer { border-top: 1px solid var(--pi-border); border-bottom: 0; justify-content: end; }
    .body { display: grid; gap: 12px; padding: 12px; min-height: 0; }
    label { display: grid; gap: 6px; color: var(--pi-muted); }
    .location { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-text); font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    input { box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-bg); color: var(--pi-text); padding: 9px; font: var(--pi-control-font-size, 16px) var(--pi-control-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
    .browser { min-height: 90px; max-height: 320px; overflow: auto; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); }
    .browser button { display: block; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 0; border-bottom: 1px solid var(--pi-border); border-radius: 0; background: transparent; color: var(--pi-text); padding: 8px 10px; text-align: left; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .browser button:hover { background: var(--pi-selection-bg); }
    .hint { padding: 12px; color: var(--pi-muted); }
    .error { color: var(--pi-danger, #c0392b); }
    button { border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
    header button { border: 0; background: transparent; color: var(--pi-muted); font-size: 22px; padding: 0 8px; }
    .primary { border-color: var(--pi-success-border); background: var(--pi-success-border); }
    button:disabled { opacity: .5; cursor: not-allowed; }
  `;
}

function trimTrailingSlash(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed === "" ? "/" : trimmed;
}

function parentDirectory(path: string): string {
  const trimmed = trimTrailingSlash(path);
  const separator = trimmed.lastIndexOf("/");
  if (separator <= 0) return "/";
  return trimmed.slice(0, separator);
}

function basename(path: string): string {
  const trimmed = trimTrailingSlash(path);
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}
