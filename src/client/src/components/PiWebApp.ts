import { LitElement, html } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { piWebApi, terminalsApi, type Machine, type Project, type RealtimeEvent, type SessionInfo, type TerminalCommandRun, type TerminalUiEvent, type ThinkingLevel, type Workspace } from "../api";
import type { AppAction } from "../actions";
import { initialAppState, type AppState } from "../appState";
import { isSessionActive } from "../../../shared/activity";
import { ActivityController } from "../controllers/activityController";
import { AuthController } from "../controllers/authController";
import { FileExplorerController } from "../controllers/fileExplorerController";
import { GitController } from "../controllers/gitController";
import { MachineController } from "../controllers/machineController";
import { ProjectController } from "../controllers/projectController";
import { SessionController } from "../controllers/sessionController";
import { WorkspaceController, canDeleteWorkspace } from "../controllers/workspaceController";
import { InMemoryTerminalSelectionMemory } from "../controllers/terminalSelection";
import { KeyboardShortcutDispatcher } from "../keyboardShortcuts";
import { selectedMachineId } from "../controllers/types";
import { RealtimeSocket } from "../sessionSocket";
import type { QualifiedContributionId, QualifiedThemeContribution, QualifiedThemePairContribution, QualifiedWorkspacePanelContribution, PluginRuntimeContext, TerminalCommandRunsInternalRuntime, WorkspacePanelContext } from "../plugins/types";
import { CLASSIC_THEME_ID, DEFAULT_THEME_PREFERENCE, applyPiWebTheme, findThemePairForTheme, readStoredThemePreference, resolveThemePreference, writeStoredThemePreference, type ThemePreference, type ThemePreferenceResolution } from "../theme";
import { corePlugin } from "../plugins/core";
import { themePackPlugin } from "../plugins/themes";
import { loadExternalPlugins } from "../plugins/external";
import { PluginRegistry, installPluginRuntimeScope, installWorkspacePanelScope } from "../plugins/registry";
import { queryNamespace, readNamespacedString, setNamespacedQueryKey } from "../namespacedQueryArgs";
import { AppShellController } from "../appShell/appShellController";
import { MobileNavigationController, type NavigationSection } from "../appShell/navigationState";
import { PanelCollapseController, mainViewClass } from "../appShell/panelCollapseController";
import { readRoute, writeRoute, type AppRoute } from "../route";
import { createTerminalCommandRunsRuntime } from "../runtime/terminalRuntime";
import { isWorkspaceDeletionPending, isWorkspaceDeletionRunPending, latestWorkspaceDeletionRuns, pendingWorkspaceDeletionIds, targetWorkspaceIdForRun, workspaceDeletionMetadata, workspaceDeletionRunFilter } from "../workspaceDeletion";
import "./MachineList";
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
import type { WorkspacePanelEmptyState } from "./WorkspacePanel";
import "./appShell/AppContextBar";
import "./appShell/AppMobileMainTabs";
import type { AppMobileMainTab } from "./appShell/AppMobileMainTabs";
import "./appShell/AppNavigationPanel";
import "./appShell/AppPanelEdgeControl";
import "./appShell/AppRefreshControl";
import { appStyles } from "./shared";


