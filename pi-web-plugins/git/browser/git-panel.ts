import type {
  HtmlTemplateTag,
  JsonValue,
  PluginAction,
  PluginContributions,
  PluginRuntimeContext,
  SvgTemplateTag,
  Workspace,
  WorkspacePanelContext,
  WorkspacePanelContribution,
} from "@jmfederico/pi-web/plugin-api";
import {
  GIT_DIFF_OPERATION,
  GIT_STATUS_OPERATION,
  parseGitDiffResponse,
  parseGitStatusResponse,
  type GitDiffResponse,
  type GitStatusFile,
  type GitStatusResponse,
} from "./git-contract.js";
import { buildGitFileList, type GitFileListModel, type GitFileListSubmoduleFile, type GitFileListSubmoduleGroup } from "./gitFileList.js";
import { buildGitFileTree, collectGitFileTreeDirectoryPaths, type GitFileTreeNode } from "./gitFileTree.js";
import { readGitFileView, writeGitFileView, type GitFileView } from "./gitFileViewPreference.js";
import { createGitDiffRoute, type GitDiffRoute } from "./gitRoute.js";
import { parseUnifiedDiff, type UnifiedDiffLine, type UnifiedDiffTextSpan } from "./unifiedDiff.js";

const GIT_PANEL_LOCAL_ID = "workspace.git";
const GIT_POLL_INTERVAL_MS = 8_000;
// Keep navigation state for a few recent workspaces; heavy diff views are
// released as soon as another machine/workspace becomes active.
const GIT_WORKSPACE_STATE_LIMIT = 8;
const activityElementTag = "pi-web-git-panel-activity";

interface GitWorkspaceUiState {
  context: WorkspacePanelContext;
  retained: boolean;
  routeInitialized: boolean;
  status: GitStatusResponse | undefined;
  statusLoading: boolean;
  stale: boolean;
  selectedDiffPath: string | undefined;
  selectedDiff: GitDiffView | undefined;
  selectedStagedDiff: GitDiffView | undefined;
  diffLoading: boolean;
  error: string | undefined;
  expandedDirectories: Set<string>;
  statusRequest: Promise<void> | undefined;
  diffRequestSequence: number;
  viewStateCache: GitViewStateCache | undefined;
}

interface GitDiffView {
  readonly response: GitDiffResponse;
  lines: UnifiedDiffLine[] | undefined;
}

interface GitViewState {
  readonly nodes: readonly GitFileTreeNode[];
  readonly listModel: GitFileListModel;
  readonly expandablePaths: readonly string[];
}

interface GitViewStateCache {
  readonly status: GitStatusResponse | undefined;
  readonly view: GitFileView;
  readonly viewState: GitViewState;
}

const EMPTY_LIST_MODEL: GitFileListModel = { submodules: [], files: [] };
const EMPTY_VIEW_STATE: GitViewState = { nodes: [], listModel: EMPTY_LIST_MODEL, expandablePaths: [] };

export function createGitBrowserContributions(
  sourcePluginId: string,
  runtimePluginId: string,
  html: HtmlTemplateTag,
  svg: SvgTemplateTag,
): PluginContributions {
  const panelId = `${runtimePluginId}:${GIT_PANEL_LOCAL_ID}`;
  const controller = new GitUiController(sourcePluginId, createGitDiffRoute(panelId));
  defineGitPanelActivityElement();
  return {
    actions: createGitActions(panelId, controller),
    workspacePanels: [createGitPanel(html, svg, controller)],
  };
}

class GitUiController {
  private readonly states = new Map<string, GitWorkspaceUiState>();
  private activeWorkspaceKey: string | undefined;
  private connectedWorkspaceKey: string | undefined;
  private routeNavigationPending = true;
  private view: GitFileView = readGitFileView();

  constructor(
    private readonly sourcePluginId: string,
    private readonly route: GitDiffRoute,
  ) {}

  isOwnedWorkspace(workspace: Workspace | undefined): boolean {
    return workspace?.provider?.pluginId === this.sourcePluginId;
  }

