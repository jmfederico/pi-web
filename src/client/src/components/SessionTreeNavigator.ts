import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionTreeForkResult, SessionTreeNavigateResult, SessionTreeNodeKind, SessionTreeSnapshot, SessionTreeSummaryChoice } from "../api";
import { SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH } from "../../../shared/apiTypes";
import { buildSessionTreeModel, initialSessionTreeSelection, toggleSessionTreeFold, transitionSessionTreeKey, validateSessionTreeSummaryChoice, visibleSessionTreeRows, type SessionTreeModel, type SessionTreeRow } from "../sessionTreeModel";
// Side-effect import: registers <modal-surface> (a value import would be dropped
// by esbuild under vitest because nothing from the module is referenced).
import "./ModalSurface";

const EMPTY_TREE: SessionTreeSnapshot = { nodes: [], activeLeafId: null, activePathIds: [] };
const MAX_SESSION_TREE_VISUAL_DEPTH = 8;
type NavigatorStep = "tree" | "action";
type NavigatorOperation = "continue" | "fork";
type PendingFocus = "tree" | "operation" | "summary" | "custom";

export type SessionTreeKindTone = "user" | "assistant" | "tool" | "shell" | "context" | "metadata";

export interface SessionTreeKindPresentation {
  readonly label: string;
  readonly tone: SessionTreeKindTone;
  readonly bookkeeping: boolean;
}

const SESSION_TREE_KIND_PRESENTATION = {
  user: { label: "User", tone: "user", bookkeeping: false },
  assistant: { label: "Assistant", tone: "assistant", bookkeeping: false },
  "tool-result": { label: "Tool result", tone: "tool", bookkeeping: false },
  bash: { label: "Shell", tone: "shell", bookkeeping: false },
  "custom-message": { label: "Custom message", tone: "context", bookkeeping: false },
  compaction: { label: "Compaction", tone: "context", bookkeeping: false },
  "branch-summary": { label: "Branch summary", tone: "context", bookkeeping: false },
  "model-change": { label: "Model", tone: "metadata", bookkeeping: true },
  "thinking-level-change": { label: "Thinking", tone: "metadata", bookkeeping: true },
  "session-info": { label: "Session info", tone: "metadata", bookkeeping: true },
  label: { label: "Label", tone: "metadata", bookkeeping: true },
  custom: { label: "Custom", tone: "metadata", bookkeeping: true },
  other: { label: "Other", tone: "metadata", bookkeeping: true },
} as const satisfies Record<SessionTreeNodeKind, SessionTreeKindPresentation>;

@customElement("session-tree-navigator")
export class SessionTreeNavigator extends LitElement {
  @property({ attribute: false }) tree: SessionTreeSnapshot = EMPTY_TREE;
  @property({ attribute: false }) onNavigate?: (targetId: string, summaryChoice: SessionTreeSummaryChoice) => Promise<SessionTreeNavigateResult>;
  @property({ attribute: false }) onFork?: (entryId: string) => Promise<SessionTreeForkResult>;
  @property({ attribute: false }) onAbort?: () => Promise<void>;
  @property({ attribute: false }) onCancel?: () => void;

  @state() private selectedId: string | undefined;
  @state() private foldedIds: ReadonlySet<string> = new Set();
  @state() private step: NavigatorStep = "tree";
  @state() private operation: NavigatorOperation = "continue";
  @state() private summaryMode: SessionTreeSummaryChoice["mode"] = "none";
  @state() private customInstructions = "";
  @state() private busy = false;
  @state() private aborting = false;
  @state() private error = "";
  @state() private statusMessage = "";

