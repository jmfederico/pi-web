import { LitElement, html } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { piWebApi, terminalsApi, type Project, type RealtimeEvent, type SessionInfo, type TerminalUiEvent, type ThinkingLevel, type Workspace } from "../api";
import type { AppAction } from "../actions";
import { initialAppState, type AppState } from "../appState";
import { isSessionActive } from "../../../shared/activity";
import { ActivityController } from "../controllers/activityController";
import { AuthController } from "../controllers/authController";
import { FileExplorerController } from "../controllers/fileExplorerController";
import { GitController } from "../controllers/gitController";
import { ProjectController } from "../controllers/projectController";
import { SessionController } from "../controllers/sessionController";
import { WorkspaceController } from "../controllers/workspaceController";
import { KeyboardShortcutDispatcher } from "../keyboardShortcuts";
import { RealtimeSocket } from "../sessionSocket";
import type { QualifiedContributionId, QualifiedWorkspacePanelContribution, PluginRuntimeContext, WorkspacePanelContext } from "../plugins/types";
import { DEFAULT_THEME_ID, applyPiWebTheme, readStoredThemeId } from "../theme";
import { corePlugin } from "../plugins/core";
import { themePackPlugin } from "../plugins/themes";
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
import "./AuthDialog";
import "./ProjectDialog";
import "./WorkspacePanel";
import { appStyles } from "./shared";

type NavigationSection = "projects" | "workspaces" | "sessions";

const PI_WEB_STATUS_REFRESH_MS = 15 * 60 * 1000;

@customElement("pi-web-app")
export class PiWebApp extends LitElement {
  @state() private state: AppState = initialAppState();
  @query("chat-view") private chatView?: ChatView;
  @query("prompt-editor") private promptEditor?: PromptEditor;
  @query(".context-items") private contextItems?: HTMLElement;
  @query(".mobile-tabs") private mobileTabs?: HTMLElement;

