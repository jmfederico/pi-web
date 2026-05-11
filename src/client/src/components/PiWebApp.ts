import { LitElement, html } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { terminalsApi, type Project, type RealtimeEvent, type SessionInfo, type TerminalUiEvent, type ThinkingLevel, type Workspace } from "../api";
import type { AppAction } from "../actions";
import { initialAppState, type AppState } from "../appState";
import { FileExplorerController } from "../controllers/fileExplorerController";
import { GitController } from "../controllers/gitController";
import { ProjectController } from "../controllers/projectController";
import { SessionController } from "../controllers/sessionController";
import { WorkspaceController } from "../controllers/workspaceController";
import { KeyboardShortcutDispatcher } from "../keyboardShortcuts";
import { RealtimeSocket } from "../sessionSocket";
import type { QualifiedContributionId, QualifiedWorkspacePanelContribution, PluginRuntimeContext, WorkspacePanelContext } from "../plugins/types";
import { corePlugin } from "../plugins/core";
import { loadExternalPlugins } from "../plugins/external";
import { PluginRegistry } from "../plugins/registry";
import { queryNamespace, readNamespacedString } from "../namespacedQueryArgs";
import { readRoute, writeRoute } from "../route";
import "./ProjectList";
import "./WorkspaceList";
import "./SessionList";
import "./ChatView";
import type { ChatView } from "./ChatView";
import "./PromptEditor";
import type { PromptEditor } from "./PromptEditor";
import "./StatusBar";
import "./CommandPicker";
import "./ActionPalette";
import "./ProjectDialog";
import "./WorkspacePanel";
import { appStyles } from "./shared";

@customElement("pi-web-app")
export class PiWebApp extends LitElement {
  @state() private state: AppState = initialAppState();
  @query("chat-view") private chatView?: ChatView;
  @query("prompt-editor") private promptEditor?: PromptEditor;

