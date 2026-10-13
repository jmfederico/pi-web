import { LitElement, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { api, trustApi, type FileSuggestion } from "../api";
import type { ProjectTrustChoice } from "../controllers/projectController";
import { css } from "lit";
import "./ModalSurface";

/** Server-resolved trust state for the entered path, keyed on the decided path. */
interface ProjectTrustState {
  path: string;
  decision: boolean | null;
  trusted: boolean;
  loading: boolean;
  error?: string;
}

export interface ProjectCloneSubmission {
  repositoryUrl: string;
  destinationPath: string;
  trust: ProjectTrustChoice | undefined;
  signal: AbortSignal;
}

@customElement("project-dialog")
export class ProjectDialog extends LitElement {
  @property({ attribute: false }) onSubmit?: (path: string, create: boolean, trust: ProjectTrustChoice | undefined) => void;
  @property({ attribute: false }) onClone?: (submission: ProjectCloneSubmission) => void | Promise<void>;
  @property({ attribute: false }) onCancel?: () => void;
  @property() machineId = "local";
  @state() private path = "";
  @state() private mode: "folder" | "git" = "folder";
  @state() private repositoryUrl = "";
  @state() private cloneParent = "~/projs";
  @state() private cloneFolderName = "";
  @state() private cloneFolderNameTouched = false;
  @state() private cloning = false;
  @state() private cloneError = "";
  @state() private createMissing = true;
  @state() private suggestions: FileSuggestion[] = [];
  @state() private selected = 0;
  @state() private loading = false;
  @state() private trust: ProjectTrustState | undefined;
  @state() private trustTouched = false;
  @query("input.directory-input") private directoryInput?: HTMLInputElement;
  private cloneAbortController: AbortController | undefined;

  // Separate staleness counters: setPath fires both loaders, so a shared one
  // would make the trust read invalidate every in-flight suggestions request
  // (leaving "Loading folders…" up forever).
  private suggestionRequestId = 0;
  private trustRequestId = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.loadSuggestions();
  }

  override disconnectedCallback(): void {
    this.cloneAbortController?.abort();
    super.disconnectedCallback();
  }

  private async loadSuggestions(query = this.mode === "git" ? this.cloneParent : this.path) {
    const requestId = ++this.suggestionRequestId;
    this.loading = true;
    try {
      const suggestions = await api.projectDirectories(query, this.machineId);
      if (requestId !== this.suggestionRequestId) return;
      this.suggestions = suggestions;
      this.selected = Math.min(this.selected, Math.max(0, suggestions.length - 1));
    } catch {
      if (requestId === this.suggestionRequestId) this.suggestions = [];
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

  private setCloneParent(value: string) {
    this.cloneParent = value;
    this.selected = 0;
    this.trustTouched = false;
    void this.loadSuggestions(value);
    void this.loadTrust();
  }

  private selectMode(mode: "folder" | "git") {
    if (this.mode === mode) return;
    this.mode = mode;
    this.cloneError = "";
    this.selected = 0;
    void this.loadSuggestions();
    void this.loadTrust();
  }

  private pick(suggestion: FileSuggestion) {
    if (this.mode === "git") this.setCloneParent(suggestion.path);
    else this.setPath(suggestion.path);
  }

  private submit() {
    if (this.cloning) return;
    if (this.mode === "git") {
      void this.submitGitClone();
      return;
    }
    if (this.path.trim() === "") return;
    this.onSubmit?.(this.path, this.createMissing, this.trustChoice());
  }

  private onPathInput(event: InputEvent) {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.setPath(event.target.value);
  }

  private onCreateMissingChange(event: InputEvent) {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.createMissing = event.target.checked;
  }

  private onRepositoryUrlInput(event: InputEvent) {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.repositoryUrl = event.target.value;
    if (!this.cloneFolderNameTouched) this.cloneFolderName = suggestedProjectFolderName(this.repositoryUrl);
    this.trustTouched = false;
    void this.loadTrust();
  }

  private onCloneFolderNameInput(event: InputEvent) {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.cloneFolderNameTouched = true;
    this.cloneFolderName = event.target.value;
    this.trustTouched = false;
    void this.loadTrust();
  }

  private async submitGitClone() {
    const destinationPath = projectCloneDestination(this.cloneParent, this.cloneFolderName);
    if (this.repositoryUrl.trim() === "" || destinationPath === "") return;
    const controller = new AbortController();
    this.cloneAbortController = controller;
    this.cloning = true;
    this.cloneError = "";
    try {
      await this.onClone?.({
        repositoryUrl: this.repositoryUrl,
        destinationPath,
        trust: this.trustChoice(),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (!controller.signal.aborted) this.cloneError = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.cloneAbortController === controller) this.cloneAbortController = undefined;
      this.cloning = false;
    }
  }

  private trustChoice(): ProjectTrustChoice | undefined {
    return this.trust === undefined ? undefined : { trusted: this.trust.trusted, changed: this.trustTouched };
  }

  private get trustPath(): string {
    return this.mode === "git" ? projectCloneDestination(this.cloneParent, this.cloneFolderName) : this.path;
  }

  private cancel() {
    this.cloneAbortController?.abort();
    this.onCancel?.();
  }

  /**
   * Server-resolved existing trust for the entered path (never the raw path
   * trusted verbatim). Dropped when a newer path input or an explicit user
   * toggle supersedes it, so a stale read can not clobber the user's choice.
   */
  private async loadTrust() {
    const requestId = ++this.trustRequestId;
    const trimmed = this.trustPath.trim();
    if (trimmed === "") {
      if (requestId === this.trustRequestId) this.trust = undefined;
      return;
    }
    if (requestId === this.trustRequestId) {
      // Keep the previous value visible (cosmetic continuity) while the read
      // for the new path is in flight; the result replaces it either way.
      this.trust = {
        ...(this.trust ?? { path: trimmed, decision: null, trusted: false }),
        path: trimmed,
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
      <label class="check">
        <input type="checkbox" .checked=${this.trust?.trusted ?? false} ?disabled=${unavailable} @change=${(event: InputEvent) => { if (event.target instanceof HTMLInputElement) this.onTrustChange(event.target.checked); }} />
        <span>Trust this project</span>
      </label>
      <small class="trust-hint">
        Trusting lets pi load this project's .pi settings, extensions, skills, and packages.
        <a href="https://pi.dev/docs/latest/security" target="_blank" rel="noreferrer">Learn about project trust</a>
      </small>
      ${this.trust?.error === undefined ? null : html`<small class="trust-error">Trust state unavailable: ${this.trust.error}</small>`}
    `;
  }

  // Escape and backdrop presses are owned by the modal surface (routed to
  // `onCancel`). The remaining keys stay scoped to the path input — their home
  // before the migration — so Enter/Tab on the footer buttons and checkbox keep
  // their native behavior.
  private onKeyDown(event: KeyboardEvent) {
    if (event.target !== this.directoryInput) {
      if (this.mode === "git" && event.target instanceof HTMLInputElement && event.key === "Enter") {
        event.preventDefault();
        this.submit();
      }
      return;
    }
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
    const cloneDestination = projectCloneDestination(this.cloneParent, this.cloneFolderName);
    return html`
      <modal-surface
        .onClose=${() => this.cancel()}
        .initialFocus=${"input"}
        .label=${"Add project"}
        .busy=${this.cloning}
        .onBusyEscape=${() => { this.cancel(); }}
        @keydown=${(event: KeyboardEvent) => { this.onKeyDown(event); }}
      >
        <header>
          <strong>Add project</strong>
          <button ?disabled=${this.cloning} @click=${() => { this.cancel(); }} aria-label="Close">×</button>
        </header>
        <div class="body">
          <div class="mode-toggle" role="group" aria-label="Add project from">
            <button ?disabled=${this.cloning} aria-pressed=${this.mode === "folder" ? "true" : "false"} @click=${() => { this.selectMode("folder"); }}>Existing folder</button>
            <button ?disabled=${this.cloning} aria-pressed=${this.mode === "git" ? "true" : "false"} @click=${() => { this.selectMode("git"); }}>Clone from Git</button>
          </div>
          ${this.mode === "folder" ? html`
            <label>
              Project folder
              <input class="directory-input" .value=${this.path} @input=${(event: InputEvent) => { this.onPathInput(event); }} placeholder="/path/to/project or ~/code/project" />
            </label>
          ` : html`
            <label>
              Git repository URL
              <input type="url" .value=${this.repositoryUrl} @input=${(event: InputEvent) => { this.onRepositoryUrlInput(event); }} placeholder="https://git.example.com/group/repo.git or git@host:group/repo.git" />
            </label>
            <label>
              Parent folder
              <input class="directory-input" .value=${this.cloneParent} @input=${(event: InputEvent) => { this.setCloneParent((event.target as HTMLInputElement).value); }} placeholder="~/projs" />
            </label>
            <label>
              Project folder name
              <input .value=${this.cloneFolderName} @input=${(event: InputEvent) => { this.onCloneFolderNameInput(event); }} placeholder="project-name" />
            </label>
            <div class="clone-destination">Clones into <code>${cloneDestination || "Choose a parent folder and project name"}</code></div>
            ${this.cloning ? html`<div class="clone-progress" role="status">Cloning repository on the selected machine…</div>` : null}
            ${this.cloneError === "" ? null : html`<div class="clone-error" role="alert">${this.cloneError}</div>`}
          `}
          <div class="suggestions">
            ${this.loading ? html`<div class="hint">Loading folders…</div>` : null}
            ${this.suggestions.map((suggestion, index) => html`
              <button class=${index === this.selected ? "selected" : ""} @click=${() => { this.pick(suggestion); }}>
                ${suggestion.path}
              </button>
            `)}
            ${!this.loading && this.suggestions.length === 0 ? html`<div class="hint">No matching folders. Enter a new path to create it.</div>` : null}
          </div>
          ${this.mode === "folder" ? html`<label class="check">
            <input type="checkbox" .checked=${this.createMissing} @change=${(event: InputEvent) => { this.onCreateMissingChange(event); }} />
            Create the folder if it does not exist
          </label>` : null}
          ${this.renderTrustChoice()}
        </div>
        <footer>
          <button @click=${() => { this.cancel(); }}>${this.cloning ? "Cancel clone" : "Cancel"}</button>
          <button class="primary" ?disabled=${this.mode === "folder" ? this.path.trim() === "" : this.repositoryUrl.trim() === "" || cloneDestination === "" || this.cloning} @click=${() => { this.submit(); }}>${this.cloning ? "Cloning…" : this.mode === "git" ? "Clone project" : "Add project"}</button>
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
    .mode-toggle { display: flex; gap: 6px; }
    .mode-toggle button[aria-pressed="true"] { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    label { display: grid; gap: 6px; color: var(--pi-muted); }
    input[type="text"], input[type="url"], input:not([type]) { box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); padding: 9px; font: var(--pi-control-font-size, 16px) var(--pi-control-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
    .check { display: flex; grid-template-columns: auto 1fr; align-items: center; color: var(--pi-text); }
    .suggestions { min-height: 90px; max-height: 320px; overflow: auto; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); }
    .suggestions button { display: block; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 0; border-bottom: 1px solid var(--pi-border); border-radius: 0; background: transparent; color: var(--pi-text); padding: 8px 10px; text-align: left; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .suggestions button.selected, .suggestions button:hover { background: var(--pi-selection-bg); }
    .hint { padding: 12px; color: var(--pi-muted); }
    .clone-destination, .clone-progress { color: var(--pi-muted); }
    .clone-destination code { color: var(--pi-text); }
    .clone-error { color: var(--pi-danger, #c0392b); overflow-wrap: anywhere; }
    .trust-error { color: var(--pi-danger, #c0392b); }
    .trust-hint { color: var(--pi-muted); line-height: 1.3; }
    .trust-hint a { color: var(--pi-accent); }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
    header button { border: 0; background: transparent; color: var(--pi-muted); font-size: 22px; padding: 0 8px; }
    .primary { border-color: var(--pi-success-border); background: var(--pi-success-border); }
    button:disabled { opacity: .5; cursor: not-allowed; }
  `;
}

function suggestedProjectFolderName(repositoryUrl: string): string {
  const withoutTrailingSlash = repositoryUrl.trim().replace(/[\\/]+$/u, "").split(/[?#]/u, 1)[0] ?? "";
  const leaf = withoutTrailingSlash.slice(Math.max(withoutTrailingSlash.lastIndexOf("/"), withoutTrailingSlash.lastIndexOf(":")) + 1);
  let decoded = leaf;
  try {
    decoded = decodeURIComponent(leaf);
  } catch {
    // Keep the literal URL segment when it contains an incomplete escape.
  }
  const name = decoded.replace(/\.git$/iu, "");
  return name === "." || name === ".." || /[\\/\0]/u.test(name) ? "" : name;
}

function projectCloneDestination(parentPath: string, folderName: string): string {
  const trimmedParent = parentPath.trim();
  const parent = trimmedParent === "/" || /^[A-Za-z]:\\?$/u.test(trimmedParent) ? trimmedParent.replace(/\\$/u, "") : trimmedParent.replace(/[\\/]+$/u, "");
  const name = folderName.trim();
  if (parent === "" || name === "" || name === "." || name === ".." || /[\\/\0]/u.test(name)) return "";
  if (parent === "/") return `/${name}`;
  return `${parent}/${name}`;
}