const PI_WEB_STATUS_REFRESH_MS = 15 * 60 * 1000;
const GLOBAL_SHORTCUT_LISTENER_OPTIONS = { capture: true } as const;
const THEME_AUTO_ON_VALUE = "auto:on";
const THEME_AUTO_OFF_VALUE = "auto:off";
const THEME_OPTION_PREFIX = "theme:";
const TERMINAL_ROUTE_NAMESPACE = queryNamespace("core:workspace.terminal");

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
  private readonly machines = new MachineController(
    () => this.state,
    (patch) => { this.setState(patch); },
    () => { this.updateUrl(); },
    this.projects,
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
  private readonly terminalSelection = new InMemoryTerminalSelectionMemory();
  private readonly appShell = new AppShellController(this);
  private readonly panelCollapse = new PanelCollapseController(this);
  private readonly mobileNavigation = new MobileNavigationController(
    this,
    () => this.state,
    () => this.appShell.isMobileNavigationLayout,
  );
  private readonly systemLightThemeMedia = typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia("(prefers-color-scheme: light)") : undefined;
  private terminalAutoStartWorkspaceId: string | undefined;
  private piWebStatusTimer: number | undefined;
  private workspaceDeletionPollTimer: number | undefined;
  private refreshingWorkspaceDeletionRuns = false;
  private readonly handledWorkspaceDeletionRunIds = new Set<string>();
  private readonly terminalCommandRunRuntimes = new Map<string, TerminalCommandRunsInternalRuntime>();
  private routeRestoreInProgress = false;
  private restoringRouteTerminalId: string | undefined;
  private readonly plugins = createPluginRegistry();
  private themePreference: ThemePreference = readStoredThemePreference() ?? DEFAULT_THEME_PREFERENCE;
  @state() private activeThemeId: QualifiedContributionId = CLASSIC_THEME_ID;
  @state() private isRefreshingApp = false;
  private readonly onPopState = () => void this.withChatScrollTransition(() => this.restoreRoute(false));
  private readonly onPageShow = () => {
    this.appShell.repairViewportPosition();
  };
  private readonly onFocus = () => {
    this.appShell.repairViewportPosition();
    void this.sessions.refreshSelectedSession();
    void this.refreshPiWebStatus();
    void this.refreshWorkspaceActivity();
    void this.refreshWorkspaceDeletionRuns();
  };
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      this.appShell.repairViewportPosition();
      void this.sessions.refreshSelectedSession();
      void this.refreshPiWebStatus();
      void this.refreshWorkspaceActivity();
      void this.refreshWorkspaceDeletionRuns();
    }
  };
  private readonly onSystemLightThemeChange = () => {
    if (this.themePreference.auto) this.applyPreferredTheme(false);
  };
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (this.keyboard.handle(event, this.getActions())) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  protected override willUpdate(): void {
    this.toggleAttribute("pwa-display-mode", this.appShell.isPwaDisplayMode);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("popstate", this.onPopState);
    window.addEventListener("pageshow", this.onPageShow);
    window.addEventListener("focus", this.onFocus);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("keydown", this.onKeyDown, GLOBAL_SHORTCUT_LISTENER_OPTIONS);
    this.systemLightThemeMedia?.addEventListener("change", this.onSystemLightThemeChange);
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
    window.removeEventListener("pageshow", this.onPageShow);
    window.removeEventListener("focus", this.onFocus);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("keydown", this.onKeyDown, GLOBAL_SHORTCUT_LISTENER_OPTIONS);
    this.systemLightThemeMedia?.removeEventListener("change", this.onSystemLightThemeChange);
    this.keyboard.reset();
    this.auth.dispose();
    this.sessions.dispose();
    this.realtime.close();
    this.git.dispose();
    if (this.piWebStatusTimer !== undefined) window.clearInterval(this.piWebStatusTimer);
    this.piWebStatusTimer = undefined;
    if (this.workspaceDeletionPollTimer !== undefined) window.clearInterval(this.workspaceDeletionPollTimer);
    this.workspaceDeletionPollTimer = undefined;
    super.disconnectedCallback();
  }

  private setState(patch: Partial<AppState>) {
    if (!patchChangesState(this.state, patch)) return;
    const previous = this.state;
    this.state = { ...this.state, ...patch };
    this.handleActivityTransition(previous, this.state);
    this.handleWorkspaceChange(previous, this.state);
  }

  private async loadProjectsAndRestoreRoute() {
    const route = readRoute();
    await this.machines.loadMachines(route.machineId);
    await this.projects.loadProjects();
    await this.withChatScrollTransition(() => this.restoreRoute(false));
    await this.refreshWorkspaceDeletionRuns();
  }

  private async refreshPiWebStatus(): Promise<void> {
    try {
      this.setState({ piWebStatus: await piWebApi.piWebStatus() });
    } catch (error) {
      console.warn("Failed to refresh PI WEB status", error);
    }
  }

  private async refreshWorkspaceActivity(): Promise<void> {
    try {
      await this.activity.refresh();
    } catch (error) {
      console.warn("Failed to refresh workspace activity", error);
    }
  }

  private async refreshAppData(): Promise<void> {
    if (this.isRefreshingApp) return;
    this.isRefreshingApp = true;
    try {
      await Promise.all([
        this.sessions.refreshSelectedSession(),
        this.refreshPiWebStatus(),
        this.refreshWorkspaceActivity(),
        this.refreshWorkspaceDeletionRuns(),
        this.refreshCurrentWorkspaceSurface(),
      ]);
    } finally {
      this.isRefreshingApp = false;
    }
  }

  private async refreshCurrentWorkspaceSurface(): Promise<void> {
    const workspace = this.state.selectedWorkspace;
    const tool = this.state.mainView !== "chat" && this.state.mainView !== "navigation" ? this.state.mainView : this.state.workspaceTool;
    if (tool === "core:workspace.files") await this.files.refreshFiles();
    else if (tool === "core:workspace.git") await this.git.refreshGit();
    else if (tool === "core:workspace.terminal" && workspace !== undefined) await this.refreshActiveTerminals(workspace);
  }

  private hardReloadApp(): void {
    window.location.reload();
  }

  private async restoreRoute(updateUrl: boolean) {
    const route = readRoute();
    await this.restoreRouteMachine(route, updateUrl);
    const selectedFilePath = readNamespacedString(queryNamespace("core:workspace.files"), "file");
    const selectedDiffPath = readNamespacedString(queryNamespace("core:workspace.git"), "diff");
    const selectedTerminalId = readNamespacedString(TERMINAL_ROUTE_NAMESPACE, "terminal");
    this.routeRestoreInProgress = true;
    this.restoringRouteTerminalId = selectedTerminalId;
    try {
      this.setState({ workspaceTool: route.tool ?? this.state.workspaceTool, mainView: route.view ?? this.defaultRouteView(), selectedFilePath, selectedDiffPath, selectedTerminalId });
      if (route.projectId === undefined || route.projectId === "") return;
      if (this.routeMatchesCurrentSelection(route)) {
        if (selectedTerminalId !== undefined) this.rememberSelectedTerminal(selectedTerminalId);
        await this.refreshRestoredWorkspaceTool(route.tool, selectedFilePath);
        this.git.updatePolling();
        return;
      }
      const project = this.state.projects.find((p) => p.id === route.projectId);
      if (!project) return;
      await this.workspaces.selectProject(project, { workspaceId: route.workspaceId, sessionId: route.sessionId, updateUrl });
      this.setState({ selectedFilePath, selectedDiffPath, selectedTerminalId });
      if (selectedTerminalId !== undefined) this.rememberSelectedTerminal(selectedTerminalId);
      await this.refreshRestoredWorkspaceTool(route.tool, selectedFilePath);
      this.git.updatePolling();
    } finally {
      this.routeRestoreInProgress = false;
      this.restoringRouteTerminalId = undefined;
    }
  }

  private async restoreRouteMachine(route: AppRoute, updateUrl: boolean): Promise<void> {
    const routeMachineId = route.machineId ?? "local";
    if (this.state.selectedMachine?.id === routeMachineId) return;
    const machine = this.state.machines.find((candidate) => candidate.id === routeMachineId);
    if (machine === undefined) return;
    await this.machines.selectMachine(machine, { updateUrl });
  }

  private routeMatchesCurrentSelection(route: AppRoute): boolean {
    return (route.machineId ?? "local") === (this.state.selectedMachine?.id ?? "local")
      && route.workspaceId !== undefined
      && route.workspaceId !== ""
      && this.state.selectedProject?.id === route.projectId
      && this.state.selectedWorkspace?.id === route.workspaceId
      && this.state.selectedSession?.id === route.sessionId;
  }

  private async refreshRestoredWorkspaceTool(tool: QualifiedContributionId | undefined, selectedFilePath: string | undefined): Promise<void> {
    if (tool === "core:workspace.files") await this.files.refreshFiles();
    if (tool === "core:workspace.files" && selectedFilePath !== undefined) await this.files.restoreFile(selectedFilePath);
    if (tool === "core:workspace.git") await this.git.refreshGit();
  }

  private async withChatScrollTransition(action: () => Promise<void>) {
    this.chatView?.saveScrollPosition();
    await action();
    await this.updateComplete;
    await this.chatView?.updateComplete;
    await nextFrame();
    this.chatView?.restoreScrollPosition();
    if (this.shouldAutoFocusPrompt()) this.promptEditor?.focusInput();
  }

  private shouldAutoFocusPrompt(): boolean {
    return this.appShell.shouldAutoFocusPrompt();
  }

  private async withChatPrependTransition(action: () => Promise<void>) {
    await action();
    await this.updateComplete;
    await this.chatView?.updateComplete;
  }

  private defaultRouteView(): AppState["mainView"] {
    return this.appShell.defaultRouteView();
  }

  private updateUrl(options?: { replace?: boolean | undefined }) {
    writeRoute({
      machineId: this.state.selectedMachine?.id,
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

  private openTerminal(options?: { terminalId?: string | undefined }): void {
    if (options?.terminalId !== undefined) this.selectTerminal(options.terminalId, { replace: true });
    this.openWorkspaceTool("core:workspace.terminal");
  }

  private terminalCommandRunsForOrigin(origin: string): TerminalCommandRunsInternalRuntime {
    const existing = this.terminalCommandRunRuntimes.get(origin);
    if (existing !== undefined) return existing;
    const runtime = createTerminalCommandRunsRuntime(origin, {
      openTerminal: (workspace, options) => { void this.openRuntimeTerminal(workspace, options); },
    });
    this.terminalCommandRunRuntimes.set(origin, runtime);
    return runtime;
  }

  private async openRuntimeTerminal(workspace: Workspace | undefined, options?: { terminalId?: string | undefined }): Promise<void> {
    if (workspace !== undefined && this.state.selectedWorkspace?.id !== workspace.id) await this.workspaces.selectWorkspace(workspace);
    this.openTerminal(options);
  }

  private selectTerminal(terminalId: string | undefined, options?: { replace?: boolean | undefined }): void {
    this.rememberSelectedTerminal(terminalId);
    this.setState({ selectedTerminalId: terminalId });
    this.writeSelectedTerminalToUrl(terminalId, options);
  }

  private rememberSelectedTerminal(terminalId: string | undefined): void {
    const workspace = this.state.selectedWorkspace;
    if (workspace === undefined) return;
    if (terminalId === undefined) this.terminalSelection.forgetWorkspace(workspace.path);
    else this.terminalSelection.rememberTerminal(workspace.path, terminalId);
  }

  private writeSelectedTerminalToUrl(terminalId: string | undefined, options?: { replace?: boolean | undefined }): void {
    setNamespacedQueryKey(TERMINAL_ROUTE_NAMESPACE, "terminal", terminalId, options);
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
    const selectedTerminalId = this.routeRestoreInProgress ? this.restoringRouteTerminalId : next.selectedWorkspace === undefined ? undefined : this.terminalSelection.latestTerminalId(next.selectedWorkspace.path);
    this.setState({ activeTerminalCount: 0, selectedTerminalId });
    if (!this.routeRestoreInProgress) this.writeSelectedTerminalToUrl(selectedTerminalId, { replace: true });
    if (next.selectedWorkspace === undefined) return;
    void this.refreshActiveTerminals(next.selectedWorkspace);
    void this.refreshWorkspaceDeletionRuns();
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
      selectedMachineId(this.state),
    );
  }

  private handleRealtimeEvent(event: RealtimeEvent): void {
    if (event.type === "workspace.activity") this.activity.applyWorkspaceActivity(event.activity);
    else if (isTerminalEvent(event)) {
      this.applyTerminalEvent(event);
      if (event.type === "terminal.exited") void this.refreshWorkspaceDeletionRuns();
    } else this.sessions.applyGlobalEvent(event);
  }

  private applyTerminalEvent(event: TerminalUiEvent): void {
    const workspace = this.state.selectedWorkspace;
    if (workspace === undefined) return;
    const cwd = event.type === "terminal.closed" ? event.cwd : event.terminal.cwd;
    if (cwd !== workspace.path) return;
    if (event.type === "terminal.created" && !event.terminal.exited) this.activeTerminalIds.add(event.terminal.id);
    else this.activeTerminalIds.delete(event.type === "terminal.closed" ? event.terminalId : event.terminal.id);
    if (event.type === "terminal.closed") {
      this.terminalSelection.forgetTerminal(event.terminalId);
      if (this.state.selectedTerminalId === event.terminalId) this.selectTerminal(undefined, { replace: true });
    }
    this.setState({ activeTerminalCount: this.activeTerminalIds.size });
  }

  private async refreshActiveTerminals(workspace: Workspace): Promise<void> {
    try {
      const terminals = await terminalsApi.terminals(workspace.projectId, workspace.id, selectedMachineId(this.state));
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
    const workspace = this.state.selectedWorkspace;
    const panelContext = workspace === undefined ? undefined : this.createWorkspacePanelContext(workspace);
    const workspaceLabelItems = workspace === undefined ? [] : this.plugins.getWorkspaceLabelItems(this.state, workspace);
    const emptyState = workspace === undefined ? this.workspacePanelEmptyState() : undefined;
    return html`
      <workspace-panel
        id="workspace-panel"
        .workspace=${workspace}
        .panelContext=${panelContext}
        .emptyState=${emptyState}
        .tool=${this.state.workspaceTool}
        .panels=${this.visibleWorkspacePanels()}
        .workspaceLabelItems=${workspaceLabelItems}
        .onSelectTool=${(tool: QualifiedContributionId) => { this.openWorkspaceTool(tool); }}
      ></workspace-panel>
    `;
  }

  private renderNavigationPanelEdgeControl() {
    return html`
      <app-panel-edge-control
        side="navigation"
        controls="navigation-panel"
        expandLabel="Expand navigation panel"
        collapseLabel="Collapse navigation panel"
        .collapsed=${this.panelCollapse.navigationPanelCollapsed}
        .onToggle=${() => { this.panelCollapse.toggleNavigationPanel(); }}
      ></app-panel-edge-control>
    `;
  }

  private renderWorkspacePanelEdgeControl() {
    return html`
      <app-panel-edge-control
        side="workspace"
        controls="workspace-panel"
        expandLabel="Expand workspace panel"
        collapseLabel="Collapse workspace panel"
        .collapsed=${this.panelCollapse.workspacePanelCollapsed}
        .onToggle=${() => { this.panelCollapse.toggleWorkspacePanel(); }}
      ></app-panel-edge-control>
    `;
  }

  private renderNavigationPanel(autoSwitchToChat: boolean) {
    const openChatAfter = (action: () => Promise<void>) => this.withChatScrollTransition(async () => {
      await action();
      if (autoSwitchToChat) this.setState({ mainView: "chat" });
      if (autoSwitchToChat) this.updateUrl();
    });
    return html`
      <app-navigation-panel
        .machines=${this.state.machines}
        .selectedMachine=${this.state.selectedMachine}
        .machinesCollapsed=${this.mobileNavigation.isCollapsed("machines")}
        .onToggleMachines=${() => { this.mobileNavigation.toggle("machines"); }}
        .onSelectMachine=${(machine: Machine) => this.withChatScrollTransition(async () => {
          this.mobileNavigation.expand("projects");
          await this.machines.selectMachine(machine);
        })}
        .projects=${this.state.projects}
        .selectedProject=${this.state.selectedProject}
        .workspaceActivities=${this.state.workspaceActivities}
        .workspacesByProjectId=${this.state.workspacesByProjectId}
        .workspaces=${this.state.workspaces}
        .selectedWorkspace=${this.state.selectedWorkspace}
        .deletingWorkspaceIds=${pendingWorkspaceDeletionIds(this.state.workspaceDeletionRuns)}
        .sessions=${this.state.sessions}
        .sessionStatuses=${this.state.sessionStatuses}
        .sessionActivities=${this.state.sessionActivities}
        .selectedSession=${this.state.selectedSession}
        .canStartSession=${!!this.state.selectedWorkspace}
        .collapsible=${this.appShell.isMobileNavigationLayout}
        .projectsCollapsed=${this.mobileNavigation.isCollapsed("projects")}
        .workspacesCollapsed=${this.mobileNavigation.isCollapsed("workspaces")}
        .sessionsCollapsed=${this.mobileNavigation.isCollapsed("sessions")}
        .workspaceLabelItems=${(workspace: Workspace) => this.plugins.getWorkspaceLabelItems(this.state, workspace)}
        .refreshControl=${this.appShell.shouldShowAppRefreshInHeader() ? this.renderAppRefresh() : undefined}
        .onShowActions=${() => { this.setState({ actionPaletteOpen: true }); }}
        .onToggleProjects=${() => { this.mobileNavigation.toggle("projects"); }}
        .onToggleWorkspaces=${() => { this.mobileNavigation.toggle("workspaces"); }}
        .onToggleSessions=${() => { this.mobileNavigation.toggle("sessions"); }}
        .onSelectProject=${(project: Project) => this.withChatScrollTransition(async () => {
          this.mobileNavigation.expand("workspaces");
          await this.workspaces.selectProject(project);
        })}
        .onCloseProject=${(project: Project) => this.projects.closeProject(project.id)}
        .onSelectWorkspace=${(workspace: Workspace) => this.withChatScrollTransition(async () => {
          this.mobileNavigation.expand("sessions");
          await this.workspaces.selectWorkspace(workspace);
        })}
        .onDeleteWorkspace=${(workspace: Workspace) => { void this.deleteWorkspace(workspace); }}
        .onArchivedCollapsed=${() => { this.sessions.clearSelectionAfterArchivedCollapse(); }}
        .onStartSession=${() => openChatAfter(() => this.sessions.startSession())}
        .onSelectSession=${(session: SessionInfo) => openChatAfter(() => this.sessions.selectSession(session))}
        .onArchiveSession=${(session: SessionInfo) => this.sessions.archiveSession(session)}
        .onArchiveSessionWithDescendants=${(session: SessionInfo) => this.sessions.archiveSessionWithDescendants(session)}
        .onRestoreSession=${(session: SessionInfo) => openChatAfter(() => this.sessions.restoreSession(session))}
        .onDeleteCachedNewSession=${(session: SessionInfo) => this.sessions.deleteCachedNewSession(session)}
        .onDetachParentSession=${(session: SessionInfo) => this.sessions.detachParent(session)}
      ></app-navigation-panel>
    `;
  }

  private openNavigationSection(section: NavigationSection): void {
    this.mobileNavigation.open(section, () => { this.selectMainView("navigation"); });
  }

  private visibleWorkspacePanels(): QualifiedWorkspacePanelContribution[] {
    const workspace = this.state.selectedWorkspace;
    if (workspace === undefined) return [];
    return this.plugins.getWorkspacePanels().filter((panel) => panel.visible?.({ workspace, state: this.state }) ?? true);
  }

  private workspacePanelEmptyState(): WorkspacePanelEmptyState {
    const project = this.state.selectedProject;
    if (this.state.isLoadingProjects) {
      return {
        title: "Loading projects…",
        body: "Looking for projects you have added to PI WEB.",
      };
    }
    if (project === undefined) {
      return this.state.projects.length === 0
        ? {
            title: "No projects yet",
            body: "Use Actions → Add Project to add a folder. Workspace tools will appear here after you choose a workspace.",
          }
        : {
            title: "Select a project",
            body: "Choose a project from the sidebar, then select a workspace to inspect files, Git, or terminals.",
          };
    }
    if (this.state.isLoadingWorkspaces) {
      return {
        title: "Loading workspaces…",
        body: `Preparing workspace tools for ${project.name}.`,
      };
    }
    if (this.state.workspaces.length === 0) {
      return {
        title: "No workspaces found",
        body: `${project.name} does not have any available workspaces. Try selecting the project again or re-adding it.`,
      };
    }
    return {
      title: "Select a workspace",
      body: `Choose a workspace in ${project.name} to inspect files, Git, or terminals.`,
    };
  }

  private sessionEmptyMessage(): string {
    if (this.state.isLoadingProjects) return "Loading projects…";
    if (this.state.selectedWorkspace !== undefined) return "Select or start a session.";
    if (this.state.selectedProject !== undefined) return "Select a workspace to start a session.";
    if (this.state.projects.length === 0) return "Add a project to start a session.";
    return "Select a project and workspace to start a session.";
  }

  private renderMobilePanelTitle(panel: QualifiedWorkspacePanelContribution) {
    const workspace = this.state.selectedWorkspace;
    if (workspace === undefined) return panel.title;
    const badge = panel.badge?.(this.createWorkspacePanelContext(workspace));
    if (badge === undefined || badge === "") return panel.title;
    return html`${panel.title} <span class="tab-badge">${badge}</span>`;
  }

  private createWorkspacePanelContext(workspace: Workspace): WorkspacePanelContext {
    const createContext = (origin: string): WorkspacePanelContext => installWorkspacePanelScope({
      workspace,
      state: this.state,
      piWebInternal: { terminalCommandRuns: this.terminalCommandRunsForOrigin(origin) },
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
      selectedTerminalId: this.state.selectedTerminalId,
      terminalAutoStart: this.terminalAutoStartWorkspaceId === workspace.id,
      openTerminal: (options) => { this.openTerminal(options); },
      onRefreshFiles: () => { void this.files.refreshFiles(); },
      onExpandDir: (path: string) => { void this.files.expandDir(path); },
      onSelectFile: (path: string) => { void this.files.selectFile(path); },
      onRefreshGit: () => { void this.git.refreshGit(); },
      onSelectDiff: (path: string) => { void this.git.selectDiff(path); },
      onSelectTerminal: (terminalId: string | undefined, options?: { replace?: boolean | undefined }) => { this.selectTerminal(terminalId, options); },
    }, createContext);
    return createContext("core");
  }

  private getActions(): AppAction[] {
    return this.plugins.getActions(this.createPluginRuntimeContext());
  }

  private async loadExternalPlugins(): Promise<void> {
    try {
      const registrations = await loadExternalPlugins();
      for (const registration of registrations) {
        try {
          this.plugins.register(registration);
        } catch (error) {
          console.warn(`Failed to register PI WEB plugin ${registration.id}`, error);
        }
      }
      this.applyPreferredTheme(false);
      this.requestUpdate();
    } catch (error) {
      console.warn("Failed to load external PI WEB plugins", error);
    }
  }

  private createPluginRuntimeContext(): PluginRuntimeContext {
    const createContext = (origin: string): PluginRuntimeContext => installPluginRuntimeScope({
      state: this.state,
      piWebInternal: { terminalCommandRuns: this.terminalCommandRunsForOrigin(origin) },
      openActionPalette: () => { this.setState({ actionPaletteOpen: true }); },
      focusPrompt: () => { this.promptEditor?.focusInput(); },
      addProject: () => { this.setState({ projectDialogOpen: true }); },
      configureAuth: () => this.auth.openLogin(),
      logoutAuth: () => this.auth.openLogout(),
      openThemePicker: () => { this.openThemeDialog(); },
      selectMainView: (view) => { this.selectMainView(view); },
      selectWorkspaceTool: (tool) => { this.openWorkspaceTool(tool); },
      openTerminal: (options) => { this.openTerminal(options); },
      refreshFiles: () => this.files.refreshFiles(),
      refreshGit: () => this.git.refreshGit(),
      refreshAppData: () => this.refreshAppData(),
      reloadPage: () => { this.hardReloadApp(); },
      deleteWorkspace: (workspace) => this.deleteWorkspace(workspace),
      startSession: () => this.withChatScrollTransition(() => this.sessions.startSession()),
      archiveSession: () => this.sessions.archiveSession(),
      deleteCachedNewSession: () => this.sessions.deleteCachedNewSession(),
      stopActiveWork: () => this.sessions.stopActiveWork(),
    }, createContext);
    return createContext("core");
  }

  private async deleteWorkspace(workspace = this.state.selectedWorkspace): Promise<void> {
    if (workspace === undefined) return;
    if (!canDeleteWorkspace(workspace)) {
      this.setState({ error: "Only secondary Git worktrees can be deleted" });
      return;
    }
    if (isWorkspaceDeletionPending(this.state, workspace)) return;
    const label = workspace.branch ?? workspace.label;
    const confirmed = confirm(`Delete workspace ${label}?\n\nThis will run git worktree remove and delete:\n${workspace.path}\n\nThe Git branch will not be deleted.`);
    if (!confirmed) return;

    try {
      const mainWorkspace = await this.mainWorkspaceForProject(workspace.projectId);
      if (mainWorkspace === undefined) {
        this.setState({ error: "Project main workspace not found" });
        return;
      }
      const handle = await this.terminalCommandRunsForOrigin("core").runCommand({
        workspace: mainWorkspace,
        title: `Delete workspace: ${label}`,
        command: `git worktree remove ${shellQuote(workspace.path)}`,
        open: true,
        metadata: workspaceDeletionMetadata(workspace),
      });
      this.recordWorkspaceDeletionRun(handle.run);
      void handle.completed.then((run) => this.handleCompletedWorkspaceDeletionRun(run)).catch((error: unknown) => {
        this.setState({ error: `Workspace deletion failed. See terminal output. ${errorMessage(error)}` });
      });
    } catch (error) {
      this.setState({ error: `Failed to start workspace deletion: ${errorMessage(error)}` });
    }
  }

  private async mainWorkspaceForProject(projectId: string): Promise<Workspace | undefined> {
    let workspaces = this.state.selectedProject?.id === projectId ? this.state.workspaces : this.state.workspacesByProjectId[projectId];
    if (workspaces === undefined || workspaces.length === 0) workspaces = await this.workspaces.refreshProjectWorkspaces(projectId);
    return workspaces.find((workspace) => workspace.isMain) ?? workspaces[0];
  }

  private recordWorkspaceDeletionRun(run: TerminalCommandRun): void {
    const workspaceId = targetWorkspaceIdForRun(run);
    if (workspaceId === undefined) return;
    this.setState({ workspaceDeletionRuns: { ...this.state.workspaceDeletionRuns, [workspaceId]: run } });
    this.updateWorkspaceDeletionPolling();
  }

  private async refreshWorkspaceDeletionRuns(): Promise<void> {
    if (this.refreshingWorkspaceDeletionRuns) return;
    const project = this.state.selectedProject;
    if (project === undefined) {
      this.setState({ workspaceDeletionRuns: {} });
      this.updateWorkspaceDeletionPolling();
      return;
    }

    this.refreshingWorkspaceDeletionRuns = true;
    try {
      const runs = await this.terminalCommandRunsForOrigin("core").listCommandRuns(workspaceDeletionRunFilter(project.id));
      const latestRuns = latestWorkspaceDeletionRuns(runs);
      this.setState({ workspaceDeletionRuns: latestRuns });
      for (const run of Object.values(latestRuns)) {
        if (!isWorkspaceDeletionRunPending(run)) await this.handleCompletedWorkspaceDeletionRun(run);
      }
    } catch (error) {
      console.warn("Failed to refresh workspace deletion runs", error);
    } finally {
      this.refreshingWorkspaceDeletionRuns = false;
      this.updateWorkspaceDeletionPolling();
    }
  }

  private updateWorkspaceDeletionPolling(): void {
    const hasPendingDeletion = Object.values(this.state.workspaceDeletionRuns).some(isWorkspaceDeletionRunPending);
    if (hasPendingDeletion && this.workspaceDeletionPollTimer === undefined) {
      this.workspaceDeletionPollTimer = window.setInterval(() => { void this.refreshWorkspaceDeletionRuns(); }, 1000);
      return;
    }
    if (!hasPendingDeletion && this.workspaceDeletionPollTimer !== undefined) {
      window.clearInterval(this.workspaceDeletionPollTimer);
      this.workspaceDeletionPollTimer = undefined;
    }
  }

  private async handleCompletedWorkspaceDeletionRun(run: TerminalCommandRun): Promise<void> {
    if (this.handledWorkspaceDeletionRunIds.has(run.id)) return;
    const workspaceId = targetWorkspaceIdForRun(run);
    if (workspaceId === undefined) return;
    this.handledWorkspaceDeletionRunIds.add(run.id);

    if (run.status === "succeeded") {
      await this.workspaces.refreshAfterWorkspaceDeleted(run.projectId, workspaceId);
      this.setState({ workspaceDeletionRuns: omitWorkspaceDeletionRun(this.state.workspaceDeletionRuns, workspaceId) });
      this.updateWorkspaceDeletionPolling();
      return;
    }

    if (run.status === "failed") {
      this.setState({ error: "Workspace deletion failed. See terminal output." });
      this.updateWorkspaceDeletionPolling();
    }
  }

  private runAction(action: AppAction): void {
    void Promise.resolve()
      .then(() => action.run())
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Action failed: ${action.id}`, error);
        this.setState({ error: `Action failed: ${message}` });
      });
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
    const resolution = this.resolveCurrentThemePreference(themes);
    const selectedThemeId = resolution.selectedTheme?.id;
    const autoValue = this.themePreference.auto ? THEME_AUTO_OFF_VALUE : THEME_AUTO_ON_VALUE;
    this.setState({
      themeDialog: {
        title: "Select Theme",
        selectedValue: selectedThemeId === undefined ? autoValue : `${THEME_OPTION_PREFIX}${selectedThemeId}`,
        options: [
          {
            value: autoValue,
            label: `Auto ${this.themePreference.auto ? "✓ on" : "off"}`,
            description: this.autoThemeDescription(resolution),
          },
          ...themes.map((theme) => ({
            value: `${THEME_OPTION_PREFIX}${theme.id}`,
            label: this.themeOptionLabel(theme, selectedThemeId),
            description: this.themeOptionDescription(theme),
          })),
        ],
      },
    });
  }

  private pickTheme(value: string) {
    this.setState({ themeDialog: undefined });
    if (value === THEME_AUTO_ON_VALUE || value === THEME_AUTO_OFF_VALUE) {
      const selectedThemeId = this.resolveCurrentThemePreference().selectedTheme?.id;
      if (selectedThemeId === undefined) return;
      this.themePreference = { themeId: selectedThemeId, auto: value === THEME_AUTO_ON_VALUE };
      this.applyPreferredTheme(true);
      return;
    }
    if (!value.startsWith(THEME_OPTION_PREFIX)) return;
    const themeId = value.slice(THEME_OPTION_PREFIX.length);
    const theme = this.plugins.getThemes().find((candidate) => candidate.id === themeId);
    if (theme === undefined) return;
    this.themePreference = { themeId: theme.id, auto: this.themePreference.auto };
    this.applyPreferredTheme(true);
  }

  private applyPreferredTheme(persist: boolean): void {
    const theme = this.resolveCurrentThemePreference().activeTheme;
    if (theme === undefined) return;
    this.activeThemeId = theme.id;
    applyPiWebTheme(theme);
    if (persist) writeStoredThemePreference(this.themePreference);
  }

  private resolveCurrentThemePreference(themes = this.plugins.getThemes()): ThemePreferenceResolution {
    return resolveThemePreference({
      themes,
      themePairs: this.plugins.getThemePairs(),
      preference: this.themePreference,
      prefersLight: this.systemPrefersLight(),
    });
  }

  private themePairForTheme(themeId: QualifiedContributionId): QualifiedThemePairContribution | undefined {
    return findThemePairForTheme(this.plugins.getThemePairs(), themeId);
  }

  private systemPrefersLight(): boolean {
    return this.systemLightThemeMedia?.matches ?? false;
  }

  private autoThemeDescription(resolution: ThemePreferenceResolution): string {
    if (!this.themePreference.auto) return "Follow the system light/dark preference when the selected theme has a pair.";
    if (resolution.selectedTheme === undefined) return "Follow the system light/dark preference when the selected theme has a pair.";
    if (resolution.selectedThemePair === undefined) return "On, but the selected theme has no light/dark pair, so it will stay selected.";
    return `On · ${resolution.selectedThemePair.name} follows the system ${this.systemPrefersLight() ? "light" : "dark"} preference.`;
  }

  private themeOptionLabel(theme: QualifiedThemeContribution, selectedThemeId: QualifiedContributionId | undefined): string {
    const markers = [
      ...(theme.id === selectedThemeId ? ["selected"] : []),
      ...(theme.id === this.activeThemeId && theme.id !== selectedThemeId ? ["active"] : []),
    ];
    return markers.length === 0 ? theme.name : `${theme.name} ✓ ${markers.join(" · ")}`;
  }

  private themeOptionDescription(theme: QualifiedThemeContribution): string {
    const parts: string[] = [theme.colorScheme];
    if (this.themePairForTheme(theme.id) !== undefined) parts.push("auto pair");
    if (theme.description !== undefined) parts.push(theme.description);
    return parts.join(" · ");
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
    if (!this.appShell.isMobileNavigationLayout) return null;
    return html`
      <app-context-bar
        .project=${this.state.selectedProject}
        .workspace=${this.state.selectedWorkspace}
        .session=${this.state.selectedSession}
        .refreshControl=${this.appShell.shouldShowAppRefreshInContextBar() ? this.renderAppRefresh() : undefined}
        .onOpenSection=${(section: NavigationSection) => { this.openNavigationSection(section); }}
      ></app-context-bar>
    `;
  }

  private renderMobileMainTabs() {
    return html`
      <app-mobile-main-tabs
        .tabs=${this.mobileMainTabs()}
        .selectedView=${this.state.mainView}
        .onSelect=${(view: AppState["mainView"]) => { this.selectMainView(view); }}
      ></app-mobile-main-tabs>
    `;
  }

  private mobileMainTabs(): AppMobileMainTab[] {
    return [
      { id: "navigation", label: "Sessions", className: "navigation-tab" },
      { id: "chat", label: "Chat" },
      ...this.visibleWorkspacePanels().map((panel): AppMobileMainTab => ({ id: panel.id, label: this.renderMobilePanelTitle(panel) })),
    ];
  }

  private renderAppRefresh() {
    return html`<app-refresh-control .isRefreshing=${this.isRefreshingApp} .onRefresh=${() => this.refreshAppData()} .onReload=${() => { this.hardReloadApp(); }}></app-refresh-control>`;
  }

  override render() {
    const state = this.state;
    return html`
      <div class=${this.panelCollapse.shellClass(state.mainView)}>
        <aside id="navigation-panel">${this.appShell.isMobileNavigationLayout ? null : this.renderNavigationPanel(false)}</aside>
        ${this.renderNavigationPanelEdgeControl()}
        <main class=${mainViewClass(state.mainView)}>
          ${this.renderContextBar()}
          ${this.renderMobileMainTabs()}
          ${state.error ? html`<div class="error">${state.error}</div>` : null}
          <div class="mobile-navigation-panel">${this.appShell.isMobileNavigationLayout ? this.renderNavigationPanel(true) : null}</div>
          ${state.selectedSession ? html`
            <chat-view .sessionId=${state.selectedSession.id} .messages=${state.messages} .messageStart=${state.messagePageStart} .messageEnd=${state.messagePageEnd} .messageTotal=${state.messagePageTotal} .hasMore=${state.messagePageStart > 0} .loadingMore=${state.isLoadingEarlierMessages} .isReceivingPartialStream=${state.isReceivingPartialStream} .isCompacting=${state.status?.isCompacting === true} .pendingMessageCount=${state.status?.pendingMessageCount ?? 0} .status=${state.status} .activity=${state.activity} .onLoadMore=${() => this.withChatPrependTransition(() => this.sessions.loadEarlierMessages())}></chat-view>
            <prompt-editor .sessionId=${state.selectedSession.id} .cwd=${state.selectedWorkspace?.path} .machineId=${selectedMachineId(state)} .disabled=${state.selectedSession.archived === true} .canSteer=${state.status?.isStreaming === true} .isCompacting=${state.status?.isCompacting === true} .canStop=${state.status?.isStreaming === true || state.status?.isBashRunning === true || state.status?.isCompacting === true || (state.status?.pendingMessageCount ?? 0) > 0} .status=${state.status} .onSend=${(text: string, streamingBehavior?: "steer" | "followUp") => { this.sendPrompt(text, streamingBehavior); }} .onStop=${() => this.sessions.stopActiveWork()} .onSelectModel=${() => { void this.openModelDialog(); }} .onSelectThinking=${() => { void this.openThinkingDialog(); }}></prompt-editor>
            <status-bar .status=${state.status} .workspace=${state.selectedWorkspace} .workspaceLabelItems=${state.selectedWorkspace === undefined ? [] : this.plugins.getWorkspaceLabelItems(state, state.selectedWorkspace)}></status-bar>
            ${state.commandDialog !== undefined ? html`<command-picker .title=${state.commandDialog.title} .options=${state.commandDialog.options} .onPick=${(value: string) => this.sessions.respondToCommand(state.commandDialog?.requestId ?? "", value)} .onCancel=${() => { this.sessions.cancelCommand(); }}></command-picker>` : null}
            ${state.modelDialog !== undefined ? html`<command-picker title=${state.modelDialog.title} .searchable=${true} .options=${state.modelDialog.options} .selectedValue=${state.modelDialog.selectedValue} .onPick=${(value: string) => { void this.pickModel(value); }} .onCancel=${() => { this.setState({ modelDialog: undefined }); }}></command-picker>` : null}
            ${state.thinkingDialog !== undefined ? html`<command-picker title=${state.thinkingDialog.title} .options=${state.thinkingDialog.options} .selectedValue=${state.thinkingDialog.selectedValue} .onPick=${(value: string) => { void this.pickThinking(value); }} .onCancel=${() => { this.setState({ thinkingDialog: undefined }); }}></command-picker>` : null}
            ${state.authDialog !== undefined ? html`<auth-dialog .state=${state.authDialog} .onChooseMethod=${(authType: "oauth" | "api_key") => { void this.auth.chooseLoginMethod(authType); }} .onSelectProvider=${(providerId: string, authType: "oauth" | "api_key") => { void this.auth.selectLoginProvider(providerId, authType); }} .onApiKeyInput=${(value: string) => { this.auth.updateApiKey(value); }} .onSaveApiKey=${() => { void this.auth.saveApiKey(); }} .onLogoutProvider=${(providerId: string) => { void this.auth.logoutProvider(providerId); }} .onOAuthInput=${(value: string) => { this.auth.updateOAuthInput(value); }} .onOAuthRespond=${(value?: string) => { void this.auth.respondOAuth(value); }} .onOAuthCancel=${() => { void this.auth.cancelOAuth(); }} .onCancel=${() => { this.auth.closeDialog(); }}></auth-dialog>` : null}
          ` : html`<div class="empty">${this.sessionEmptyMessage()}</div>`}
        </main>
        ${this.renderWorkspacePanelEdgeControl()}
        ${this.renderWorkspacePanel()}
        ${state.actionPaletteOpen ? html`<action-palette .actions=${this.getActions()} .onRun=${(action: AppAction) => { this.setState({ actionPaletteOpen: false }); this.runAction(action); }} .onCancel=${() => { this.setState({ actionPaletteOpen: false }); }}></action-palette>` : null}
        ${state.projectDialogOpen ? html`<project-dialog .machineId=${selectedMachineId(state)} .onSubmit=${(path: string, create: boolean) => this.projects.addProject(path, create)} .onCancel=${() => { this.setState({ projectDialogOpen: false }); }}></project-dialog>` : null}
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

function patchChangesState(state: AppState, patch: Partial<AppState>): boolean {
  return Object.entries(patch).some(([key, value]) => Reflect.get(state, key) !== value);
}

function isActive(state: Pick<AppState, "status" | "activity">): boolean {
  return isSessionActive(state.status, state.activity);
}

function isTerminalEvent(event: RealtimeEvent): event is TerminalUiEvent {
  return event.type === "terminal.created" || event.type === "terminal.exited" || event.type === "terminal.closed";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function omitWorkspaceDeletionRun(runs: Record<string, TerminalCommandRun>, workspaceId: string): Record<string, TerminalCommandRun> {
  return Object.fromEntries(Object.entries(runs).filter(([candidate]) => candidate !== workspaceId));
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