  state(context: WorkspacePanelContext): GitWorkspaceUiState {
    return this.stateFor(context);
  }

  connect(context: WorkspacePanelContext): void {
    const key = workspaceContextKey(context);
    const changedWorkspace = this.activeWorkspaceKey !== key;
    if (changedWorkspace) this.releaseInactiveDiff();
    const state = this.stateFor(context);
    this.activeWorkspaceKey = key;
    this.connectedWorkspaceKey = key;
    this.synchronizeRoute(state, changedWorkspace);
    if (state.status === undefined && state.statusRequest === undefined) void this.refresh(context);
    else if (state.selectedDiffPath !== undefined && (state.selectedDiff === undefined || state.selectedStagedDiff === undefined) && !state.diffLoading) {
      if (state.status?.files.some((file) => file.path === state.selectedDiffPath) === true) void this.refreshDiff(state, state.selectedDiffPath, context);
      else this.clearSelection(state, true);
    }
  }

  disconnect(context: WorkspacePanelContext): void {
    if (this.connectedWorkspaceKey === workspaceContextKey(context)) this.connectedWorkspaceKey = undefined;
  }

  handlePopState(context: WorkspacePanelContext): void {
    this.routeNavigationPending = true;
    if (!this.route.matches(context)) return;
    this.connect(context);
    this.requestRender(this.stateFor(context));
  }

  poll(context: WorkspacePanelContext): void {
    void this.refresh(context);
  }

  invalidate(context: WorkspacePanelContext): Promise<void> {
    if (!this.isOwnedWorkspace(context.workspace)) return Promise.resolve();
    const state = this.stateFor(context);
    state.stale = state.status !== undefined;
    this.requestRender(state);
    return this.refresh(context);
  }

  refresh(context: WorkspacePanelContext): Promise<void> {
    const state = this.stateFor(context);
    if (state.statusRequest !== undefined) return state.statusRequest;
    state.statusLoading = true;
    this.requestRender(state);

    const request = requestGitBackend(context, GIT_STATUS_OPERATION, null)
      .then(parseGitStatusResponse)
      .then(async (status) => {
        if (!state.retained) return;
        state.status = state.status?.hash === status.hash ? state.status : status;
        state.stale = false;
        state.error = undefined;
        const path = state.selectedDiffPath;
        if (path === undefined) return;
        if (!status.files.some((file) => file.path === path)) this.clearSelection(state, true);
        else if (this.connectedWorkspaceKey === workspaceContextKey(context)) await this.refreshDiff(state, path, context);
      })
      .catch((error: unknown) => {
        if (state.retained) state.error = errorMessage(error);
      })
      .finally(() => {
        if (state.statusRequest !== request) return;
        state.statusRequest = undefined;
        state.statusLoading = false;
        this.requestRender(state);
      });
    state.statusRequest = request;
    return request;
  }

  selectDiff(context: WorkspacePanelContext, path: string): void {
    const state = this.stateFor(context);
    state.selectedDiffPath = path;
    state.selectedDiff = undefined;
    state.selectedStagedDiff = undefined;
    state.diffLoading = true;
    state.error = undefined;
    if (this.route.matches(context)) this.route.write(path);
    this.requestRender(state);
    void this.refreshDiff(state, path, context);
  }

  setView(context: WorkspacePanelContext, view: GitFileView): void {
    if (this.view === view) return;
    this.view = view;
    writeGitFileView(view);
    for (const state of this.states.values()) {
      state.expandedDirectories = new Set();
      state.viewStateCache = undefined;
    }
    this.requestRender(this.stateFor(context));
  }

  currentView(): GitFileView {
    return this.view;
  }

  viewState(state: GitWorkspaceUiState): GitViewState {
    const cached = state.viewStateCache;
    if (cached !== undefined && cached.status === state.status && cached.view === this.view) return cached.viewState;
    const viewState = buildViewState(state.status, this.view);
    state.viewStateCache = { status: state.status, view: this.view, viewState };
    return viewState;
  }

