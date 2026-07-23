import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GitDiffResponse, GitStatusFile, GitStatusResponse } from "../api";
import { buildGitFileTree, collectGitFileTreeDirectoryPaths, type GitFileTreeNode } from "../gitFileTree";
import { buildGitFileList, type GitFileListModel, type GitFileListSubmoduleFile, type GitFileListSubmoduleGroup } from "../gitFileList";
import { readGitFileView, writeGitFileView, type GitFileView } from "../gitFileViewPreference";
import type { WorkspacePanelContext } from "../plugins/types";
import { workspacePanelStyles } from "./shared";

interface GitViewState {
  readonly nodes: readonly GitFileTreeNode[];
  readonly listModel: GitFileListModel;
  readonly expandablePaths: readonly string[];
}

const EMPTY_LIST_MODEL: GitFileListModel = { submodules: [], files: [] };
const EMPTY_VIEW_STATE: GitViewState = { nodes: [], listModel: EMPTY_LIST_MODEL, expandablePaths: [] };

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
      .submodule-badge { display: inline-block; margin-left: 6px; border: 1px solid var(--pi-border); border-radius: 999px; color: var(--pi-muted); padding: 0 5px; font-size: 11px; font-weight: 400; vertical-align: baseline; }
    `,
  ];

  @property({ attribute: false }) context: WorkspacePanelContext | undefined;

  // Persisted across sessions via localStorage; only the mode is remembered.
  @state() private view: GitFileView = readGitFileView();

  // Ephemeral by design: the tree always opens fully collapsed, and expand
  // state is intentionally not persisted. Reassigned (never mutated in place)
  // so Lit observes the change. Shared by tree directories and, in list view,
  // submodule groups, both keyed by their path.
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
    const viewState = this.computeViewState(status);
    return html`
      <section class="toolbar">
        <strong>Git</strong>
        ${context.gitStale ? html`<span class="stale">stale</span>` : null}
        <div class="toolbar-actions">
          ${this.renderViewToggle()}
          ${viewState.expandablePaths.length > 0 ? this.renderExpandCollapseAll(viewState.expandablePaths) : null}
          <button type="button" @click=${context.onRefreshGit}>Refresh</button>
        </div>
      </section>
      <section class="split">
        <div class=${this.view === "tree" ? "list tree" : "list"}>
          ${this.renderFileList(context, status, viewState)}
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

  private renderExpandCollapseAll(expandablePaths: readonly string[]): TemplateResult {
    const allExpanded = expandablePaths.every((path) => this.expandedDirectories.has(path));
    return html`
      <button type="button" @click=${() => { this.toggleExpandAll(expandablePaths, allExpanded); }}>${allExpanded ? "Collapse all" : "Expand all"}</button>
    `;
  }

  private renderFileList(context: WorkspacePanelContext, status: GitStatusResponse | undefined, viewState: GitViewState): TemplateResult {
    if (status === undefined) return html`<p class="muted">No status loaded.</p>`;
    if (!status.isGitRepo) return html`<p class="muted">Not a git repository.</p>`;
    const summary = html`<p class="summary">${gitSummary(status)}</p>`;
    if (status.files.length === 0) return html`${summary}<p class="muted">No changes.</p>`;
    const body = this.view === "tree"
      ? viewState.nodes.map((node) => this.renderTreeNode(context, node, 0))
      : this.renderListBody(context, viewState.listModel);
    return html`${summary}${body}`;
  }

  private renderListBody(context: WorkspacePanelContext, model: GitFileListModel): TemplateResult {
    return html`
      ${model.submodules.map((group) => this.renderSubmoduleGroup(context, group))}
      ${model.files.map((file) => this.renderFileRow(context, file))}
    `;
  }

  private renderSubmoduleGroup(context: WorkspacePanelContext, group: GitFileListSubmoduleGroup): TemplateResult {
    const expanded = this.expandedDirectories.has(group.path);
    return html`
      <button type="button" class="row" style="--depth:0" aria-expanded=${expanded ? "true" : "false"} @click=${() => { this.toggleDirectory(group.path); }}>
        <span class="twisty">${expanded ? "▾" : "▸"}</span>
        <span>${group.name}${submoduleBadge()}</span>
      </button>
      ${expanded ? html`
        ${group.pointer === undefined ? null : this.renderSelectableRow(context, group.path, group.pointer.name, group.pointer.file, 1)}
        ${group.files.map((entry) => this.renderSubmoduleFileRow(context, entry))}
      ` : null}
    `;
  }

  private renderSubmoduleFileRow(context: WorkspacePanelContext, entry: GitFileListSubmoduleFile): TemplateResult {
    return this.renderSelectableRow(context, entry.path, entry.relativePath, entry.file, 1);
  }

  private renderTreeNode(context: WorkspacePanelContext, node: GitFileTreeNode, depth: number): TemplateResult {
    if (node.kind === "directory") {
      const expanded = this.expandedDirectories.has(node.path);
      return html`
        <button type="button" class="row" style=${`--depth:${String(depth)}`} aria-expanded=${expanded ? "true" : "false"} @click=${() => { this.toggleDirectory(node.path); }}>
          <span class="twisty">${expanded ? "▾" : "▸"}</span>
          <span>${node.name}${node.isSubmodule === true ? submoduleBadge() : null}</span>
        </button>
        ${expanded ? node.children.map((child) => this.renderTreeNode(context, child, depth + 1)) : null}
      `;
    }
    return this.renderSelectableRow(context, node.path, node.name, node.file, depth);
  }

  private renderFileRow(context: WorkspacePanelContext, file: GitStatusFile): TemplateResult {
    return this.renderSelectableRow(context, file.path, file.path, file, 0);
  }

  private renderSelectableRow(context: WorkspacePanelContext, path: string, label: string, file: GitStatusFile, depth: number): TemplateResult {
    const selected = context.selectedDiffPath === path;
    return html`
      <button type="button" class=${selected ? "row selected" : "row"} style=${`--depth:${String(depth)}`} @click=${() => { context.onSelectDiff(path); }}>
        <span>${stateLabel(file.index, file.workingTree)}</span>
        <span>${label}</span>
      </button>
    `;
  }

  private computeViewState(status: GitStatusResponse | undefined): GitViewState {
    if (status === undefined || !status.isGitRepo || status.files.length === 0) return EMPTY_VIEW_STATE;
    if (this.view === "tree") {
      const nodes = buildGitFileTree(status.files, status.submodules);
      return { nodes, listModel: EMPTY_LIST_MODEL, expandablePaths: collectGitFileTreeDirectoryPaths(nodes) };
    }
    const listModel = buildGitFileList(status.files, status.submodules);
    return { nodes: [], listModel, expandablePaths: listModel.submodules.map((group) => group.path) };
  }

  private setView(view: GitFileView): void {
    if (this.view === view) return;
    this.view = view;
    writeGitFileView(view);
    // Entering either view starts fully collapsed.
    this.expandedDirectories = new Set();
  }

  private toggleDirectory(path: string): void {
    const next = new Set(this.expandedDirectories);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    this.expandedDirectories = next;
  }

  private toggleExpandAll(expandablePaths: readonly string[], allExpanded: boolean): void {
    this.expandedDirectories = allExpanded ? new Set() : new Set(expandablePaths);
  }
}

function submoduleBadge(): TemplateResult {
  return html`<span class="submodule-badge">submodule</span>`;
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