  private readonly sessions = new SessionController(
    () => this.state,
    (patch) => { this.setState(patch); },
    () => { this.updateUrl(); },
  );
  private readonly activity = new ActivityController(
    () => this.state,
    (patch) => { this.setState(patch); },
  );
  private readonly auth = new AuthController(
    () => this.state,
    (patch) => { this.setState(patch); },
    (status) => { this.sessions.applySessionStatus(status); },
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
  private readonly mobileNavigationMedia = typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia("(max-width: 760px)") : undefined;
  private observedContextItems: HTMLElement | undefined;
  private observedMobileTabs: HTMLElement | undefined;
  private contextItemsResizeObserver: ResizeObserver | undefined;
  private mobileTabsResizeObserver: ResizeObserver | undefined;
  private terminalAutoStartWorkspaceId: string | undefined;
  private piWebStatusTimer: number | undefined;
  private readonly plugins = createPluginRegistry();
  private preferredThemeId: QualifiedContributionId = readStoredThemeId() ?? DEFAULT_THEME_ID;
  @state() private activeThemeId: QualifiedContributionId = DEFAULT_THEME_ID;
  @state() private isMobileNavigationLayout = this.mobileNavigationMedia?.matches ?? false;
  @state() private expandedMobileNavigationSection: NavigationSection | "none" | undefined;
  @state() private contextCanScrollLeft = false;
  @state() private contextCanScrollRight = false;
  @state() private mobileTabsCanScrollLeft = false;
  @state() private mobileTabsCanScrollRight = false;
  private readonly onPopState = () => void this.withChatScrollTransition(() => this.restoreRoute(false));
  private readonly onFocus = () => {
    void this.sessions.refreshSelectedSession();
    void this.refreshPiWebStatus();
    void this.refreshWorkspaceActivity();
  };
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      void this.sessions.refreshSelectedSession();
      void this.refreshPiWebStatus();
      void this.refreshWorkspaceActivity();
    }
  };
  private readonly onMobileNavigationMediaChange = (event: MediaQueryListEvent) => {
    this.isMobileNavigationLayout = event.matches;
    this.updateContextScrollState();
    this.updateMobileTabsScrollState();
  };
  private readonly onContextScroll = () => {
    this.updateContextScrollState();
  };
  private readonly onMobileTabsScroll = () => {
    this.updateMobileTabsScrollState();
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
    this.mobileNavigationMedia?.addEventListener("change", this.onMobileNavigationMediaChange);
    this.applyPreferredTheme(false);
    this.connectRealtime();
    this.piWebStatusTimer = window.setInterval(() => { void this.refreshPiWebStatus(); }, PI_WEB_STATUS_REFRESH_MS);
    void this.refreshPiWebStatus();
    void this.refreshWorkspaceActivity();
    void this.loadExternalPlugins();
    void this.loadProjectsAndRestoreRoute();
  }

  override disconnectedCallback(): void {
    window.removeEventListener("popstate", this.onPopState);
    window.removeEventListener("focus", this.onFocus);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("keydown", this.onKeyDown);
    this.mobileNavigationMedia?.removeEventListener("change", this.onMobileNavigationMediaChange);
    this.keyboard.reset();
    this.auth.dispose();
    this.sessions.dispose();
    this.realtime.close();
    this.git.dispose();
    if (this.piWebStatusTimer !== undefined) window.clearInterval(this.piWebStatusTimer);
    this.piWebStatusTimer = undefined;
    this.contextItemsResizeObserver?.disconnect();
    this.contextItemsResizeObserver = undefined;
    this.observedContextItems = undefined;
    this.mobileTabsResizeObserver?.disconnect();
    this.mobileTabsResizeObserver = undefined;
    this.observedMobileTabs = undefined;
    super.disconnectedCallback();
  }

  override firstUpdated(): void {
    this.observeContextItems();
    this.observeMobileTabs();
    this.updateContextScrollState();
    this.updateMobileTabsScrollState();
  }

  override updated(): void {
    this.observeContextItems();
    this.observeMobileTabs();
    this.updateContextScrollState();
    this.updateMobileTabsScrollState();
  }

  private setState(patch: Partial<AppState>) {
    if (!patchChangesState(this.state, patch)) return;
    const previous = this.state;
    this.state = { ...this.state, ...patch };
    this.handleActivityTransition(previous, this.state);
    this.handleWorkspaceChange(previous, this.state);
  }

  private async loadProjectsAndRestoreRoute() {
    await this.projects.loadProjects();
    await this.withChatScrollTransition(() => this.restoreRoute(false));
  }

  private async refreshPiWebStatus(): Promise<void> {
    try {
      this.setState({ piWebStatus: await piWebApi.piWebStatus() });
    } catch (error) {
      console.warn("Failed to refresh Pi Web status", error);
    }
  }

  private async refreshWorkspaceActivity(): Promise<void> {
    try {
      await this.activity.refresh();
    } catch (error) {
      console.warn("Failed to refresh workspace activity", error);
    }
  }

  private async restoreRoute(updateUrl: boolean) {
    const route = readRoute();
    const selectedFilePath = readNamespacedString(queryNamespace("core:workspace.files"), "file");
    const selectedDiffPath = readNamespacedString(queryNamespace("core:workspace.git"), "diff");
    this.setState({ workspaceTool: route.tool ?? this.state.workspaceTool, mainView: route.view ?? this.defaultRouteView(), selectedFilePath, selectedDiffPath });
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
    await action();
    await this.updateComplete;
    await this.chatView?.updateComplete;
  }

  private defaultRouteView(): AppState["mainView"] {
    return this.isMobileNavigationLayout ? "navigation" : "chat";
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
        void this.refreshWorkspaceActivity();
      },
    );
  }

  private handleRealtimeEvent(event: RealtimeEvent): void {
    if (event.type === "workspace.activity") this.activity.applyWorkspaceActivity(event.activity);
    else if (isTerminalEvent(event)) this.applyTerminalEvent(event);
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
    const wasActive = isActive(previous);
    const nowActive = isActive(next);
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
    return html`<workspace-panel .workspace=${this.state.selectedWorkspace} .appState=${this.state} .tool=${this.state.workspaceTool} .panels=${this.visibleWorkspacePanels()} .workspaceLabelItems=${workspaceLabelItems} .fileTree=${this.state.fileTree} .expandedDirs=${this.state.expandedDirs} .selectedFilePath=${this.state.selectedFilePath} .selectedFileContent=${this.state.selectedFileContent} .fileTreeStale=${this.state.fileTreeStale} .gitStatus=${this.state.gitStatus} .selectedDiffPath=${this.state.selectedDiffPath} .selectedDiff=${this.state.selectedDiff} .selectedStagedDiff=${this.state.selectedStagedDiff} .gitStale=${this.state.gitStale} .activeTerminalCount=${this.state.activeTerminalCount} .terminalAutoStart=${this.terminalAutoStartWorkspaceId === this.state.selectedWorkspace?.id} .onSelectTool=${(tool: QualifiedContributionId) => { this.openWorkspaceTool(tool); }} .onRefreshFiles=${() => this.files.refreshFiles()} .onExpandDir=${(path: string) => this.files.expandDir(path)} .onSelectFile=${(path: string) => this.files.selectFile(path)} .onRefreshGit=${() => this.git.refreshGit()} .onSelectDiff=${(path: string) => this.git.selectDiff(path)}></workspace-panel>`;
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
      <project-list
        .projects=${this.state.projects}
        .selected=${this.state.selectedProject}
        .activities=${this.state.workspaceActivities}
        .workspacesByProjectId=${this.state.workspacesByProjectId}
        .collapsible=${this.isMobileNavigationLayout}
        .collapsed=${this.isNavigationSectionCollapsed("projects")}
        .onToggleCollapsed=${() => { this.toggleNavigationSection("projects"); }}
        .onSelect=${(project: Project) => this.withChatScrollTransition(async () => {
          this.expandNavigationSection("workspaces");
          await this.workspaces.selectProject(project);
        })}
        .onClose=${(project: Project) => this.projects.closeProject(project.id)}
      ></project-list>
      <workspace-list
        .workspaces=${this.state.workspaces}
        .selected=${this.state.selectedWorkspace}
        .activities=${this.state.workspaceActivities}
        .collapsible=${this.isMobileNavigationLayout}
        .collapsed=${this.isNavigationSectionCollapsed("workspaces")}
        .workspaceLabelItems=${(workspace: Workspace) => this.plugins.getWorkspaceLabelItems(this.state, workspace)}
        .onToggleCollapsed=${() => { this.toggleNavigationSection("workspaces"); }}
        .onSelect=${(workspace: Workspace) => this.withChatScrollTransition(async () => {
          this.expandNavigationSection("sessions");
          await this.workspaces.selectWorkspace(workspace);
        })}
      ></workspace-list>
      <session-list
        .sessions=${this.state.sessions}
        .statuses=${this.state.sessionStatuses}
        .activities=${this.state.sessionActivities}
        .selected=${this.state.selectedSession}
        .canStart=${!!this.state.selectedWorkspace}
        .collapsible=${this.isMobileNavigationLayout}
        .collapsed=${this.isNavigationSectionCollapsed("sessions")}
        .onToggleCollapsed=${() => { this.toggleNavigationSection("sessions"); }}
        .onStart=${() => openChatAfter(() => this.sessions.startSession())}
        .onSelect=${(session: SessionInfo) => openChatAfter(() => this.sessions.selectSession(session))}
        .onArchive=${(session: SessionInfo) => this.sessions.archiveSession(session)}
        .onRestore=${(session: SessionInfo) => openChatAfter(() => this.sessions.restoreSession(session))}
        .onDelete=${(session: SessionInfo) => this.sessions.deleteCachedNewSession(session)}
        .onDetachParent=${(session: SessionInfo) => this.sessions.detachParent(session)}
      ></session-list>
    `;
  }

  private expandedNavigationSection(): NavigationSection | undefined {
    if (this.expandedMobileNavigationSection === "none") return undefined;
    return this.expandedMobileNavigationSection ?? this.defaultNavigationSection();
  }

  private defaultNavigationSection(): NavigationSection {
    if (this.state.selectedProject === undefined) return "projects";
    if (this.state.selectedWorkspace === undefined) return "workspaces";
    return "sessions";
  }

  private isNavigationSectionCollapsed(section: NavigationSection): boolean {
    return this.isMobileNavigationLayout && this.expandedNavigationSection() !== section;
  }

  private toggleNavigationSection(section: NavigationSection): void {
    if (!this.isMobileNavigationLayout) return;
    this.expandedMobileNavigationSection = this.expandedNavigationSection() === section ? "none" : section;
  }

  private expandNavigationSection(section: NavigationSection): void {
    if (this.isMobileNavigationLayout) this.expandedMobileNavigationSection = section;
  }

  private visibleWorkspacePanels(): QualifiedWorkspacePanelContribution[] {
    const workspace = this.state.selectedWorkspace;
    if (workspace === undefined) return [];
    return this.plugins.getWorkspacePanels().filter((panel) => panel.visible?.({ workspace, state: this.state }) ?? true);
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
      state: this.state,
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
      for (const registration of await loadExternalPlugins()) this.plugins.register(registration);
      this.applyPreferredTheme(false);
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
      configureAuth: () => this.auth.openLogin(),
      logoutAuth: () => this.auth.openLogout(),
      openThemePicker: () => { this.openThemeDialog(); },
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

  private openThemeDialog() {
    const themes = this.plugins.getThemes();
    this.setState({
      themeDialog: {
        title: "Select Theme",
        selectedValue: this.activeThemeId,
        options: themes.map((theme) => ({
          value: theme.id,
          label: `${theme.name}${theme.id === this.activeThemeId ? " ✓ current" : ""}`,
          description: theme.description === undefined ? theme.colorScheme : `${theme.colorScheme} · ${theme.description}`,
        })),
      },
    });
  }

  private pickTheme(value: string) {
    const theme = this.plugins.getThemes().find((candidate) => candidate.id === value);
    this.setState({ themeDialog: undefined });
    if (theme === undefined) return;
    this.preferredThemeId = theme.id;
    this.activeThemeId = theme.id;
    applyPiWebTheme(theme);
  }

  private applyPreferredTheme(persist: boolean): void {
    const themes = this.plugins.getThemes();
    const theme = themes.find((candidate) => candidate.id === this.preferredThemeId)
      ?? themes.find((candidate) => candidate.id === DEFAULT_THEME_ID)
      ?? themes[0];
    if (theme === undefined) return;
    this.activeThemeId = theme.id;
    applyPiWebTheme(theme, { persist });
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

  private sendPrompt(text: string, streamingBehavior?: "steer" | "followUp"): void {
    if (streamingBehavior === undefined && this.auth.handleSlashCommand(text)) return;
    void this.sessions.send(text, streamingBehavior);
  }

  private renderContextBar() {
    const project = this.state.selectedProject;
    const workspace = this.state.selectedWorkspace;
    const session = this.state.selectedSession;
    const projectLabel = projectContextLabel(project);
    const workspaceLabel = workspaceContextLabel(workspace);
    const sessionLabel = sessionContextLabel(session);
    return html`
      <nav class=${this.contextBarClass()} aria-label="Current location">
        <span class="context-bar-label">Location</span>
        <ol class="context-items" @scroll=${this.onContextScroll}>
          <li class=${project === undefined ? "context-chip empty" : "context-chip"} title=${projectContextTitle(project)} aria-label=${`Project: ${projectLabel}`}>
            <span class="context-kind">Project</span>
            <span class="context-value">${projectLabel}</span>
          </li>
          <li class=${workspace === undefined ? "context-chip empty" : "context-chip"} title=${workspaceContextTitle(workspace)} aria-label=${`Workspace: ${workspaceLabel}`}>
            <span class="context-kind">Workspace</span>
            <span class="context-value">${workspaceLabel}</span>
          </li>
          <li class=${session === undefined ? "context-chip empty" : "context-chip"} title=${sessionContextTitle(session)} aria-label=${`Session: ${sessionLabel}`}>
            <span class="context-kind">Session</span>
            <span class="context-value">${sessionLabel}</span>
          </li>
        </ol>
      </nav>
    `;
  }

  private contextBarClass(): string {
    return `context-bar${this.contextCanScrollLeft ? " can-scroll-left" : ""}${this.contextCanScrollRight ? " can-scroll-right" : ""}`;
  }

  private mobileTabsFrameClass(): string {
    return `mobile-tabs-frame${this.mobileTabsCanScrollLeft ? " can-scroll-left" : ""}${this.mobileTabsCanScrollRight ? " can-scroll-right" : ""}`;
  }

  private observeContextItems(): void {
    const contextItems = this.contextItems;
    if (this.observedContextItems === contextItems) return;
    this.contextItemsResizeObserver?.disconnect();
    this.observedContextItems = contextItems;
    this.contextItemsResizeObserver = undefined;
    if (contextItems === undefined || typeof ResizeObserver === "undefined") return;
    this.contextItemsResizeObserver = new ResizeObserver(() => {
      this.updateContextScrollState();
    });
    this.contextItemsResizeObserver.observe(contextItems);
  }

  private updateContextScrollState(): void {
    const contextItems = this.contextItems;
    const maxScrollLeft = contextItems === undefined ? 0 : Math.max(0, contextItems.scrollWidth - contextItems.clientWidth);
    const canScrollLeft = contextItems !== undefined && contextItems.scrollLeft > 1;
    const canScrollRight = contextItems !== undefined && maxScrollLeft - contextItems.scrollLeft > 1;
    if (this.contextCanScrollLeft !== canScrollLeft) this.contextCanScrollLeft = canScrollLeft;
    if (this.contextCanScrollRight !== canScrollRight) this.contextCanScrollRight = canScrollRight;
  }

  private observeMobileTabs(): void {
    const mobileTabs = this.mobileTabs;
    if (this.observedMobileTabs === mobileTabs) return;
    this.mobileTabsResizeObserver?.disconnect();
    this.observedMobileTabs = mobileTabs;
    this.mobileTabsResizeObserver = undefined;
    if (mobileTabs === undefined || typeof ResizeObserver === "undefined") return;
    this.mobileTabsResizeObserver = new ResizeObserver(() => {
      this.updateMobileTabsScrollState();
    });
    this.mobileTabsResizeObserver.observe(mobileTabs);
  }

  private updateMobileTabsScrollState(): void {
    const mobileTabs = this.mobileTabs;
    const maxScrollLeft = mobileTabs === undefined ? 0 : Math.max(0, mobileTabs.scrollWidth - mobileTabs.clientWidth);
    const canScrollLeft = mobileTabs !== undefined && mobileTabs.scrollLeft > 1;
    const canScrollRight = mobileTabs !== undefined && maxScrollLeft - mobileTabs.scrollLeft > 1;
    if (this.mobileTabsCanScrollLeft !== canScrollLeft) this.mobileTabsCanScrollLeft = canScrollLeft;
    if (this.mobileTabsCanScrollRight !== canScrollRight) this.mobileTabsCanScrollRight = canScrollRight;
  }

  override render() {
    const state = this.state;
    return html`
      <div class=${`shell ${state.mainView === "navigation" ? "navigation-view" : state.mainView === "chat" ? "chat-view" : "workspace-view"}`}>
        <aside>${this.isMobileNavigationLayout ? null : this.renderNavigationPanel(false)}</aside>
        <main class=${state.mainView === "chat" ? "chat-view" : state.mainView === "navigation" ? "navigation-view" : "workspace-view"}>
          ${this.renderContextBar()}
          <div class=${this.mobileTabsFrameClass()}>
            <div class="mobile-tabs" @scroll=${this.onMobileTabsScroll}>
              <button class=${state.mainView === "navigation" ? "mobile-navigation-tab selected" : "mobile-navigation-tab"} @click=${() => { this.selectMainView("navigation"); }}>Sessions</button>
              <button class=${state.mainView === "chat" ? "selected" : ""} @click=${() => { this.selectMainView("chat"); }}>Chat</button>
              ${this.visibleWorkspacePanels().map((panel) => html`
                <button class=${state.mainView === panel.id ? "selected" : ""} @click=${() => { this.openWorkspaceTool(panel.id); }}>${this.renderMobilePanelTitle(panel)}</button>
              `)}
            </div>
          </div>
          ${state.error ? html`<div class="error">${state.error}</div>` : null}
          <div class="mobile-navigation-panel">${this.isMobileNavigationLayout ? this.renderNavigationPanel(true) : null}</div>
          ${state.selectedSession ? html`
            <chat-view .sessionId=${state.selectedSession.id} .messages=${state.messages} .messageStart=${state.messagePageStart} .messageTotal=${state.messagePageTotal} .hasMore=${state.messagePageStart > 0} .loadingMore=${state.isLoadingEarlierMessages} .isReceivingPartialStream=${state.isReceivingPartialStream} .isCompacting=${state.status?.isCompacting === true} .pendingMessageCount=${state.status?.pendingMessageCount ?? 0} .status=${state.status} .activity=${state.activity} .onLoadMore=${() => this.withChatPrependTransition(() => this.sessions.loadEarlierMessages())}></chat-view>
            <prompt-editor .sessionId=${state.selectedSession.id} .cwd=${state.selectedWorkspace?.path} .disabled=${state.selectedSession.archived === true} .canSteer=${state.status?.isStreaming === true} .isCompacting=${state.status?.isCompacting === true} .canStop=${state.status?.isStreaming === true || state.status?.isBashRunning === true || state.status?.isCompacting === true || (state.status?.pendingMessageCount ?? 0) > 0} .status=${state.status} .onSend=${(text: string, streamingBehavior?: "steer" | "followUp") => { this.sendPrompt(text, streamingBehavior); }} .onStop=${() => this.sessions.stopActiveWork()} .onSelectModel=${() => { void this.openModelDialog(); }} .onSelectThinking=${() => { void this.openThinkingDialog(); }}></prompt-editor>
            <status-bar .status=${state.status} .workspace=${state.selectedWorkspace} .workspaceLabelItems=${state.selectedWorkspace === undefined ? [] : this.plugins.getWorkspaceLabelItems(state, state.selectedWorkspace)}></status-bar>
            ${state.commandDialog !== undefined ? html`<command-picker .title=${state.commandDialog.title} .options=${state.commandDialog.options} .onPick=${(value: string) => this.sessions.respondToCommand(state.commandDialog?.requestId ?? "", value)} .onCancel=${() => { this.sessions.cancelCommand(); }}></command-picker>` : null}
            ${state.modelDialog !== undefined ? html`<command-picker title=${state.modelDialog.title} .searchable=${true} .options=${state.modelDialog.options} .selectedValue=${state.modelDialog.selectedValue} .onPick=${(value: string) => { void this.pickModel(value); }} .onCancel=${() => { this.setState({ modelDialog: undefined }); }}></command-picker>` : null}
            ${state.thinkingDialog !== undefined ? html`<command-picker title=${state.thinkingDialog.title} .options=${state.thinkingDialog.options} .selectedValue=${state.thinkingDialog.selectedValue} .onPick=${(value: string) => { void this.pickThinking(value); }} .onCancel=${() => { this.setState({ thinkingDialog: undefined }); }}></command-picker>` : null}
            ${state.authDialog !== undefined ? html`<auth-dialog .state=${state.authDialog} .onChooseMethod=${(authType: "oauth" | "api_key") => { void this.auth.chooseLoginMethod(authType); }} .onSelectProvider=${(providerId: string, authType: "oauth" | "api_key") => { void this.auth.selectLoginProvider(providerId, authType); }} .onApiKeyInput=${(value: string) => { this.auth.updateApiKey(value); }} .onSaveApiKey=${() => { void this.auth.saveApiKey(); }} .onLogoutProvider=${(providerId: string) => { void this.auth.logoutProvider(providerId); }} .onOAuthInput=${(value: string) => { this.auth.updateOAuthInput(value); }} .onOAuthRespond=${(value?: string) => { void this.auth.respondOAuth(value); }} .onOAuthCancel=${() => { void this.auth.cancelOAuth(); }} .onCancel=${() => { this.auth.closeDialog(); }}></auth-dialog>` : null}
          ` : html`<div class="empty">Select or start a session.</div>`}
        </main>
        ${this.renderWorkspacePanel()}
        ${state.actionPaletteOpen ? html`<action-palette .actions=${this.getActions()} .onRun=${(actionId: string) => { this.setState({ actionPaletteOpen: false }); this.runAction(actionId); }} .onCancel=${() => { this.setState({ actionPaletteOpen: false }); }}></action-palette>` : null}
        ${state.projectDialogOpen ? html`<project-dialog .onSubmit=${(path: string, create: boolean) => this.projects.addProject(path, create)} .onCancel=${() => { this.setState({ projectDialogOpen: false }); }}></project-dialog>` : null}
        ${state.themeDialog !== undefined ? html`<command-picker title=${state.themeDialog.title} .options=${state.themeDialog.options} .selectedValue=${state.themeDialog.selectedValue} .onPick=${(value: string) => { this.pickTheme(value); }} .onCancel=${() => { this.setState({ themeDialog: undefined }); }}></command-picker>` : null}
      </div>
    `;
  }

  static override styles = appStyles;
}

function createPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register({ id: "core", plugin: corePlugin });
  registry.register({ id: "themes", plugin: themePackPlugin });
  return registry;
}

function projectContextLabel(project: Project | undefined): string {
  return project?.name ?? "No project";
}

function projectContextTitle(project: Project | undefined): string {
  return project === undefined ? "No project selected" : `${project.name} — ${project.path}`;
}

function workspaceContextLabel(workspace: Workspace | undefined): string {
  return workspace === undefined ? "No workspace" : `${workspace.label}${workspace.isMain ? " · main" : ""} · ${workspace.path}`;
}

function workspaceContextTitle(workspace: Workspace | undefined): string {
  return workspace === undefined ? "No workspace selected" : `${workspace.label}${workspace.isMain ? " · main" : ""} — ${workspace.path}`;
}

function sessionContextLabel(session: SessionInfo | undefined): string {
  const name = session?.name?.trim();
  const firstMessage = session?.firstMessage.trim();
  return name !== undefined && name !== "" ? name : firstMessage !== undefined && firstMessage !== "" ? firstMessage : session?.id.slice(0, 8) ?? "No session";
}

function sessionContextTitle(session: SessionInfo | undefined): string {
  return session === undefined ? "No session selected" : session.path;
}

function patchChangesState(state: AppState, patch: Partial<AppState>): boolean {
  return Object.entries(patch).some(([key, value]) => Reflect.get(state, key) !== value);
}

function isActive(state: Pick<AppState, "status" | "activity">): boolean {
  return isSessionActive(state.status, state.activity);
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
