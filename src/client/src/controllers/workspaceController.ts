import { api as defaultApi, type Project, type SessionInfo, type Workspace } from "../api";
import { resetWorkspaceScopedState, type AppState } from "../appState";
import { mergeCachedNewSessions } from "../cachedNewSessions";
import { machineProjectKey } from "../machineKeys";
import { selectedMachineId, type GetState, type RouteTarget, type SetState, type UpdateUrl } from "./types";
import type { SessionController } from "./sessionController";
import { TrailingRefreshCoordinator } from "./trailingRefreshCoordinator";
import { InMemoryWorkspaceSelectionMemory, selectPreferredWorkspace, type WorkspaceSelectionMemory } from "./workspaceSelection";

const WORKSPACE_TOPOLOGY_REFRESH_DEBOUNCE_MS = 50;

export interface WorkspaceControllerDependencies {
  api?: Pick<typeof defaultApi, "sessions" | "workspaces" | "messages">;
  onBackgroundError?: (message: string, error: unknown) => void;
  topologyRefreshDebounceMs?: number;
}

export class WorkspaceController {
  private readonly api: Pick<typeof defaultApi, "sessions" | "workspaces" | "messages">;
  private readonly onBackgroundError: (message: string, error: unknown) => void;
  private readonly topologyRefreshes: TrailingRefreshCoordinator<string>;

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    private readonly updateUrl: UpdateUrl,
    private readonly sessions: Pick<SessionController, "clearActiveSession" | "preferredSession" | "selectSession">,
    private readonly workspaceSelection: WorkspaceSelectionMemory = new InMemoryWorkspaceSelectionMemory(),
    deps: WorkspaceControllerDependencies = {},
  ) {
    this.api = deps.api ?? defaultApi;
    this.onBackgroundError = deps.onBackgroundError ?? ((message, error) => { console.warn(message, error); });
    this.topologyRefreshes = new TrailingRefreshCoordinator(
      deps.topologyRefreshDebounceMs ?? WORKSPACE_TOPOLOGY_REFRESH_DEBOUNCE_MS,
    );
  }

  clearSelection(options?: { updateUrl?: boolean | undefined }) {
    this.sessions.clearActiveSession();
    this.setState({ selectedProject: undefined, selectedWorkspace: undefined, workspaces: [], isLoadingWorkspaces: false, ...resetWorkspaceScopedState() });
    if (options?.updateUrl !== false) this.updateUrl();
  }

  forgetProject(projectId: string): void {
    this.workspaceSelection.forgetProject(machineProjectKey(selectedMachineId(this.getState()), projectId));
    const workspacesByProjectId = Object.fromEntries(Object.entries(this.getState().workspacesByProjectId).filter(([candidate]) => candidate !== projectId));
    this.setState({ workspacesByProjectId });
  }

  async selectProject(project: Project, target?: RouteTarget) {
    const machineId = selectedMachineId(this.getState());
    this.sessions.clearActiveSession();
    this.setState({ selectedProject: project, selectedWorkspace: undefined, workspaces: [], isLoadingWorkspaces: true, ...resetWorkspaceScopedState() });
    try {
      const workspaces = await this.api.workspaces(project.id, machineId);
      if (selectedMachineId(this.getState()) !== machineId || this.getState().selectedProject?.id !== project.id) return;
      this.setState({ workspaces, workspacesByProjectId: { ...this.getState().workspacesByProjectId, [project.id]: workspaces }, isLoadingWorkspaces: false });
      const workspace = selectPreferredWorkspace(workspaces, { targetWorkspaceId: target?.workspaceId, latestWorkspaceId: this.workspaceSelection.latestWorkspaceId(machineProjectKey(machineId, project.id)) });
      if (workspace) await this.selectWorkspace(workspace, { sessionId: target?.sessionId, updateUrl: target?.updateUrl });
      else if (target?.updateUrl !== false) this.updateUrl();
    } catch (error) {
      if (selectedMachineId(this.getState()) === machineId && this.getState().selectedProject?.id === project.id) this.setState({ error: String(error), isLoadingWorkspaces: false });
    }
  }

  async selectWorkspace(workspace: Workspace, target?: { sessionId?: string | undefined; updateUrl?: boolean | undefined }) {
    const machineId = selectedMachineId(this.getState());
    this.workspaceSelection.rememberWorkspace({ ...workspace, projectId: machineProjectKey(machineId, workspace.projectId) });
    this.sessions.clearActiveSession();
    this.setState({ selectedWorkspace: workspace, isLoadingWorkspaces: false, ...resetWorkspaceScopedState() });
    try {
      const sessions = mergeCachedNewSessions(workspace.path, await this.api.sessions(workspace.path, machineId), machineId);
      if (selectedMachineId(this.getState()) !== machineId || this.getState().selectedWorkspace?.id !== workspace.id || this.getState().selectedProject?.id !== workspace.projectId) return;
      this.setState({ sessions });
      const session = this.sessions.preferredSession(workspace.path, sessions, target?.sessionId);
      if (session) {
        await this.sessions.selectSession(session, { updateUrl: target?.updateUrl });
        return;
      }
      const provisional = await this.probeSessionOutsideList(target?.sessionId, workspace, machineId);
      if (provisional !== undefined && selectedMachineId(this.getState()) === machineId && this.getState().selectedWorkspace?.id === workspace.id && this.getState().selectedProject?.id === workspace.projectId) {
        await this.sessions.selectSession(provisional, { updateUrl: target?.updateUrl });
        return;
      }
      if (target?.updateUrl !== false) this.updateUrl();
    } catch (error) {
      if (selectedMachineId(this.getState()) === machineId && this.getState().selectedWorkspace?.id === workspace.id) this.setState({ error: String(error) });
    }
  }

  /**
   * Deep-link fallback for sessions absent from the fetched list (e.g. older than the server-side
   * list cap, which push deep links from long-lived workspaces routinely hit): probe the transcript
   * endpoint with the known {id, cwd}; when the daemon serves content, select a provisional
   * SessionInfo so the chat opens instead of dead-ending on an empty session pane.
   */
  private async probeSessionOutsideList(sessionId: string | undefined, workspace: Workspace, machineId: string): Promise<SessionInfo | undefined> {
    if (sessionId === undefined || sessionId === "") return undefined;
    try {
      const page = await this.api.messages({ id: sessionId, cwd: workspace.path }, { limit: 1 }, machineId);
      if (page.total < 1) return undefined;
      return { id: sessionId, cwd: workspace.path, path: "", created: "", modified: "", messageCount: page.total, firstMessage: "", persisted: true };
    } catch {
      return undefined;
    }
  }


  async refreshProjectWorkspaces(projectId: string): Promise<Workspace[]> {
    const project = this.getState().projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new Error("Project not found");
    const workspaces = await this.api.workspaces(project.id, selectedMachineId(this.getState()));
    this.applyProjectWorkspaces(project.id, workspaces);
    return workspaces;
  }

  /**
   * Re-lists the selected project's workspaces so worktrees created or removed outside
   * PI WEB become visible, without disturbing the current selection.
   *
   * Deliberately never routes through `selectWorkspace`: that has no already-selected
   * guard, so re-picking the same workspace would still call `clearActiveSession()` and
   * `resetWorkspaceScopedState()`, closing the session socket and blanking chat, file
   * tree, plugin-owned panel state, and terminal selection. Callers run this on every browser resume,
   * so applying the list through `applyProjectWorkspaces` alone is the invariant.
   *
   * If the selected workspace disappeared, the selection is left alone: the user is
   * working there and the existing deletion path owns recovery.
   */
  async refreshSelectedProjectTopology(): Promise<void> {
    const state = this.getState();
    const project = state.selectedProject;
    if (project === undefined) return;
    const machineId = selectedMachineId(state);
    // Callers are independent (browser resume and the plugin-facing app refresh), so two
    // refreshes for the same machine+project can overlap. Sharing one request keeps a slow
    // earlier response from landing last and overwriting a newer list, which would make a
    // just-created worktree disappear again.
    await this.topologyRefreshes.request(machineProjectKey(machineId, project.id), async () => {
      try {
        const workspaces = await this.api.workspaces(project.id, machineId);
        const current = this.getState();
        if (selectedMachineId(current) !== machineId || current.selectedProject?.id !== project.id) return;
        this.applyProjectWorkspaces(project.id, workspaces);
      } catch (error) {
        this.onBackgroundError(`Failed to refresh workspaces for project ${project.id} on ${machineId}`, error);
      }
    });
  }

  async refreshAfterWorkspaceDeleted(projectId: string, workspaceId: string): Promise<void> {
    const workspaces = await this.refreshProjectWorkspaces(projectId);
    const state = this.getState();
    if (state.selectedProject?.id !== projectId || state.selectedWorkspace?.id !== workspaceId) return;

    const fallback = selectFallbackWorkspace(workspaces);
    if (fallback !== undefined) await this.selectWorkspace(fallback);
    else this.clearSelection();
  }

  private applyProjectWorkspaces(projectId: string, workspaces: Workspace[]): void {
    const state = this.getState();
    const workspacesByProjectId = { ...state.workspacesByProjectId, [projectId]: workspaces };
    if (state.selectedProject?.id !== projectId) {
      this.setState({ workspacesByProjectId });
      return;
    }
    this.setState({ workspaces, workspacesByProjectId, ...this.refreshedSelection(state.selectedWorkspace, workspaces) });
  }

  /**
   * Re-points `selectedWorkspace` at its refreshed entry when any browser-visible field changed
   * outside PI WEB (owner metadata, effective config, a branch switch, and so on), so the
   * workspace list and surfaces reading the selection cannot disagree. Keyed by id, so
   * this never changes *which* workspace is selected and never triggers the session/terminal
   * teardown in `handleWorkspaceChange`. Returns nothing when the entry is gone or unchanged,
   * so an unchanged refresh does not churn object identity into state.
   */
  private refreshedSelection(selected: Workspace | undefined, workspaces: Workspace[]): Pick<AppState, "selectedWorkspace"> | undefined {
    if (selected === undefined) return undefined;
    const refreshed = workspaces.find((candidate) => candidate.id === selected.id);
    if (refreshed === undefined || sameWorkspaceSnapshot(selected, refreshed)) return undefined;
    return { selectedWorkspace: refreshed };
  }
}

function selectFallbackWorkspace(workspaces: Workspace[]): Workspace | undefined {
  return workspaces.find((workspace) => workspace.isMain) ?? workspaces[0];
}

function sameWorkspaceSnapshot(left: Workspace, right: Workspace): boolean {
  return sameBrowserObservableValue(left, right);
}

/** Compare the complete parsed workspace payload, including future additive fields. */
function sameBrowserObservableValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameBrowserObservableValue(value, right[index]));
  }
  if (!isBrowserObservableRecord(left) || !isBrowserObservableRecord(right)) return false;

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key)
      && sameBrowserObservableValue(left[key], right[key]));
}

function isBrowserObservableRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