  private readonly sessions = new SessionController(
    () => this.state,
    (patch) => { this.setState(patch); },
    () => { this.updateUrl(); },
  );
  private readonly workspaces = new WorkspaceController(
    () => this.state,
    (patch) => { this.setState(patch); },
    () => { this.updateUrl(); },
    this.sessions,
  );
  private readonly projects = new ProjectController(
    () => this.state,
    (patch) => { this.setState(patch); },
    this.workspaces,
  );
  private readonly files = new FileExplorerController(
    () => this.state,
    (patch) => { this.setState(patch); },
    () => { this.updateUrl(); },
  );
  private readonly git = new GitController(
    () => this.state,
    (patch) => { this.setState(patch); },
    () => { this.updateUrl(); },
  );
  private readonly keyboard = new KeyboardShortcutDispatcher();
  private readonly realtime = new RealtimeSocket();
  private readonly activeTerminalIds = new Set<string>();
  private terminalAutoStartWorkspaceId: string | undefined;
  private readonly plugins = createPluginRegistry();
  private readonly onPopState = () => void this.withChatScrollTransition(() => this.restoreRoute(false));
  private readonly onFocus = () => { void this.sessions.refreshSelectedSession(); };
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "visible") void this.sessions.refreshSelectedSession();
  };
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (this.keyboard.handle(event, this.getActions())) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("popstate", this.onPopState);
    window.addEventListener("focus", this.onFocus);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("keydown", this.onKeyDown);
    this.connectRealtime();
    void this.loadExternalPlugins();
    void this.loadProjectsAndRestoreRoute();
  }

  override disconnectedCallback(): void {
    window.removeEventListener("popstate", this.onPopState);
    window.removeEventListener("focus", this.onFocus);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("keydown", this.onKeyDown);
    this.keyboard.reset();
    this.sessions.dispose();
    this.realtime.close();
    this.git.dispose();
    super.disconnectedCallback();
  }

  private setState(patch: Partial<AppState>) {
    const previous = this.state;
    this.state = { ...this.state, ...patch };
    this.handleActivityTransition(previous, this.state);
    this.handleWorkspaceChange(previous, this.state);
  }

  private async loadProjectsAndRestoreRoute() {
    await this.projects.loadProjects();
    await this.withChatScrollTransition(() => this.restoreRoute(false));
  }

  private async restoreRoute(updateUrl: boolean) {
    const route = readRoute();
    const selectedFilePath = readNamespacedString(queryNamespace("core:workspace.files"), "file");
    const selectedDiffPath = readNamespacedString(queryNamespace("core:workspace.git"), "diff");
    this.setState({ workspaceTool: route.tool ?? this.state.workspaceTool, mainView: route.view ?? this.state.mainView, selectedFilePath, selectedDiffPath });
    if (route.projectId === undefined || route.projectId === "") return;
    const project = this.state.projects.find((p) => p.id === route.projectId);
    if (!project) return;
    await this.workspaces.selectProject(project, { workspaceId: route.workspaceId, sessionId: route.sessionId, updateUrl });
    this.setState({ selectedFilePath, selectedDiffPath });
    if (route.tool === "core:workspace.files") await this.files.refreshFiles();
    if (route.tool === "core:workspace.files" && selectedFilePath !== undefined) await this.files.restoreFile(selectedFilePath);
    if (route.tool === "core:workspace.git") await this.git.refreshGit();
    this.git.updatePolling();
  }

  private async withChatScrollTransition(action: () => Promise<void>) {
    this.chatView?.saveScrollPosition();
    await action();
    await this.updateComplete;
    await this.chatView?.updateComplete;
    await nextFrame();
    this.chatView?.restoreScrollPosition();
    this.promptEditor?.focusInput();
  }

  private async withChatPrependTransition(action: () => Promise<void>) {
    const anchor = this.chatView?.capturePrependScrollAnchor();
    await action();
    await this.updateComplete;
    await this.chatView?.updateComplete;
    await nextFrame();
    this.chatView?.restorePrependScrollAnchor(anchor);
  }

  private updateUrl(options?: { replace?: boolean | undefined }) {
    writeRoute({
      projectId: this.state.selectedProject?.id,
      workspaceId: this.state.selectedWorkspace?.id,
      sessionId: this.state.selectedSession?.id,
      tool: this.state.workspaceTool,
      view: this.state.mainView === "navigation" ? undefined : this.state.mainView,
    }, options);
  }

  private openWorkspaceTool(tool: QualifiedContributionId) {
    if (tool === "core:workspace.terminal") this.terminalAutoStartWorkspaceId = this.state.selectedWorkspace?.id;
    this.setState({ workspaceTool: tool, mainView: tool });
    this.updateUrl();
    this.refreshSelectedWorkspaceTool(tool);
    this.git.updatePolling();
  }

  private selectMainView(view: AppState["mainView"]) {
    if (view !== "navigation" && view !== "chat") {
      this.openWorkspaceTool(view);
      return;
    }
    this.setState({ mainView: view });
    this.updateUrl();
    this.git.updatePolling();
  }

  private handleWorkspaceChange(previous: AppState, next: AppState) {
    if (previous.selectedWorkspace?.id === next.selectedWorkspace?.id) return;
    this.terminalAutoStartWorkspaceId = undefined;
    this.activeTerminalIds.clear();
    this.setState({ activeTerminalCount: 0 });
    if (next.selectedWorkspace === undefined) return;
    void this.refreshActiveTerminals(next.selectedWorkspace);
    this.refreshSelectedWorkspaceTool(next.workspaceTool);
    this.git.updatePolling();
  }

  private connectRealtime(): void {
    this.realtime.connect(
      (event) => { this.handleRealtimeEvent(event); },
      () => {
        const workspace = this.state.selectedWorkspace;
        if (workspace !== undefined) void this.refreshActiveTerminals(workspace);
      },
    );
  }

  private handleRealtimeEvent(event: RealtimeEvent): void {
    if (isTerminalEvent(event)) this.applyTerminalEvent(event);
    else this.sessions.applyGlobalEvent(event);
  }

  private applyTerminalEvent(event: TerminalUiEvent): void {
    const workspace = this.state.selectedWorkspace;
    if (workspace === undefined) return;
    const cwd = event.type === "terminal.closed" ? event.cwd : event.terminal.cwd;
    if (cwd !== workspace.path) return;
    if (event.type === "terminal.created" && !event.terminal.exited) this.activeTerminalIds.add(event.terminal.id);
    else this.activeTerminalIds.delete(event.type === "terminal.closed" ? event.terminalId : event.terminal.id);
    this.setState({ activeTerminalCount: this.activeTerminalIds.size });
  }

  private async refreshActiveTerminals(workspace: Workspace): Promise<void> {
    try {
      const terminals = await terminalsApi.terminals(workspace.projectId, workspace.id);
      if (this.state.selectedWorkspace?.id !== workspace.id) return;
      this.activeTerminalIds.clear();
      for (const terminal of terminals) {
        if (!terminal.exited) this.activeTerminalIds.add(terminal.id);
      }
      this.setState({ activeTerminalCount: this.activeTerminalIds.size });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  private handleActivityTransition(previous: AppState, next: AppState) {
    const wasActive = isActive(previous.status);
    const nowActive = isActive(next.status);
    if (wasActive && !nowActive) {
      this.setState({ fileTreeStale: true, gitStale: true });
      this.refreshSelectedWorkspaceTool(this.state.workspaceTool);
    }
  }

  private refreshSelectedWorkspaceTool(tool: QualifiedContributionId): void {
    if (tool === "core:workspace.files") void this.files.refreshFiles();
    if (tool === "core:workspace.git") void this.git.refreshGit();
  }

  private renderWorkspacePanel() {
    const workspaceLabelItems = this.state.selectedWorkspace === undefined ? [] : this.plugins.getWorkspaceLabelItems(this.state, this.state.selectedWorkspace);
    return html`<workspace-panel .workspace=${this.state.selectedWorkspace} .tool=${this.state.workspaceTool} .panels=${this.visibleWorkspacePanels()} .workspaceLabelItems=${workspaceLabelItems} .fileTree=${this.state.fileTree} .expandedDirs=${this.state.expandedDirs} .selectedFilePath=${this.state.selectedFilePath} .selectedFileContent=${this.state.selectedFileContent} .fileTreeStale=${this.state.fileTreeStale} .gitStatus=${this.state.gitStatus} .selectedDiffPath=${this.state.selectedDiffPath} .selectedDiff=${this.state.selectedDiff} .selectedStagedDiff=${this.state.selectedStagedDiff} .gitStale=${this.state.gitStale} .activeTerminalCount=${this.state.activeTerminalCount} .terminalAutoStart=${this.terminalAutoStartWorkspaceId === this.state.selectedWorkspace?.id} .onSelectTool=${(tool: QualifiedContributionId) => { this.openWorkspaceTool(tool); }} .onRefreshFiles=${() => this.files.refreshFiles()} .onExpandDir=${(path: string) => this.files.expandDir(path)} .onSelectFile=${(path: string) => this.files.selectFile(path)} .onRefreshGit=${() => this.git.refreshGit()} .onSelectDiff=${(path: string) => this.git.selectDiff(path)}></workspace-panel>`;
  }

  private renderNavigationPanel(autoSwitchToChat: boolean) {
    const openChatAfter = (action: () => Promise<void>) => this.withChatScrollTransition(async () => {
      await action();
      if (autoSwitchToChat) this.setState({ mainView: "chat" });
      if (autoSwitchToChat) this.updateUrl();
    });
    return html`
      <header>
        <strong>Pi Web</strong>
        <button title="Show Actions" aria-label="Show Actions" @click=${() => { this.setState({ actionPaletteOpen: true }); }}>Actions</button>
      </header>
      <project-list .projects=${this.state.projects} .selected=${this.state.selectedProject} .onSelect=${(project: Project) => this.withChatScrollTransition(() => this.workspaces.selectProject(project))} .onClose=${(project: Project) => this.projects.closeProject(project.id)}></project-list>
      <workspace-list .workspaces=${this.state.workspaces} .selected=${this.state.selectedWorkspace} .workspaceLabelItems=${(workspace: Workspace) => this.plugins.getWorkspaceLabelItems(this.state, workspace)} .onSelect=${(workspace: Workspace) => openChatAfter(() => this.workspaces.selectWorkspace(workspace))}></workspace-list>
      <session-list .sessions=${this.state.sessions} .statuses=${this.state.sessionStatuses} .activities=${this.state.sessionActivities} .selected=${this.state.selectedSession} .canStart=${!!this.state.selectedWorkspace} .onStart=${() => openChatAfter(() => this.sessions.startSession())} .onSelect=${(session: SessionInfo) => openChatAfter(() => this.sessions.selectSession(session))} .onArchive=${(session: SessionInfo) => this.sessions.archiveSession(session)} .onRestore=${(session: SessionInfo) => openChatAfter(() => this.sessions.restoreSession(session))} .onDetachParent=${(session: SessionInfo) => this.sessions.detachParent(session)}></session-list>
    `;
  }

  private visibleWorkspacePanels(): QualifiedWorkspacePanelContribution[] {
    const workspace = this.state.selectedWorkspace;
    return this.plugins.getWorkspacePanels().filter((panel) => workspace === undefined || (panel.visible?.(workspace) ?? true));
  }

  private renderMobilePanelTitle(panel: QualifiedWorkspacePanelContribution) {
    const workspace = this.state.selectedWorkspace;
    if (workspace === undefined) return panel.title;
    const badge = panel.badge?.(this.createWorkspacePanelContext(workspace));
    if (badge === undefined || badge === "") return panel.title;
    return html`${panel.title} <span class="tab-badge">${badge}</span>`;
  }

  private createWorkspacePanelContext(workspace: Workspace): WorkspacePanelContext {
    return {
      workspace,
      fileTree: this.state.fileTree,
      expandedDirs: this.state.expandedDirs,
      selectedFilePath: this.state.selectedFilePath,
      selectedFileContent: this.state.selectedFileContent,
      fileTreeStale: this.state.fileTreeStale,
      gitStatus: this.state.gitStatus,
      selectedDiffPath: this.state.selectedDiffPath,
      selectedDiff: this.state.selectedDiff,
      selectedStagedDiff: this.state.selectedStagedDiff,
      gitStale: this.state.gitStale,
      activeTerminalCount: this.state.activeTerminalCount,
      terminalAutoStart: this.terminalAutoStartWorkspaceId === workspace.id,
      onRefreshFiles: () => { void this.files.refreshFiles(); },
      onExpandDir: (path: string) => { void this.files.expandDir(path); },
      onSelectFile: (path: string) => { void this.files.selectFile(path); },
      onRefreshGit: () => { void this.git.refreshGit(); },
      onSelectDiff: (path: string) => { void this.git.selectDiff(path); },
    };
  }

  private getActions(): AppAction[] {
    return this.plugins.getActions(this.createPluginRuntimeContext());
  }

  private async loadExternalPlugins(): Promise<void> {
    try {
      for (const plugin of await loadExternalPlugins()) this.plugins.register(plugin);
      this.requestUpdate();
    } catch (error) {
      console.warn("Failed to load external Pi Web plugins", error);
    }
  }

  private createPluginRuntimeContext(): PluginRuntimeContext {
    return {
      state: this.state,
      openActionPalette: () => { this.setState({ actionPaletteOpen: true }); },
      focusPrompt: () => { this.promptEditor?.focusInput(); },
      addProject: () => { this.setState({ projectDialogOpen: true }); },
      selectMainView: (view) => { this.selectMainView(view); },
      selectWorkspaceTool: (tool) => { this.openWorkspaceTool(tool); },
      refreshFiles: () => this.files.refreshFiles(),
      refreshGit: () => this.git.refreshGit(),
      startSession: () => this.withChatScrollTransition(() => this.sessions.startSession()),
      archiveSession: () => this.sessions.archiveSession(),
      stopActiveWork: () => this.sessions.stopActiveWork(),
    };
  }

  private runAction(actionId: string) {
    const action = this.getActions().find((candidate) => candidate.id === actionId && candidate.enabled !== false);
    if (action !== undefined) void action.run();
  }

  private async openModelDialog() {
    const models = await this.sessions.listModels();
    const currentProvider = this.state.status?.model?.provider;
    const currentId = this.state.status?.model?.id;
    this.setState({
      modelDialog: {
        title: "Select Model",
        ...(currentProvider !== undefined && currentId !== undefined ? { selectedValue: `${currentProvider}/${currentId}` } : {}),
        options: models.map((model) => {
          const provider = model.provider ?? "";
          const id = model.id ?? "";
          const isCurrent = provider === currentProvider && id === currentId;
          return { value: `${provider}/${id}`, label: `${id}${isCurrent ? " ✓ current" : ""}`, description: provider };
        }),
      },
    });
  }

  private async pickModel(value: string) {
    this.setState({ modelDialog: undefined });
    const slash = value.indexOf("/");
    if (slash <= 0) return;
    await this.sessions.setModel(value.slice(0, slash), value.slice(slash + 1));
  }

  private async openThinkingDialog() {
    const levels = await this.sessions.listThinkingLevels();
    const current = this.state.status?.thinkingLevel ?? "off";
    this.setState({
      thinkingDialog: {
        title: "Select Thinking Level",
        selectedValue: current,
        options: levels.map((level) => ({ value: level, label: `${level}${level === current ? " ✓ current" : ""}`, description: thinkingDescription(level) })),
      },
    });
  }

  private async pickThinking(value: string) {
    this.setState({ thinkingDialog: undefined });
    if (isThinkingLevel(value)) await this.sessions.setThinkingLevel(value);
  }

  override render() {
    const state = this.state;
    return html`
      <div class=${`shell ${state.mainView === "navigation" ? "navigation-view" : state.mainView === "chat" ? "chat-view" : "workspace-view"}`}>
        <aside>${this.renderNavigationPanel(false)}</aside>
        <main class=${state.mainView === "chat" ? "chat-view" : state.mainView === "navigation" ? "navigation-view" : "workspace-view"}>
          <div class="mobile-tabs">
            <button class=${state.mainView === "navigation" ? "mobile-navigation-tab selected" : "mobile-navigation-tab"} @click=${() => { this.selectMainView("navigation"); }}>Sessions</button>
            <button class=${state.mainView === "chat" ? "selected" : ""} @click=${() => { this.selectMainView("chat"); }}>Chat</button>
            ${this.visibleWorkspacePanels().map((panel) => html`
              <button class=${state.mainView === panel.id ? "selected" : ""} @click=${() => { this.openWorkspaceTool(panel.id); }}>${this.renderMobilePanelTitle(panel)}</button>
            `)}
          </div>
          ${state.error ? html`<div class="error">${state.error}</div>` : null}
          <div class="mobile-navigation-panel">${this.renderNavigationPanel(true)}</div>
          ${state.selectedSession ? html`
            <chat-view .sessionId=${state.selectedSession.id} .messages=${state.messages} .messageStart=${state.messagePageStart} .messageTotal=${state.messagePageTotal} .hasMore=${state.messagePageStart > 0} .loadingMore=${state.isLoadingEarlierMessages} .isReceivingPartialStream=${state.isReceivingPartialStream} .isCompacting=${state.status?.isCompacting === true} .pendingMessageCount=${state.status?.pendingMessageCount ?? 0} .status=${state.status} .activity=${state.activity} .onLoadMore=${() => this.withChatPrependTransition(() => this.sessions.loadEarlierMessages())}></chat-view>
            <prompt-editor .sessionId=${state.selectedSession.id} .cwd=${state.selectedWorkspace?.path} .disabled=${state.selectedSession.archived === true} .canSteer=${state.status?.isStreaming === true} .isCompacting=${state.status?.isCompacting === true} .canStop=${state.status?.isStreaming === true || state.status?.isBashRunning === true || state.status?.isCompacting === true || (state.status?.pendingMessageCount ?? 0) > 0} .status=${state.status} .onSend=${(text: string, streamingBehavior?: "steer" | "followUp") => this.sessions.send(text, streamingBehavior)} .onStop=${() => this.sessions.stopActiveWork()} .onSelectModel=${() => { void this.openModelDialog(); }} .onSelectThinking=${() => { void this.openThinkingDialog(); }}></prompt-editor>
            <status-bar .status=${state.status} .workspace=${state.selectedWorkspace} .workspaceLabelItems=${state.selectedWorkspace === undefined ? [] : this.plugins.getWorkspaceLabelItems(state, state.selectedWorkspace)}></status-bar>
            ${state.commandDialog !== undefined ? html`<command-picker .title=${state.commandDialog.title} .options=${state.commandDialog.options} .onPick=${(value: string) => this.sessions.respondToCommand(state.commandDialog?.requestId ?? "", value)} .onCancel=${() => { this.sessions.cancelCommand(); }}></command-picker>` : null}
            ${state.modelDialog !== undefined ? html`<command-picker title=${state.modelDialog.title} .searchable=${true} .options=${state.modelDialog.options} .selectedValue=${state.modelDialog.selectedValue} .onPick=${(value: string) => { void this.pickModel(value); }} .onCancel=${() => { this.setState({ modelDialog: undefined }); }}></command-picker>` : null}
            ${state.thinkingDialog !== undefined ? html`<command-picker title=${state.thinkingDialog.title} .options=${state.thinkingDialog.options} .selectedValue=${state.thinkingDialog.selectedValue} .onPick=${(value: string) => { void this.pickThinking(value); }} .onCancel=${() => { this.setState({ thinkingDialog: undefined }); }}></command-picker>` : null}
          ` : html`<div class="empty">Select or start a session.</div>`}
        </main>
        ${this.renderWorkspacePanel()}
        ${state.actionPaletteOpen ? html`<action-palette .actions=${this.getActions()} .onRun=${(actionId: string) => { this.setState({ actionPaletteOpen: false }); this.runAction(actionId); }} .onCancel=${() => { this.setState({ actionPaletteOpen: false }); }}></action-palette>` : null}
        ${state.projectDialogOpen ? html`<project-dialog .onSubmit=${(path: string, create: boolean) => this.projects.addProject(path, create)} .onCancel=${() => { this.setState({ projectDialogOpen: false }); }}></project-dialog>` : null}
      </div>
    `;
  }

  static override styles = appStyles;
}

function createPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register(corePlugin);
  return registry;
}

function isActive(status: AppState["status"]): boolean {
  return status?.isStreaming === true || status?.isBashRunning === true || status?.isCompacting === true;
}

function isTerminalEvent(event: RealtimeEvent): event is TerminalUiEvent {
  return event.type === "terminal.created" || event.type === "terminal.exited" || event.type === "terminal.closed";
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => { resolve(); }));
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function thinkingDescription(level: ThinkingLevel): string {
  switch (level) {
    case "off": return "No reasoning";
    case "minimal": return "Very brief reasoning (~1k tokens)";
    case "low": return "Light reasoning (~2k tokens)";
    case "medium": return "Moderate reasoning (~8k tokens)";
    case "high": return "Deep reasoning (~16k tokens)";
    case "xhigh": return "Maximum reasoning (~32k tokens)";
  }
}
