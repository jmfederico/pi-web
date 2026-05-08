import { LitElement, html } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import type { Project, SessionInfo, Workspace } from "../api";
import type { AppAction } from "../actions";
import { createAppActions } from "../appActions";
import { initialAppState, type AppState } from "../appState";
import { FileExplorerController } from "../controllers/fileExplorerController";
import { GitController } from "../controllers/gitController";
import { ProjectController } from "../controllers/projectController";
import { SessionController } from "../controllers/sessionController";
import { WorkspaceController } from "../controllers/workspaceController";
import { KeyboardShortcutDispatcher } from "../keyboardShortcuts";
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

@customElement("pi-web-poc")
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
  private readonly onPopState = () => void this.withChatScrollTransition(() => this.restoreRoute(false));
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (this.keyboard.handle(event, this.getActions())) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("popstate", this.onPopState);
    window.addEventListener("keydown", this.onKeyDown);
    this.sessions.connectStatusUpdates();
    void this.loadProjectsAndRestoreRoute();
  }

  override disconnectedCallback(): void {
    window.removeEventListener("popstate", this.onPopState);
    window.removeEventListener("keydown", this.onKeyDown);
    this.keyboard.reset();
    this.sessions.dispose();
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
    this.setState({ workspaceTool: route.tool ?? this.state.workspaceTool, mainView: route.view ?? this.state.mainView, selectedFilePath: route.file, selectedDiffPath: route.diff });
    if (route.projectId === undefined || route.projectId === "") return;
    const project = this.state.projects.find((p) => p.id === route.projectId);
    if (!project) return;
    await this.workspaces.selectProject(project, { workspaceId: route.workspaceId, sessionId: route.sessionId, updateUrl });
    if (route.tool === "files") await this.files.refreshFiles();
    if (route.file !== undefined) await this.files.selectFile(route.file);
    if (route.tool === "git") await this.git.refreshGit();
    if (route.diff !== undefined) await this.git.selectDiff(route.diff);
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

  private updateUrl() {
    writeRoute({
      projectId: this.state.selectedProject?.id,
      workspaceId: this.state.selectedWorkspace?.id,
      sessionId: this.state.selectedSession?.id,
      tool: this.state.workspaceTool,
      view: this.state.mainView,
      file: this.state.selectedFilePath,
      diff: this.state.selectedDiffPath,
    });
  }

  private selectWorkspaceTool(tool: "files" | "git") {
    this.setState({ workspaceTool: tool, mainView: tool });
    this.updateUrl();
    if (tool === "files") void this.files.refreshFiles();
    else void this.git.refreshGit();
    this.git.updatePolling();
  }

  private selectMainView(view: "chat" | "files" | "git") {
    this.setState({ mainView: view, workspaceTool: view === "chat" ? this.state.workspaceTool : view });
    this.updateUrl();
    if (view === "files") void this.files.refreshFiles();
    if (view === "git") void this.git.refreshGit();
    this.git.updatePolling();
  }

  private handleWorkspaceChange(previous: AppState, next: AppState) {
    if (previous.selectedWorkspace?.id === next.selectedWorkspace?.id || next.selectedWorkspace === undefined) return;
    if (next.workspaceTool === "files") void this.files.refreshFiles();
    if (next.workspaceTool === "git") void this.git.refreshGit();
    this.git.updatePolling();
  }

  private handleActivityTransition(previous: AppState, next: AppState) {
    const wasActive = isActive(previous.status);
    const nowActive = isActive(next.status);
    if (wasActive && !nowActive) {
      this.setState({ fileTreeStale: true, gitStale: true });
      if (this.state.workspaceTool === "files") void this.files.refreshFiles();
      if (this.state.workspaceTool === "git") void this.git.refreshGit();
    }
  }

  private renderWorkspacePanel() {
    return html`<workspace-panel .workspace=${this.state.selectedWorkspace} .tool=${this.state.workspaceTool} .fileTree=${this.state.fileTree} .expandedDirs=${this.state.expandedDirs} .selectedFilePath=${this.state.selectedFilePath} .selectedFileContent=${this.state.selectedFileContent} .fileTreeStale=${this.state.fileTreeStale} .gitStatus=${this.state.gitStatus} .selectedDiffPath=${this.state.selectedDiffPath} .selectedDiff=${this.state.selectedDiff} .selectedStagedDiff=${this.state.selectedStagedDiff} .gitStale=${this.state.gitStale} .onSelectTool=${(tool: "files" | "git") => { this.selectWorkspaceTool(tool); }} .onRefreshFiles=${() => this.files.refreshFiles()} .onExpandDir=${(path: string) => this.files.expandDir(path)} .onSelectFile=${(path: string) => this.files.selectFile(path)} .onRefreshGit=${() => this.git.refreshGit()} .onSelectDiff=${(path: string) => this.git.selectDiff(path)}></workspace-panel>`;
  }

  private getActions(): AppAction[] {
    return createAppActions({
      state: this.state,
      openActionPalette: () => { this.setState({ actionPaletteOpen: true }); },
      focusPrompt: () => { this.promptEditor?.focusInput(); },
      addProject: () => { this.setState({ projectDialogOpen: true }); },
      selectMainView: (view) => { this.selectMainView(view); },
      refreshFiles: () => this.files.refreshFiles(),
      refreshGit: () => this.git.refreshGit(),
      startSession: () => this.withChatScrollTransition(() => this.sessions.startSession()),
      stopActiveWork: () => this.sessions.stopActiveWork(),
    });
  }

  private runAction(actionId: string) {
    const action = this.getActions().find((candidate) => candidate.id === actionId && candidate.enabled !== false);
    if (action !== undefined) void action.run();
  }

  override render() {
    const state = this.state;
    return html`
      <div class="shell">
        <aside>
          <header>
            <strong>Pi Web POC</strong>
            <button @click=${() => { this.setState({ projectDialogOpen: true }); }}>+ Project</button>
          </header>
          <project-list .projects=${state.projects} .selected=${state.selectedProject} .onSelect=${(project: Project) => this.withChatScrollTransition(() => this.workspaces.selectProject(project))} .onClose=${(project: Project) => this.projects.closeProject(project.id)}></project-list>
          <workspace-list .workspaces=${state.workspaces} .selected=${state.selectedWorkspace} .onSelect=${(workspace: Workspace) => this.withChatScrollTransition(() => this.workspaces.selectWorkspace(workspace))}></workspace-list>
          <session-list .sessions=${state.sessions} .statuses=${state.sessionStatuses} .activities=${state.sessionActivities} .selected=${state.selectedSession} .canStart=${!!state.selectedWorkspace} .onStart=${() => this.withChatScrollTransition(() => this.sessions.startSession())} .onSelect=${(session: SessionInfo) => this.withChatScrollTransition(() => this.sessions.selectSession(session))} .onArchive=${(session: SessionInfo) => this.sessions.archiveSession(session)} .onRestore=${(session: SessionInfo) => this.sessions.restoreSession(session)}></session-list>
        </aside>
        <main class=${`${state.mainView}-view`}>
          <div class="mobile-tabs">
            <button class=${state.mainView === "chat" ? "selected" : ""} @click=${() => { this.selectMainView("chat"); }}>Chat</button>
            <button class=${state.mainView === "files" ? "selected" : ""} @click=${() => { this.selectMainView("files"); }}>Files</button>
            <button class=${state.mainView === "git" ? "selected" : ""} @click=${() => { this.selectMainView("git"); }}>Git</button>
          </div>
          ${state.error ? html`<div class="error">${state.error}</div>` : null}
          ${state.selectedSession ? html`
            <chat-view .sessionId=${state.selectedSession.id} .messages=${state.messages} .messageStart=${state.messagePageStart} .messageTotal=${state.messagePageTotal} .hasMore=${state.messagePageStart > 0} .loadingMore=${state.isLoadingEarlierMessages} .isCompacting=${state.status?.isCompacting === true} .pendingMessageCount=${state.status?.pendingMessageCount ?? 0} .status=${state.status} .activity=${state.activity} .onLoadMore=${() => this.withChatPrependTransition(() => this.sessions.loadEarlierMessages())}></chat-view>
            <prompt-editor .sessionId=${state.selectedSession.id} .cwd=${state.selectedWorkspace?.path} .disabled=${state.selectedSession.archived === true} .canSteer=${state.status?.isStreaming === true} .isCompacting=${state.status?.isCompacting === true} .canStop=${state.status?.isStreaming === true || state.status?.isBashRunning === true || state.status?.isCompacting === true} .onSend=${(text: string, streamingBehavior?: "steer" | "followUp") => this.sessions.send(text, streamingBehavior)} .onStop=${() => this.sessions.stopActiveWork()}></prompt-editor>
            <status-bar .status=${state.status} .workspace=${state.selectedWorkspace}></status-bar>
            ${state.commandDialog !== undefined ? html`<command-picker .title=${state.commandDialog.title} .options=${state.commandDialog.options} .onPick=${(value: string) => this.sessions.respondToCommand(state.commandDialog?.requestId ?? "", value)} .onCancel=${() => { this.sessions.cancelCommand(); }}></command-picker>` : null}
          ` : html`<div class="empty">Select or start a session.</div>`}
          <div class="mobile-panel">${this.renderWorkspacePanel()}</div>
        </main>
        ${this.renderWorkspacePanel()}
        ${state.actionPaletteOpen ? html`<action-palette .actions=${this.getActions()} .onRun=${(actionId: string) => { this.setState({ actionPaletteOpen: false }); this.runAction(actionId); }} .onCancel=${() => { this.setState({ actionPaletteOpen: false }); }}></action-palette>` : null}
        ${state.projectDialogOpen ? html`<project-dialog .onSubmit=${(path: string, create: boolean) => this.projects.addProject(path, create)} .onCancel=${() => { this.setState({ projectDialogOpen: false }); }}></project-dialog>` : null}
      </div>
    `;
  }

  static override styles = appStyles;
}

function isActive(status: AppState["status"]): boolean {
  return status?.isStreaming === true || status?.isBashRunning === true || status?.isCompacting === true;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => { resolve(); }));
}