  toggleDirectory(context: WorkspacePanelContext, path: string): void {
    const state = this.stateFor(context);
    const next = new Set(state.expandedDirectories);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    state.expandedDirectories = next;
    this.requestRender(state);
  }

  toggleExpandAll(context: WorkspacePanelContext, paths: readonly string[], collapse: boolean): void {
    const state = this.stateFor(context);
    state.expandedDirectories = collapse ? new Set() : new Set(paths);
    this.requestRender(state);
  }

  private stateFor(context: WorkspacePanelContext): GitWorkspaceUiState {
    const key = workspaceContextKey(context);
    const existing = this.states.get(key);
    if (existing !== undefined) {
      existing.context = context;
      this.states.delete(key);
      this.states.set(key, existing);
      return existing;
    }
    this.evictOldestState();
    const created: GitWorkspaceUiState = {
      context,
      retained: true,
      routeInitialized: false,
      status: undefined,
      statusLoading: false,
      stale: false,
      selectedDiffPath: undefined,
      selectedDiff: undefined,
      selectedStagedDiff: undefined,
      diffLoading: false,
      error: undefined,
      expandedDirectories: new Set(),
      statusRequest: undefined,
      diffRequestSequence: 0,
      viewStateCache: undefined,
    };
    this.states.set(key, created);
    return created;
  }

  private releaseInactiveDiff(): void {
    if (this.activeWorkspaceKey === undefined) return;
    const state = this.states.get(this.activeWorkspaceKey);
    if (state === undefined) return;
    state.selectedDiff = undefined;
    state.selectedStagedDiff = undefined;
    state.diffLoading = false;
    state.diffRequestSequence += 1;
  }

  private evictOldestState(): void {
    if (this.states.size < GIT_WORKSPACE_STATE_LIMIT) return;
    const key = [...this.states.keys()].find((candidate) => candidate !== this.connectedWorkspaceKey) ?? this.states.keys().next().value;
    if (key === undefined) return;
    const state = this.states.get(key);
    if (state !== undefined) {
      state.retained = false;
      state.diffRequestSequence += 1;
    }
    this.states.delete(key);
  }

  private synchronizeRoute(state: GitWorkspaceUiState, changedWorkspace: boolean): void {
    if (!this.route.matches(state.context)) return;
    const routePath = this.route.read();
    if (this.routeNavigationPending || !state.routeInitialized || (!changedWorkspace && routePath !== state.selectedDiffPath)) {
      this.routeNavigationPending = false;
      state.routeInitialized = true;
      this.applyRouteSelection(state, routePath);
      this.route.write(routePath, { replace: true });
      return;
    }
    if (changedWorkspace) this.route.write(state.selectedDiffPath, { replace: true });
  }

  private applyRouteSelection(state: GitWorkspaceUiState, path: string | undefined): void {
    if (state.selectedDiffPath === path) return;
    state.selectedDiffPath = path;
    state.selectedDiff = undefined;
    state.selectedStagedDiff = undefined;
    state.diffLoading = false;
    state.diffRequestSequence += 1;
  }

  private clearSelection(state: GitWorkspaceUiState, replaceUrl: boolean): void {
    this.applyRouteSelection(state, undefined);
    if (replaceUrl && this.connectedWorkspaceKey === workspaceContextKey(state.context) && this.route.matches(state.context)) {
      this.route.write(undefined, { replace: true });
    }
  }

  private async refreshDiff(state: GitWorkspaceUiState, path: string, context: WorkspacePanelContext): Promise<void> {
    const sequence = state.diffRequestSequence + 1;
    state.diffRequestSequence = sequence;
    state.diffLoading = true;
    this.requestRender(state);
    try {
      const [selectedDiff, selectedStagedDiff] = await Promise.all([
        requestGitBackend(context, GIT_DIFF_OPERATION, { path }).then(parseGitDiffResponse),
        requestGitBackend(context, GIT_DIFF_OPERATION, { path, staged: true }).then(parseGitDiffResponse),
      ]);
      if (!state.retained || state.diffRequestSequence !== sequence || state.selectedDiffPath !== path) return;
      state.selectedDiff = createDiffView(selectedDiff, state.selectedDiff);
      state.selectedStagedDiff = createDiffView(selectedStagedDiff, state.selectedStagedDiff);
      state.error = undefined;
    } catch (error) {
      if (!state.retained || state.diffRequestSequence !== sequence || state.selectedDiffPath !== path) return;
      state.error = errorMessage(error);
    } finally {
      if (state.retained && state.diffRequestSequence === sequence && state.selectedDiffPath === path) {
        state.diffLoading = false;
        this.requestRender(state);
      }
    }
  }