  private model: SessionTreeModel = buildSessionTreeModel(EMPTY_TREE);
  private pendingFocus: PendingFocus | undefined;
  private operationGeneration = 0;

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has("tree")) this.resetTree();
  }

  protected override updated(): void {
    const pendingFocus = this.pendingFocus;
    if (pendingFocus === undefined) return;
    this.pendingFocus = undefined;
    if (pendingFocus === "tree") this.focusSelectedTreeItem();
    else if (pendingFocus === "custom") this.renderRoot.querySelector<HTMLTextAreaElement>("#session-tree-custom-focus")?.focus();
    else if (pendingFocus === "operation") this.renderRoot.querySelector<HTMLInputElement>("input[name='session-tree-operation']:checked")?.focus();
    else this.renderRoot.querySelector<HTMLInputElement>("input[name='session-tree-summary']:checked")?.focus();
  }

  override render(): TemplateResult {
    return html`
      <modal-surface
        .label=${"Navigate session tree"}
        .initialFocus=${this.selectedId === undefined ? ".close-button" : "[data-tree-node-id][tabindex='0']"}
        ?busy=${this.busy}
        .onClose=${() => { this.requestDismissal(); }}
        .onBusyEscape=${() => { this.requestBusyEscape(); }}
      >
        <header>
          <div>
            <span class="eyebrow">Conversation history</span>
            <h1>Navigate session tree</h1>
          </div>
          <button class="close-button" ?disabled=${this.busy} title="Close session tree" aria-label="Close session tree" @click=${() => { this.onCancel?.(); }}>×</button>
        </header>
        ${this.step === "tree" ? this.renderTreeStep() : this.renderActionStep()}
        ${this.renderFooter()}
      </modal-surface>
    `;
  }

  private renderTreeStep(): TemplateResult {
    const rows = visibleSessionTreeRows(this.model, this.foldedIds);
    return html`
      <div class="body tree-step">
        <div class="tree-intro">
          <p>Select the history entry where you would like to continue.</p>
          <div class="legend" aria-label="Session tree markers">
            <span><span class="marker active-path-marker" aria-hidden="true"></span>Active path</span>
            <span><span class="marker active-leaf-marker" aria-hidden="true"></span>Active leaf</span>
          </div>
        </div>
        ${this.statusMessage === "" ? null : html`<div class="dialog-status" role="status">${this.statusMessage}</div>`}
        ${this.error === "" ? null : html`<div class="dialog-error" role="alert">${this.error}</div>`}
        ${rows.length === 0 ? html`
          <div class="empty" role="status">This session does not contain any selectable history entries.</div>
        ` : html`
          <div class="tree" role="tree" aria-label="Complete session history">
            ${rows.map((row) => this.renderTreeRow(row))}
          </div>
        `}
      </div>
    `;
  }

  private renderTreeRow(row: SessionTreeRow): TemplateResult {
    const selected = row.node.id === this.selectedId;
    const expanded = row.childIds.length > 0 && !this.foldedIds.has(row.node.id);
    const kindPresentation = sessionTreeKindPresentation(row.node.kind);
    const classes = [
      "tree-row",
      selected ? "selected" : "",
      row.activePath ? "active-path" : "",
      row.activeLeaf ? "active-leaf" : "",
      kindPresentation.bookkeeping ? "bookkeeping" : "",
    ].filter((value) => value !== "").join(" ");
    const visualDepth = sessionTreeVisualDepth(row.branchDepth);
    return html`
      <div
        class=${classes}
        style=${`--tree-indent: ${String(visualDepth * 16)}px; --tree-indent-mobile: ${String(visualDepth * 12)}px;`}
        role="treeitem"
        aria-level=${String(row.depth + 1)}
        aria-selected=${selected ? "true" : "false"}
        aria-expanded=${row.childIds.length === 0 ? nothing : expanded ? "true" : "false"}
        aria-current=${row.activeLeaf ? "true" : nothing}
        tabindex=${selected ? "0" : "-1"}
        data-tree-node-id=${row.node.id}
        @click=${() => { this.selectNode(row.node.id); }}
        @keydown=${(event: KeyboardEvent) => { this.handleTreeKeyDown(event); }}
      >
        <span
          class=${`disclosure${row.childIds.length === 0 ? " leaf" : ""}`}
          title=${row.childIds.length === 0 ? "No child entries" : expanded ? "Collapse branch" : "Expand branch"}
          aria-hidden="true"
          @click=${(event: MouseEvent) => { this.toggleNode(row.node.id, event); }}
        >${row.childIds.length === 0 ? "·" : expanded ? "▾" : "▸"}</span>
        <span class="metadata">
          ${this.renderKindBadge(kindPresentation)}
          <span class="badges">
            ${row.activePath && !row.activeLeaf ? html`<span class="badge path">Active path</span>` : null}
            ${row.activeLeaf ? html`<span class="badge leaf">Active leaf</span>` : null}
          </span>
        </span>
        <span class="entry">
          <span class="summary" dir="auto">${row.node.summary}</span>
          ${row.node.label === undefined ? null : html`<span class="label" title=${row.node.label}>${row.node.label}</span>`}
          ${row.node.timestamp === undefined ? null : html`<time datetime=${row.node.timestamp}>${row.node.timestamp}</time>`}
        </span>
      </div>
    `;
  }

  private renderKindBadge(presentation: SessionTreeKindPresentation): TemplateResult {
    return html`<span class=${`kind kind-tone-${presentation.tone}`}>${presentation.label}</span>`;
  }

  private renderActionStep(): TemplateResult {
    const selectedNode = this.selectedId === undefined ? undefined : this.model.nodesById.get(this.selectedId);
    const validation = validateSessionTreeSummaryChoice(this.summaryMode, this.customInstructions);
    return html`
      <div class="body confirmation-step">
        <div class="confirmation-card">
          <div>
            <span class="eyebrow">Selected entry</span>
            <h2>Choose how to continue</h2>
          </div>
          ${selectedNode === undefined ? html`<div class="empty">The selected history entry is no longer available.</div>` : html`
            <div class="selected-entry">
              ${this.renderKindBadge(sessionTreeKindPresentation(selectedNode.kind))}
              <strong dir="auto">${selectedNode.summary}</strong>
              <p>${this.selectedEntryDescription(selectedNode.kind)}</p>
            </div>
          `}
          <fieldset ?disabled=${this.busy}>
            <legend>How would you like to continue?</legend>
            ${this.renderOperationOption("continue", "Continue in this session", "Branch from the selected entry in this session file and keep its other branches.")}
            ${this.renderOperationOption("fork", "Fork into a new session", "Create and switch to a separate session file while leaving the original unchanged.")}
          </fieldset>
          ${this.operation === "continue" ? html`
            <fieldset ?disabled=${this.busy}>
              <legend>Abandoned branch summary</legend>
              ${this.renderSummaryOption("none", "No summary", "Switch branches without adding a summary entry.")}
              ${this.renderSummaryOption("default", "Summarize", "Ask Pi to summarize the context being left behind.")}
              ${this.renderSummaryOption("custom", "Summarize with custom focus", "Guide Pi toward the details that matter for the new branch.")}
              ${this.summaryMode === "custom" ? html`
                <label class="custom-focus" for="session-tree-custom-focus">
                  <span>Custom summary focus</span>
                  <textarea
                    id="session-tree-custom-focus"
                    rows="5"
                    maxlength=${String(SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH)}
                    .value=${this.customInstructions}
                    @input=${(event: InputEvent) => { this.handleCustomInstructionsInput(event); }}
                  ></textarea>
                  <span class="character-count">${this.customInstructions.length} / ${SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH}</span>
                </label>
                ${validation.ok ? null : html`<div class="validation-error" role="alert">${validation.error}</div>`}
              ` : null}
            </fieldset>
          ` : null}
          <div class="side-effects-note" role="note">
            <strong>Conversation context only.</strong> Continuing or forking does not undo filesystem changes, shell commands, tool calls, or other side effects.
          </div>
          ${this.statusMessage === "" ? null : html`<div class="dialog-status" role="status">${this.statusMessage}</div>`}
          ${this.error === "" ? null : html`<div class="dialog-error" role="alert">${this.error}</div>`}
        </div>
      </div>
    `;
  }

  private selectedEntryDescription(kind: SessionTreeNodeKind): string {
    if (this.operation === "fork") {
      return kind === "user"
        ? "The new session will branch before this user message, and its text will return to the prompt editor as the new session draft."
        : "The new session will include this entry and all history leading to it.";
    }
    return sessionTreeEntryReturnsToEditor(kind)
      ? "This message’s text will return to the prompt editor for optional editing and resubmission in this session."
      : "The prompt editor will be empty after continuing from this entry in this session.";
  }

  private renderOperationOption(operation: NavigatorOperation, label: string, description: string): TemplateResult {
    return html`
      <label class=${`choice-option${this.operation === operation ? " selected" : ""}`}>
        <input
          type="radio"
          name="session-tree-operation"
          value=${operation}
          .checked=${this.operation === operation}
          @change=${() => { this.selectOperation(operation); }}
        >
        <span><strong>${label}</strong><small>${description}</small></span>
      </label>
    `;
  }

  private renderSummaryOption(mode: SessionTreeSummaryChoice["mode"], label: string, description: string): TemplateResult {
    return html`
      <label class=${`choice-option${this.summaryMode === mode ? " selected" : ""}`}>
        <input
          type="radio"
          name="session-tree-summary"
          value=${mode}
          .checked=${this.summaryMode === mode}
          @change=${() => { this.selectSummaryMode(mode); }}
        >
        <span><strong>${label}</strong><small>${description}</small></span>
      </label>
    `;
  }

  private renderFooter(): TemplateResult {
    if (this.step === "tree") {
      return html`
        <footer>
          <button @click=${() => { this.onCancel?.(); }}>Cancel</button>
          <span class="footer-spacer"></span>
          <button class="primary" ?disabled=${this.selectedId === undefined} @click=${() => { this.continueToAction(); }}>Next</button>
        </footer>
      `;
    }

    const continuing = this.operation === "continue";
    const summarizing = continuing && this.summaryMode !== "none";
    return html`
      <footer>
        <button ?disabled=${this.busy} @click=${() => { this.returnToTree(); }}>Back</button>
        <span class="footer-spacer"></span>
        ${this.busy && summarizing ? html`
          <button class="danger" ?disabled=${this.aborting} @click=${() => { void this.abortNavigation(); }}>${this.aborting ? "Cancelling…" : "Cancel summarization"}</button>
        ` : null}
        <button class="primary" ?disabled=${this.busy || this.selectedId === undefined} @click=${() => { void this.submitSelectedOperation(); }}>
          ${this.primaryActionLabel()}
        </button>
      </footer>
    `;
  }

  private resetTree(): void {
    this.operationGeneration += 1;
    this.model = buildSessionTreeModel(this.tree);
    this.selectedId = initialSessionTreeSelection(this.model);
    this.foldedIds = new Set();
    this.step = "tree";
    this.operation = "continue";
    this.summaryMode = "none";
    this.customInstructions = "";
    this.busy = false;
    this.aborting = false;
    this.error = "";
    this.statusMessage = "";
    this.pendingFocus = "tree";
  }

  private selectNode(id: string): void {
    if (!this.model.nodesById.has(id)) return;
    this.selectedId = id;
    this.error = "";
    this.statusMessage = "";
    this.pendingFocus = "tree";
  }

  private toggleNode(id: string, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const next = toggleSessionTreeFold(this.model, { selectedId: this.selectedId, foldedIds: this.foldedIds }, id);
    this.selectedId = next.selectedId;
    this.foldedIds = next.foldedIds;
    this.error = "";
    this.statusMessage = "";
    this.pendingFocus = "tree";
  }

  private handleTreeKeyDown(event: KeyboardEvent): void {
    // The modal surface owns Escape everywhere; the pure model still maps it for
    // consumers that drive a tree without the surface.
    if (event.key === "Escape") return;
    const next = transitionSessionTreeKey(this.model, { selectedId: this.selectedId, foldedIds: this.foldedIds }, event.key);
    if (!next.handled) return;
    event.preventDefault();
    event.stopPropagation();
    if (next.action === "confirm") {
      this.continueToAction();
      return;
    }
    this.selectedId = next.selectedId;
    this.foldedIds = next.foldedIds;
    this.pendingFocus = "tree";
  }

  private continueToAction(): void {
    if (this.busy || this.selectedId === undefined || !this.model.nodesById.has(this.selectedId)) return;
    if (!validateSessionTreeSummaryChoice(this.summaryMode, this.customInstructions).ok) {
      this.summaryMode = "none";
      this.customInstructions = "";
    }
    this.step = "action";
    this.error = "";
    this.statusMessage = "";
    this.pendingFocus = "operation";
  }

  private returnToTree(): void {
    if (this.busy) return;
    this.step = "tree";
    this.error = "";
    this.statusMessage = "";
    this.pendingFocus = "tree";
  }

  private selectOperation(operation: NavigatorOperation): void {
    if (this.busy) return;
    this.operation = operation;
    this.error = "";
    this.statusMessage = "";
    this.pendingFocus = "operation";
  }

  private selectSummaryMode(mode: SessionTreeSummaryChoice["mode"]): void {
    if (this.busy) return;
    this.summaryMode = mode;
    this.error = "";
    this.statusMessage = "";
    this.pendingFocus = mode === "custom" ? "custom" : "summary";
  }

  private handleCustomInstructionsInput(event: InputEvent): void {
    if (!(event.currentTarget instanceof HTMLTextAreaElement)) return;
    this.customInstructions = event.currentTarget.value;
    this.error = "";
    this.statusMessage = "";
  }

  private primaryActionLabel(): string {
    if (!this.busy) return this.operation === "continue" ? "Continue from here" : "Fork into new session";
    if (this.operation === "fork") return "Forking…";
    return this.summaryMode === "none" ? "Continuing…" : "Summarizing…";
  }

  private submitSelectedOperation(): Promise<void> {
    return this.operation === "continue" ? this.submitNavigation() : this.submitFork();
  }

  private async submitNavigation(): Promise<void> {
    if (this.busy || this.selectedId === undefined) return;
    const validation = validateSessionTreeSummaryChoice(this.summaryMode, this.customInstructions);
    if (!validation.ok) {
      this.error = "";
      this.statusMessage = "";
      this.pendingFocus = "custom";
      this.requestUpdate();
      return;
    }
    const navigate = this.onNavigate;
    if (navigate === undefined) {
      this.error = "Session tree navigation is unavailable. Close and reopen /tree, then try again.";
      return;
    }

    const targetId = this.selectedId;
    const generation = ++this.operationGeneration;
    this.busy = true;
    this.aborting = false;
    this.error = "";
    this.statusMessage = "";
    try {
      const result = await navigate(targetId, validation.choice);
      if (generation !== this.operationGeneration) return;
      this.busy = false;
      this.aborting = false;
      if (!result.cancelled) return;
      this.step = "tree";
      this.statusMessage = result.aborted === true
        ? "Summarization cancelled. Your selected history entry is unchanged."
        : "Navigation cancelled. Your selected history entry is unchanged.";
      this.pendingFocus = "tree";
    } catch (error: unknown) {
      if (generation !== this.operationGeneration) return;
      this.busy = false;
      this.aborting = false;
      this.statusMessage = "";
      this.error = `Could not navigate session history: ${errorMessage(error)}`;
    }
  }

  private async submitFork(): Promise<void> {
    if (this.busy || this.selectedId === undefined) return;
    const fork = this.onFork;
    if (fork === undefined) {
      this.error = "Fork from the session tree is unavailable. Close and reopen /tree, then try again.";
      return;
    }

    const entryId = this.selectedId;
    const generation = ++this.operationGeneration;
    this.busy = true;
    this.error = "";
    this.statusMessage = "";
    try {
      const result = await fork(entryId);
      if (generation !== this.operationGeneration) return;
      // On success the app closes this dialog; clear busy in case it lingers.
      this.busy = false;
      if (result.cancelled) {
        this.statusMessage = "Fork cancelled. No new session was created; your selected history entry is unchanged.";
      }
    } catch (error: unknown) {
      if (generation !== this.operationGeneration) return;
      this.busy = false;
      this.statusMessage = "";
      this.error = errorMessage(error);
    }
  }

  private async abortNavigation(): Promise<void> {
    if (!this.busy || this.summaryMode === "none" || this.aborting) return;
    const abort = this.onAbort;
    if (abort === undefined) {
      this.error = "Summarization cannot be cancelled from this client.";
      return;
    }
    const generation = this.operationGeneration;
    this.aborting = true;
    this.error = "";
    this.statusMessage = "Cancelling summarization…";
    try {
      await abort();
    } catch (error: unknown) {
      if (generation !== this.operationGeneration) return;
      this.aborting = false;
      this.statusMessage = "";
      this.error = `Could not cancel summarization: ${errorMessage(error)}`;
    }
  }

  // Escape and backdrop presses share one dismissal route through the surface:
  // the action step steps back to the tree, the tree step cancels.
  private requestDismissal(): void {
    if (this.step === "action") this.returnToTree();
    else this.onCancel?.();
  }

  // Busy Escape contract: only an in-flight summarization can be aborted; a
  // plain navigation or fork in flight swallows Escape (pre-surface routing kept).
  private requestBusyEscape(): void {
    if (this.operation === "continue" && this.summaryMode !== "none") void this.abortNavigation();
  }

  private focusSelectedTreeItem(): void {
    const selectedId = this.selectedId;
    if (selectedId === undefined) {
      this.renderRoot.querySelector<HTMLElement>(".close-button")?.focus();
      return;
    }
    const rows = this.renderRoot.querySelectorAll<HTMLElement>("[data-tree-node-id]");
    for (const row of rows) {
      if (row.dataset["treeNodeId"] !== selectedId) continue;
      row.focus();
      row.scrollIntoView({ block: "nearest" });
      return;
    }
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 40; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    * { box-sizing: border-box; }
    /* Full-viewport shell: the surface's centered-card defaults are overridden
       so the dialog keeps covering the whole viewport. */
    modal-surface { --modal-surface-width: 100%; --modal-surface-height: 100dvh; --modal-surface-max-height: 100dvh; --modal-surface-border: 0; --modal-surface-radius: 0; --modal-surface-shadow: none; }
    header, footer { display: flex; align-items: center; gap: 12px; padding: max(14px, env(safe-area-inset-top)) max(18px, env(safe-area-inset-right)) 14px max(18px, env(safe-area-inset-left)); border-bottom: 1px solid var(--pi-border); }
    footer { min-height: 64px; justify-content: end; padding: 12px max(18px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left)); border-top: 1px solid var(--pi-border); border-bottom: 0; }
    header > div { min-width: 0; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 21px; line-height: 1.25; }
    h2 { margin-top: 2px; font-size: 18px; }
    .eyebrow { display: block; color: var(--pi-muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .close-button { width: 36px; height: 36px; margin-inline-start: auto; display: grid; place-items: center; border: 0; background: transparent; color: var(--pi-muted); padding: 0; font-size: 25px; }
    .close-button:not(:disabled):hover, .close-button:not(:disabled):focus-visible { color: var(--pi-text); background: var(--pi-surface-hover); }
    .body { flex: 1 1 auto; min-height: 0; overflow: auto; }
    .tree-step { display: flex; flex-direction: column; gap: 10px; padding: 14px max(18px, env(safe-area-inset-right)) 16px max(18px, env(safe-area-inset-left)); }
    .tree-intro { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 20px; color: var(--pi-muted); }
    .legend { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; font-size: 12px; }
    .legend > span { display: inline-flex; align-items: center; gap: 5px; }
    .marker { width: 9px; height: 9px; border-radius: 999px; background: var(--pi-border); }
    .active-path-marker { background: var(--pi-accent); }
    .active-leaf-marker { box-shadow: 0 0 0 2px var(--pi-accent); background: var(--pi-bg); }
    .tree { min-height: 0; overflow: auto; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); overscroll-behavior: contain; }
    .tree-row { min-height: 48px; display: grid; grid-template-columns: 20px minmax(82px, auto) minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 7px 10px 7px calc(10px + var(--tree-indent)); border-bottom: 1px solid var(--pi-border-muted); cursor: pointer; outline: none; content-visibility: auto; contain-intrinsic-block-size: 48px; }
    .tree-row:last-child { border-bottom: 0; }
    .tree-row:hover { background: var(--pi-surface-hover); }
    .tree-row.selected { background: var(--pi-selection-bg); box-shadow: inset 3px 0 var(--pi-accent); }
    .tree-row:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    .tree-row.active-path:not(.selected) { background: color-mix(in srgb, var(--pi-accent) 7%, var(--pi-surface)); }
    .tree-row.active-leaf { box-shadow: inset 3px 0 var(--pi-accent); }
    .tree-row.bookkeeping { color: var(--pi-muted); }
    .disclosure { width: 20px; height: 28px; display: grid; place-items: center; border-radius: 5px; color: var(--pi-muted); font-size: 15px; user-select: none; }
    .disclosure:not(.leaf):hover { color: var(--pi-text); background: var(--pi-surface-hover); }
    .disclosure.leaf { opacity: .5; }
    .metadata { display: contents; }
    .tree-row > .disclosure { grid-column: 1; grid-row: 1; }
    .tree-row > .metadata > .kind { grid-column: 2; grid-row: 1; }
    .tree-row > .entry { grid-column: 3; grid-row: 1; }
    .tree-row > .metadata > .badges { grid-column: 4; grid-row: 1; }
    .kind { --kind-border: var(--pi-border); --kind-background: var(--pi-surface); display: inline-flex; align-items: center; width: fit-content; border: 1px solid var(--kind-border); border-radius: 999px; padding: 2px 7px; color: var(--pi-text); background: var(--kind-background); font-size: 11px; font-weight: 700; white-space: nowrap; }
    .kind-tone-user { --kind-border: var(--pi-accent-border); --kind-background: var(--pi-selection-bg); }
    .kind-tone-assistant { --kind-border: var(--pi-border); --kind-background: var(--pi-surface); }
    .kind-tone-tool { --kind-border: var(--pi-warning-border); --kind-background: var(--pi-warning-surface); }
    .kind-tone-shell { --kind-border: var(--pi-success); --kind-background: var(--pi-success-bg); }
    .kind-tone-context { --kind-border: var(--pi-purple-border); --kind-background: var(--pi-purple-surface); }
    .kind-tone-metadata { --kind-border: var(--pi-border-muted); --kind-background: var(--pi-bg-overlay); color: var(--pi-muted); }
    .entry { min-width: 0; display: flex; align-items: baseline; gap: 8px; }
    .summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-text); }
    .bookkeeping .summary { color: var(--pi-muted); }
    .label { max-width: 180px; overflow: hidden; text-overflow: ellipsis; border-radius: 4px; padding: 1px 5px; background: var(--pi-bg-overlay); color: var(--pi-muted); font-size: 11px; white-space: nowrap; }
    time { color: var(--pi-muted); font-size: 11px; white-space: nowrap; }
    .badges { display: flex; align-items: center; justify-content: end; gap: 5px; }
    .badge { border-radius: 999px; padding: 2px 7px; font-size: 11px; font-weight: 700; white-space: nowrap; }
    .badge.path { background: color-mix(in srgb, var(--pi-accent) 14%, transparent); color: var(--pi-text); }
    .badge.leaf { border: 1px solid var(--pi-accent); color: var(--pi-text); }
    .confirmation-step { padding: 24px max(18px, env(safe-area-inset-right)) 24px max(18px, env(safe-area-inset-left)); }
    .confirmation-card { width: min(760px, 100%); margin: 0 auto; display: grid; gap: 16px; }
    .selected-entry, .side-effects-note, .dialog-error, .dialog-status, .empty { border: 1px solid var(--pi-border); border-radius: 10px; padding: 12px 14px; }
    .selected-entry { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 8px 10px; background: var(--pi-surface); }
    .selected-entry p { grid-column: 2; color: var(--pi-muted); font-size: 12px; }
    fieldset { min-width: 0; margin: 0; padding: 0; border: 0; display: grid; gap: 9px; }
    legend { margin-bottom: 8px; font-weight: 700; }
    .choice-option { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 10px; border: 1px solid var(--pi-border); border-radius: 10px; padding: 11px 12px; background: var(--pi-surface); cursor: pointer; }
    .choice-option.selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .choice-option input { margin-top: 3px; accent-color: var(--pi-accent); }
    .choice-option span { display: grid; gap: 3px; }
    .choice-option small { color: var(--pi-muted); }
    .custom-focus { display: grid; gap: 6px; margin: 2px 0 0 30px; font-weight: 600; }
    textarea { width: 100%; resize: vertical; min-height: 94px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); padding: 9px 10px; font: var(--pi-control-font-size, 16px) var(--pi-control-font-family, system-ui, sans-serif); }
    textarea:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .character-count { justify-self: end; color: var(--pi-muted); font-size: 11px; font-weight: 400; }
    .validation-error { margin-inline-start: 30px; color: var(--pi-danger); font-size: 12px; }
    .side-effects-note { border-color: var(--pi-warning-border); background: var(--pi-warning-surface); }
    .dialog-error { border-color: var(--pi-danger); background: color-mix(in srgb, var(--pi-danger) 10%, var(--pi-bg)); color: var(--pi-danger); }
    .dialog-status { border-color: var(--pi-success-border); background: var(--pi-success-bg); }
    .empty { color: var(--pi-muted); background: var(--pi-surface); }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 8px 11px; font: inherit; cursor: pointer; }
    button:not(:disabled):hover { background: var(--pi-surface-hover); }
    button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    button:disabled { opacity: .52; cursor: not-allowed; }
    button.primary { border-color: var(--pi-accent); background: var(--pi-accent); color: var(--pi-bg); font-weight: 700; }
    button.primary:not(:disabled):hover { filter: brightness(1.08); }
    button.danger { color: var(--pi-danger); }
    .footer-spacer { flex: 1; }

    @media (max-width: 760px) {
      header { padding-top: max(12px, env(safe-area-inset-top)); }
      .tree-step { padding-inline: max(8px, env(safe-area-inset-left)) max(8px, env(safe-area-inset-right)); }
      .tree-intro { padding-inline: 4px; }
      .tree-row { grid-template-columns: 20px minmax(0, 1fr); padding-inline-start: calc(7px + min(var(--tree-indent-mobile), 48px)); }
      .tree-row > .metadata { grid-column: 2; grid-row: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 5px 8px; }
      .tree-row > .metadata > .badges { margin-inline-start: auto; flex-wrap: wrap; }
      .tree-row > .entry { grid-column: 2; grid-row: 2; display: grid; gap: 3px; }
      .tree-row .summary { white-space: normal; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
      .tree-row time { display: none; }
      .confirmation-step { padding: 18px 12px; }
      .custom-focus, .validation-error { margin-inline-start: 0; }
      footer { flex-wrap: wrap; }
    }
  `;
}

export function sessionTreeVisualDepth(depth: number): number {
  return Math.min(Math.max(0, depth), MAX_SESSION_TREE_VISUAL_DEPTH);
}

export function sessionTreeEntryReturnsToEditor(kind: SessionTreeNodeKind): boolean {
  return kind === "user" || kind === "custom-message";
}

export function sessionTreeKindPresentation(kind: SessionTreeNodeKind): SessionTreeKindPresentation {
  return SESSION_TREE_KIND_PRESENTATION[kind];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
