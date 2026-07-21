import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GitDiffResponse, GitStatusFile, GitStatusResponse } from "../api";
import { buildGitFileTree, collectGitFileTreeDirectoryPaths, type GitFileTreeNode } from "../gitFileTree";
import { readGitFileView, writeGitFileView, type GitFileView } from "../gitFileViewPreference";
import type { WorkspacePanelContext } from "../plugins/types";
import { workspacePanelStyles } from "./shared";

interface GitTreeState {
  readonly nodes: readonly GitFileTreeNode[];
  readonly directoryPaths: readonly string[];
}

const EMPTY_TREE_STATE: GitTreeState = { nodes: [], directoryPaths: [] };

@customElement("workspace-git-panel")
export class WorkspaceGitPanel extends LitElement {
  static override styles = [
    workspacePanelStyles,
    css`
      :host { flex: 1 1 auto; }
      .toolbar-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
      .toolbar .toolbar-actions button { margin-left: 0; }
      .view-toggle { display: inline-flex; }
      .view-toggle button { border-radius: 0; }
      .view-toggle button:first-child { border-top-left-radius: 7px; border-bottom-left-radius: 7px; }
      .view-toggle button:last-child { border-top-right-radius: 7px; border-bottom-right-radius: 7px; margin-left: -1px; }
      .view-toggle button.selected { position: relative; z-index: 1; }
      .row .twisty { color: var(--pi-dim, var(--pi-muted)); }
    `,
  ];

  @property({ attribute: false }) context: WorkspacePanelContext | undefined;

  // Persisted across sessions via localStorage; only the mode is remembered.
  @state() private view: GitFileView = readGitFileView();

  // Ephemeral by design: the tree always opens fully collapsed, and expand
  // state is intentionally not persisted. Reassigned (never mutated in place)
  // so Lit observes the change.
  @state() private expandedDirectories = new Set<string>();

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (!changedProperties.has("context")) return;
    const previous = changedProperties.get("context");
    if (previous !== undefined && this.context !== undefined && gitPanelContextKey(previous) !== gitPanelContextKey(this.context)) {
      // Switching workspace/machine resets the ephemeral expand state.
      this.expandedDirectories = new Set();
    }
  }

  override render(): TemplateResult {
    const context = this.context;
    if (context === undefined) return html`<p class="muted">Git unavailable.</p>`;
    const status = context.gitStatus;
    const treeState = this.computeTreeState(status);
    return html`
      <section class="toolbar">
        <strong>Git</strong>
        ${context.gitStale ? html`<span class="stale">stale</span>` : null}
        <div class="toolbar-actions">
          ${this.renderViewToggle()}
          ${this.view === "tree" && treeState.directoryPaths.length > 0 ? this.renderExpandCollapseAll(treeState.directoryPaths) : null}
          <button type="button" @click=${context.onRefreshGit}>Refresh</button>
        </div>
      </section>
      <section class="split">
        <div class=${this.view === "tree" ? "list tree" : "list"}>
          ${this.renderFileList(context, status, treeState.nodes)}
        </div>
        <div class="viewer">${renderDiffViewer(context)}</div>
      </section>
    `;
  }

  private renderViewToggle(): TemplateResult {
    return html`
      <div class="view-toggle" role="group" aria-label="Changed files view">
        ${this.renderViewToggleButton("list", "List")}
        ${this.renderViewToggleButton("tree", "Tree")}
      </div>
    `;
  }

  private renderViewToggleButton(view: GitFileView, label: string): TemplateResult {
    const active = this.view === view;
    return html`
      <button type="button" class=${active ? "selected" : ""} aria-pressed=${active ? "true" : "false"} @click=${() => { this.setView(view); }}>${label}</button>
    `;
  }

  private renderExpandCollapseAll(directoryPaths: readonly string[]): TemplateResult {
    const allExpanded = directoryPaths.every((path) => this.expandedDirectories.has(path));
    return html`
      <button type="button" @click=${() => { this.toggleExpandAll(directoryPaths, allExpanded); }}>${allExpanded ? "Collapse all" : "Expand all"}</button>
    `;
  }

  private renderFileList(context: WorkspacePanelContext, status: GitStatusResponse | undefined, nodes: readonly GitFileTreeNode[]): TemplateResult {
    if (status === undefined) return html`<p class="muted">No status loaded.</p>`;
    if (!status.isGitRepo) return html`<p class="muted">Not a git repository.</p>`;
    const summary = html`<p class="summary">${gitSummary(status)}</p>`;
    if (status.files.length === 0) return html`${summary}<p class="muted">No changes.</p>`;
    const body = this.view === "tree"
      ? nodes.map((node) => this.renderTreeNode(context, node, 0))
      : status.files.map((file) => this.renderFileRow(context, file));
    return html`${summary}${body}`;
  }

  private renderTreeNode(context: WorkspacePanelContext, node: GitFileTreeNode, depth: number): TemplateResult {
    if (node.kind === "directory") {
      const expanded = this.expandedDirectories.has(node.path);
      return html`
        <button type="button" class="row" style=${`--depth:${String(depth)}`} aria-expanded=${expanded ? "true" : "false"} @click=${() => { this.toggleDirectory(node.path); }}>
          <span class="twisty">${expanded ? "▾" : "▸"}</span>
          <span>${node.name}</span>
        </button>
        ${expanded ? node.children.map((child) => this.renderTreeNode(context, child, depth + 1)) : null}
      `;
    }
    const selected = context.selectedDiffPath === node.path;
    return html`
      <button type="button" class=${selected ? "row selected" : "row"} style=${`--depth:${String(depth)}`} @click=${() => { context.onSelectDiff(node.path); }}>
        <span>${stateLabel(node.file.index, node.file.workingTree)}</span>
        <span>${node.name}</span>
      </button>
    `;
  }

  private renderFileRow(context: WorkspacePanelContext, file: GitStatusFile): TemplateResult {
    const selected = context.selectedDiffPath === file.path;
    return html`
      <button type="button" class=${selected ? "row selected" : "row"} @click=${() => { context.onSelectDiff(file.path); }}>
        <span>${stateLabel(file.index, file.workingTree)}</span>
        <span>${file.path}</span>
      </button>
    `;
  }

  private computeTreeState(status: GitStatusResponse | undefined): GitTreeState {
    if (this.view !== "tree" || status === undefined || !status.isGitRepo || status.files.length === 0) return EMPTY_TREE_STATE;
    const nodes = buildGitFileTree(status.files);
    return { nodes, directoryPaths: collectGitFileTreeDirectoryPaths(nodes) };
  }

  private setView(view: GitFileView): void {
    if (this.view === view) return;
    this.view = view;
    writeGitFileView(view);
    // The tree always starts fully collapsed when entered.
    if (view === "tree") this.expandedDirectories = new Set();
  }

  private toggleDirectory(path: string): void {
    const next = new Set(this.expandedDirectories);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    this.expandedDirectories = next;
  }

  private toggleExpandAll(directoryPaths: readonly string[], allExpanded: boolean): void {
    this.expandedDirectories = allExpanded ? new Set() : new Set(directoryPaths);
  }
}