  private requestRender(state: GitWorkspaceUiState): void {
    if (state.retained) state.context.host.requestRender();
  }
}

function createGitActions(panelId: string, controller: GitUiController): PluginAction[] {
  const hasGitWorkspace = (context: PluginRuntimeContext): boolean => controller.isOwnedWorkspace(context.state.selectedWorkspace);
  return [
    {
      id: "view.git",
      title: "Go to Git",
      shortcut: "mod+3",
      shortcutAliases: ["core:view.git"],
      group: "Navigation",
      enabled: hasGitWorkspace,
      run: (context) => { context.selectMainView(panelId); },
    },
    {
      id: "workspace.refresh-git",
      title: "Refresh Git",
      shortcut: "mod+shift+g",
      shortcutAliases: ["core:workspace.refresh-git"],
      group: "Workspace",
      enabled: hasGitWorkspace,
      run: (context) => context.refreshWorkspacePanels(panelId),
    },
  ];
}

function createGitPanel(
  html: HtmlTemplateTag,
  svg: SvgTemplateTag,
  controller: GitUiController,
): WorkspacePanelContribution {
  return {
    id: GIT_PANEL_LOCAL_ID,
    title: "Git",
    icon: svg`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="6" cy="6" r="2"></circle>
        <circle cx="18" cy="6" r="2"></circle>
        <circle cx="12" cy="18" r="2"></circle>
        <path d="M8 6h6"></path>
        <path d="M6 8v2a6 6 0 0 0 6 6"></path>
        <path d="M18 8v2a6 6 0 0 1-6 6"></path>
      </svg>
    `,
    order: 20,
    routeAliases: ["git", "core:workspace.git"],
    visible: (context) => controller.isOwnedWorkspace(context.workspace),
    onInvalidate: (context) => controller.invalidate(context),
    render: (context) => renderGitPanel(html, controller, context),
  };
}

function requestGitBackend(context: WorkspacePanelContext, operation: string, input: JsonValue): Promise<JsonValue> {
  if (context.backend === undefined || context.workspace.provider?.capabilities.request === false) {
    return Promise.reject(new Error("Git workspace backend is unavailable. Update and restart PI WEB on this machine, then reload the browser."));
  }
  return context.backend.request(operation, input);
}

function renderGitPanel(html: HtmlTemplateTag, controller: GitUiController, context: WorkspacePanelContext) {
  const state = controller.state(context);
  const viewState = controller.viewState(state);
  return html`
    <section class="git-panel">
      <style .textContent=${gitPanelStyles}></style>
      <pi-web-git-panel-activity .controller=${controller} .context=${context}></pi-web-git-panel-activity>
      <section class="git-toolbar">
        <strong>Git</strong>
        ${state.stale ? html`<span class="git-stale">stale</span>` : null}
        <div class="git-toolbar-actions">
          ${viewState.expandablePaths.length === 0 ? null : renderExpandCollapseAll(html, controller, context, state, viewState.expandablePaths)}
          ${renderViewToggle(html, controller, context)}
          <button type="button" ?disabled=${state.statusLoading} @click=${() => { void controller.refresh(context); }}>Refresh</button>
        </div>
      </section>
      ${state.error === undefined ? null : html`<div class="git-error" role="alert">${state.error}</div>`}
      <section class="git-split">
        <div class="git-file-list">${renderFileList(html, controller, context, state, viewState)}</div>
        <div class="git-viewer">${renderDiffViewer(html, state)}</div>
      </section>
    </section>
  `;
}