function renderDiffViewer(context: WorkspacePanelContext): TemplateResult {
  if (context.selectedDiffPath === undefined || context.selectedDiffPath === "") return html`<p class="muted">Select a changed file.</p>`;
  const unstaged = context.selectedDiff;
  const staged = context.selectedStagedDiff;
  if (unstaged === undefined || staged === undefined) return html`<p class="muted">Loading diff…</p>`;
  const diffs = [staged, unstaged].filter((diff) => diff.diff !== "");
  if (diffs.length === 0) return html`<p class="muted">No staged or unstaged diff.</p>`;
  return html`
    <div class=${diffs.length === 1 ? "diffs single" : "diffs"}>
      ${diffs.map((diff) => renderDiffSection(diff))}
    </div>
  `;
}

function renderDiffSection(diff: GitDiffResponse): TemplateResult {
  loadUnifiedDiffViewer();
  return html`
    <section class="diff-section">
      <div class="viewer-header"><strong>${diff.path ?? "diff"}</strong><small>${diff.staged ? "staged" : "unstaged"}${diff.truncated ? " · truncated" : ""}</small></div>
      <unified-diff-viewer .diff=${diff.diff}></unified-diff-viewer>
    </section>
  `;
}

function loadUnifiedDiffViewer(): void {
  void import("./UnifiedDiffViewer");
}

function gitSummary(status: GitStatusResponse): string {
  const branch = status.branch ?? "detached";
  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  return ahead === 0 && behind === 0 ? branch : `${branch} · ↑${String(ahead)} ↓${String(behind)}`;
}

function stateLabel(index: string, workingTree: string): string {
  const label = workingTree !== "unmodified" ? workingTree : index;
  return label.slice(0, 1).toUpperCase();
}

function gitPanelContextKey(context: WorkspacePanelContext): string {
  return `${context.machine.id}:${context.workspace.projectId}:${context.workspace.id}`;
}