function renderViewToggle(html: HtmlTemplateTag, controller: GitUiController, context: WorkspacePanelContext) {
  return html`
    <div class="git-view-toggle" role="group" aria-label="Changed files view">
      ${renderViewToggleButton(html, controller, context, "list", "List")}
      ${renderViewToggleButton(html, controller, context, "tree", "Tree")}
    </div>
  `;
}

function renderViewToggleButton(html: HtmlTemplateTag, controller: GitUiController, context: WorkspacePanelContext, view: GitFileView, label: string) {
  const active = controller.currentView() === view;
  return html`<button type="button" class=${active ? "is-selected" : ""} aria-pressed=${String(active)} @click=${() => { controller.setView(context, view); }}>${label}</button>`;
}

function renderExpandCollapseAll(
  html: HtmlTemplateTag,
  controller: GitUiController,
  context: WorkspacePanelContext,
  state: GitWorkspaceUiState,
  expandablePaths: readonly string[],
) {
  const allExpanded = expandablePaths.every((path) => state.expandedDirectories.has(path));
  return html`<button type="button" @click=${() => { controller.toggleExpandAll(context, expandablePaths, allExpanded); }}>${allExpanded ? "Collapse all" : "Expand all"}</button>`;
}

function renderFileList(
  html: HtmlTemplateTag,
  controller: GitUiController,
  context: WorkspacePanelContext,
  state: GitWorkspaceUiState,
  viewState: GitViewState,
) {
  const status = state.status;
  if (status === undefined) return html`<p class="git-muted">${state.error === undefined ? "Loading status…" : "Status unavailable."}</p>`;
  if (!status.isGitRepo) return html`<p class="git-muted">Not a git repository.</p>`;
  const summary = html`<p class="git-summary">${gitSummary(status)}</p>`;
  if (status.files.length === 0) return html`${summary}<p class="git-muted">No changes.</p>`;
  const body = controller.currentView() === "tree"
    ? viewState.nodes.map((node) => renderTreeNode(html, controller, context, state, node, 0))
    : renderListBody(html, controller, context, state, viewState.listModel);
  return html`${summary}${body}`;
}

function renderListBody(
  html: HtmlTemplateTag,
  controller: GitUiController,
  context: WorkspacePanelContext,
  state: GitWorkspaceUiState,
  model: GitFileListModel,
) {
  return html`
    ${model.submodules.map((group) => renderSubmoduleGroup(html, controller, context, state, group))}
    ${model.files.map((file) => renderFileRow(html, controller, context, state, file))}
  `;
}

function renderSubmoduleGroup(
  html: HtmlTemplateTag,
  controller: GitUiController,
  context: WorkspacePanelContext,
  state: GitWorkspaceUiState,
  group: GitFileListSubmoduleGroup,
) {
  const expanded = state.expandedDirectories.has(group.path);
  return html`
    <button type="button" class="git-row" style="--depth:0" aria-expanded=${String(expanded)} @click=${() => { controller.toggleDirectory(context, group.path); }}>
      <span class="git-twisty">${expanded ? "▾" : "▸"}</span>
      <span>${group.name}${submoduleBadge(html)}</span>
    </button>
    ${expanded ? html`
      ${group.pointer === undefined ? null : renderSelectableRow(html, controller, context, state, group.path, group.pointer.name, group.pointer.file, 1)}
      ${group.files.map((entry) => renderSubmoduleFileRow(html, controller, context, state, entry))}
    ` : null}
  `;
}

function renderSubmoduleFileRow(
  html: HtmlTemplateTag,
  controller: GitUiController,
  context: WorkspacePanelContext,
  state: GitWorkspaceUiState,
  entry: GitFileListSubmoduleFile,
) {
  return renderSelectableRow(html, controller, context, state, entry.path, entry.relativePath, entry.file, 1);
}

function renderTreeNode(
  html: HtmlTemplateTag,
  controller: GitUiController,
  context: WorkspacePanelContext,
  state: GitWorkspaceUiState,
  node: GitFileTreeNode,
  depth: number,
): ReturnType<HtmlTemplateTag> {
  if (node.kind === "directory") {
    const expanded = state.expandedDirectories.has(node.path);
    return html`
      <button type="button" class="git-row" style=${`--depth:${String(depth)}`} aria-expanded=${String(expanded)} @click=${() => { controller.toggleDirectory(context, node.path); }}>
        <span class="git-twisty">${expanded ? "▾" : "▸"}</span>
        <span>${node.name}${node.isSubmodule === true ? submoduleBadge(html) : null}</span>
      </button>
      ${expanded ? node.children.map((child) => renderTreeNode(html, controller, context, state, child, depth + 1)) : null}
    `;
  }
  return renderSelectableRow(html, controller, context, state, node.path, node.name, node.file, depth);
}

function renderFileRow(
  html: HtmlTemplateTag,
  controller: GitUiController,
  context: WorkspacePanelContext,
  state: GitWorkspaceUiState,
  file: GitStatusFile,
) {
  return renderSelectableRow(html, controller, context, state, file.path, file.path, file, 0);
}

function renderSelectableRow(
  html: HtmlTemplateTag,
  controller: GitUiController,
  context: WorkspacePanelContext,
  state: GitWorkspaceUiState,
  path: string,
  label: string,
  file: GitStatusFile,
  depth: number,
) {
  const selected = state.selectedDiffPath === path;
  return html`
    <button type="button" class=${selected ? "git-row is-selected" : "git-row"} style=${`--depth:${String(depth)}`} @click=${() => { controller.selectDiff(context, path); }}>
      <span>${stateLabel(file.index, file.workingTree)}</span>
      <span>${label}</span>
    </button>
  `;
}

function renderDiffViewer(html: HtmlTemplateTag, state: GitWorkspaceUiState) {
  if (state.selectedDiffPath === undefined) return html`<p class="git-muted">Select a changed file.</p>`;
  const unstaged = state.selectedDiff;
  const staged = state.selectedStagedDiff;
  if (unstaged === undefined || staged === undefined) return html`<p class="git-muted">Loading diff…</p>`;
  const diffs = [staged, unstaged].filter((diff) => diff.response.diff !== "");
  if (diffs.length === 0) return html`<p class="git-muted">No staged or unstaged diff.</p>`;
  return html`<div class=${diffs.length === 1 ? "git-diffs is-single" : "git-diffs"}>${diffs.map((diff) => renderDiffSection(html, diff))}</div>`;
}

function renderDiffSection(html: HtmlTemplateTag, view: GitDiffView) {
  const diff = view.response;
  const lines = view.lines ??= parseUnifiedDiff(diff.diff);
  return html`
    <section class="git-diff-section">
      <div class="git-viewer-header"><strong>${diff.path ?? "diff"}</strong><small>${diff.staged ? "staged" : "unstaged"}${diff.truncated ? " · truncated" : ""}</small></div>
      ${lines.length === 0 ? html`<p class="git-muted">No diff.</p>` : html`
        <div class="git-diff-scroller">
          <div class="git-diff-grid" role="table" aria-label="Unified diff">
            ${lines.map((line) => renderDiffLine(html, line))}
          </div>
        </div>
      `}
    </section>
  `;
}

function renderDiffLine(html: HtmlTemplateTag, line: UnifiedDiffLine) {
  return html`
    <div class="git-diff-line" role="row">
      <span class=${`git-diff-cell git-line-number ${line.kind}`} role="cell">${formatLineNumber(line.oldLineNumber)}</span>
      <span class=${`git-diff-cell git-line-number ${line.kind}`} role="cell">${formatLineNumber(line.newLineNumber)}</span>
      <span class=${`git-diff-cell git-prefix ${line.kind}`} role="cell">${line.prefix}</span>
      <span class=${`git-diff-cell git-content ${line.kind}`} role="cell">${renderDiffSpans(html, line.spans)}</span>
    </div>
  `;
}

function renderDiffSpans(html: HtmlTemplateTag, spans: UnifiedDiffTextSpan[]) {
  return spans.map((span) => html`<span class=${span.changed ? "inline-change" : ""}>${span.text}</span>`);
}

function buildViewState(status: GitStatusResponse | undefined, view: GitFileView): GitViewState {
  if (status === undefined || !status.isGitRepo || status.files.length === 0) return EMPTY_VIEW_STATE;
  if (view === "tree") {
    const nodes = buildGitFileTree(status.files, status.submodules);
    return { nodes, listModel: EMPTY_LIST_MODEL, expandablePaths: collectGitFileTreeDirectoryPaths(nodes) };
  }
  const listModel = buildGitFileList(status.files, status.submodules);
  return { nodes: [], listModel, expandablePaths: listModel.submodules.map((group) => group.path) };
}

function defineGitPanelActivityElement(): void {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined" || customElements.get(activityElementTag) !== undefined) return;
  class GitPanelActivityElement extends HTMLElement {
    private controllerValue: GitUiController | undefined;
    private contextValue: WorkspacePanelContext | undefined;
    private pollTimer: number | undefined;

    set controller(value: GitUiController | undefined) {
      if (this.controllerValue === value) return;
      this.controllerValue = value;
      this.restart();
    }

    set context(value: WorkspacePanelContext | undefined) {
      const previousKey = this.contextValue === undefined ? undefined : workspaceContextKey(this.contextValue);
      this.contextValue = value;
      if (previousKey !== (value === undefined ? undefined : workspaceContextKey(value))) this.restart();
    }

    connectedCallback(): void {
      window.addEventListener("popstate", this.onPopState);
      this.restart();
    }

    disconnectedCallback(): void {
      window.removeEventListener("popstate", this.onPopState);
      if (this.controllerValue !== undefined && this.contextValue !== undefined) this.controllerValue.disconnect(this.contextValue);
      this.stopTimer();
    }

    private restart(): void {
      this.stopTimer();
      if (!this.isConnected || this.controllerValue === undefined || this.contextValue === undefined) return;
      this.controllerValue.connect(this.contextValue);
      this.pollTimer = window.setInterval(() => {
        if (this.controllerValue !== undefined && this.contextValue !== undefined) this.controllerValue.poll(this.contextValue);
      }, GIT_POLL_INTERVAL_MS);
    }

    private stopTimer(): void {
      if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    private readonly onPopState = () => {
      if (this.controllerValue !== undefined && this.contextValue !== undefined) this.controllerValue.handlePopState(this.contextValue);
    };
  }
  customElements.define(activityElementTag, GitPanelActivityElement);
}

function submoduleBadge(html: HtmlTemplateTag) {
  return html`<span class="submodule-badge">submodule</span>`;
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

function formatLineNumber(lineNumber: number | undefined): string {
  return lineNumber === undefined ? "" : String(lineNumber);
}

function createDiffView(response: GitDiffResponse, previous: GitDiffView | undefined): GitDiffView {
  return {
    response,
    lines: previous?.response.hash === response.hash ? previous.lines : undefined,
  };
}

function workspaceContextKey(context: WorkspacePanelContext): string {
  return JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const gitPanelStyles = `
  .git-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--pi-text); background: var(--pi-bg); font: 13px system-ui, sans-serif; }
  .git-panel ${activityElementTag} { display: none; }
  .git-panel button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 5px 7px; cursor: pointer; }
  .git-panel button:disabled { cursor: wait; opacity: .65; }
  .git-panel small, .git-panel .git-muted { color: var(--pi-muted); }
  .git-panel p { margin: 10px; }
  .git-panel .git-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); }
  .git-panel .git-toolbar-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
  .git-panel .git-view-toggle { display: inline-flex; }
  .git-panel .git-view-toggle button { border-radius: 0; }
  .git-panel .git-view-toggle button:first-child { border-top-left-radius: 7px; border-bottom-left-radius: 7px; }
  .git-panel .git-view-toggle button:last-child { margin-left: -1px; border-top-right-radius: 7px; border-bottom-right-radius: 7px; }
  .git-panel .git-view-toggle button.is-selected { position: relative; z-index: 1; border-color: var(--pi-accent); background: var(--pi-selection-bg); }
  .git-panel .git-stale { border: 1px solid var(--pi-warning-border); border-radius: 999px; color: var(--pi-warning); padding: 1px 6px; font-size: 12px; }
  .git-panel .git-error { flex: 0 0 auto; margin: 8px; border: 1px solid var(--pi-danger); border-radius: 7px; color: var(--pi-danger); padding: 8px; }
  .git-panel .git-split { flex: 1 1 auto; min-height: 0; display: grid; grid-template-rows: minmax(160px, 34%) minmax(0, 1fr); }
  .git-panel .git-file-list { min-height: 0; overflow: auto; border-bottom: 1px solid var(--pi-border); padding: 6px; }
  .git-panel .git-row { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 4px; width: 100%; border: 0; border-radius: 5px; background: transparent; text-align: left; padding: 4px 6px 4px calc(6px + var(--depth, 0) * 14px); }
  .git-panel .git-row:hover, .git-panel .git-row.is-selected { background: var(--pi-selection-bg); }
  .git-panel .git-row span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .git-panel .git-twisty { color: var(--pi-dim, var(--pi-muted)); }
  .git-panel .git-summary { margin: 4px 6px 8px; color: var(--pi-muted); }
  .git-panel .submodule-badge { display: inline-block; margin-left: 6px; border: 1px solid var(--pi-border); border-radius: 999px; color: var(--pi-muted); padding: 0 5px; font-size: 11px; font-weight: 400; vertical-align: baseline; }
  .git-panel .git-viewer { min-height: 0; overflow: auto; display: flex; flex-direction: column; }
  .git-panel .git-diffs { flex: 1 1 auto; min-height: 0; overflow: auto; display: grid; grid-template-rows: minmax(120px, 1fr) minmax(120px, 1fr); }
  .git-panel .git-diffs.is-single { grid-template-rows: minmax(0, 1fr); }
  .git-panel .git-diff-section { min-height: 0; display: flex; flex-direction: column; border-bottom: 1px solid var(--pi-border); }
  .git-panel .git-diff-section:last-child { border-bottom: 0; }
  .git-panel .git-viewer-header { position: sticky; top: 0; display: flex; justify-content: space-between; gap: 8px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); }
  .git-panel .git-viewer-header strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .git-panel .git-diff-scroller { flex: 1 1 auto; min-height: 0; overflow: auto; background: var(--pi-bg); }
  .git-panel .git-diff-grid { display: grid; grid-template-columns: max-content max-content 2ch max-content; width: max-content; min-width: 100%; padding: 6px 0; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.45; }
  .git-panel .git-diff-line { display: contents; }
  .git-panel .git-diff-cell { min-height: 1.45em; white-space: pre; }
  .git-panel .git-line-number { min-width: 4ch; padding: 0 8px; border-right: 1px solid var(--pi-border-muted); color: var(--pi-dim); text-align: right; user-select: none; }
  .git-panel .git-prefix { padding: 0 4px; color: var(--pi-dim); text-align: center; user-select: none; }
  .git-panel .git-content { padding: 0 12px 0 4px; }
  .git-panel .git-diff-cell.meta, .git-panel .git-diff-cell.marker { color: var(--pi-dim); }
  .git-panel .git-diff-cell.hunk { background: color-mix(in srgb, var(--pi-accent) 9%, transparent); color: var(--pi-accent); }
  .git-panel .git-diff-cell.add { background: color-mix(in srgb, var(--pi-success) 12%, transparent); }
  .git-panel .git-diff-cell.remove { background: color-mix(in srgb, var(--pi-danger) 12%, transparent); }
  .git-panel .git-content.add .inline-change { border-radius: 2px; background: color-mix(in srgb, var(--pi-success) 36%, transparent); color: var(--pi-text); }
  .git-panel .git-content.remove .inline-change { border-radius: 2px; background: color-mix(in srgb, var(--pi-danger) 36%, transparent); color: var(--pi-text); }
`;
