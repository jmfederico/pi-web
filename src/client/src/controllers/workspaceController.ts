import { api as defaultApi, type Project, type Workspace } from "../api";
import { resetWorkspaceScopedState, type AppState } from "../appState";
import { BrowserErrorReporter, projectBrowserErrorScope, workspaceBrowserErrorScope } from "../browserErrors";
import { mergeCachedNewSessions } from "../cachedNewSessions";
import { machineProjectKey } from "../machineKeys";
import { selectedMachineId, type GetState, type NavigationDestinationOptions, type NavigationFreshness, type NavigationScope, type NavigationSelection, type RouteTarget, type SetState, type UpdateUrl } from "./types";
import type { SessionController } from "./sessionController";
import { TrailingRefreshCoordinator } from "./trailingRefreshCoordinator";
import { InMemoryWorkspaceSelectionMemory, selectPreferredWorkspace, type WorkspaceSelectionMemory } from "./workspaceSelection";

const WORKSPACE_TOPOLOGY_REFRESH_DEBOUNCE_MS = 50;
const WORKSPACE_SELECTION_SCOPE = ["machine", "project", "workspace", "session"] as const;

export interface WorkspaceControllerDependencies {
  api?: Pick<typeof defaultApi, "sessions" | "workspaces" | "workspaceResolution">;
  navigateToWorkspace?: (workspace: Workspace | undefined, options?: NavigationDestinationOptions) => Promise<boolean>;
  captureNavigation?: () => NavigationSelection;
  beginNavigationOperation?: (scope: readonly NavigationScope[]) => NavigationFreshness;
  onBackgroundError?: (message: string, error: unknown) => void;
  topologyRefreshDebounceMs?: number;
}

interface WorkspaceMutationGuard {
  signal?: AbortSignal | undefined;
  isCurrent?: (() => boolean) | undefined;
}

type WorkspaceSelectionTarget = RouteTarget & WorkspaceMutationGuard;

export class WorkspaceController {
  private readonly api: Pick<typeof defaultApi, "sessions" | "workspaces" | "workspaceResolution">;
  private readonly navigateToWorkspace: WorkspaceControllerDependencies["navigateToWorkspace"];
  private readonly captureNavigation: WorkspaceControllerDependencies["captureNavigation"];
  private readonly beginNavigationOperation: WorkspaceControllerDependencies["beginNavigationOperation"];
  private readonly onBackgroundError: (message: string, error: unknown) => void;
  private readonly browserErrors: BrowserErrorReporter;
  private readonly topologyRefreshes: TrailingRefreshCoordinator<string>;
  private readonly workspaceListRequests = new Map<string, number>();

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    private readonly updateUrl: UpdateUrl,
    private readonly sessions: Pick<SessionController, "clearActiveSession" | "preferredSession" | "selectSession">,
    private readonly workspaceSelection: WorkspaceSelectionMemory = new InMemoryWorkspaceSelectionMemory(),
    deps: WorkspaceControllerDependencies = {},
  ) {
    this.api = deps.api ?? defaultApi;
    this.navigateToWorkspace = deps.navigateToWorkspace;
    this.captureNavigation = deps.captureNavigation;
    this.beginNavigationOperation = deps.beginNavigationOperation;
    this.onBackgroundError = deps.onBackgroundError ?? ((message, error) => { console.warn(message, error); });
    this.browserErrors = new BrowserErrorReporter(getState, setState);
    this.topologyRefreshes = new TrailingRefreshCoordinator(
      deps.topologyRefreshDebounceMs ?? WORKSPACE_TOPOLOGY_REFRESH_DEBOUNCE_MS,
    );
  }

  clearSelection(options?: { updateUrl?: boolean | undefined }) {
    this.sessions.clearActiveSession();
    this.setState({ selectedProject: undefined, workspaceResolution: undefined, selectedWorkspace: undefined, workspaces: [], isLoadingWorkspaces: false, ...resetWorkspaceScopedState() });
    if (options?.updateUrl !== false) this.updateUrl();
  }

  forgetProject(projectId: string): void {
    const machineId = selectedMachineId(this.getState());
    this.browserErrors.discard(projectBrowserErrorScope(machineId, projectId));
    this.workspaceSelection.forgetProject(machineProjectKey(machineId, projectId));
    const workspacesByProjectId = Object.fromEntries(Object.entries(this.getState().workspacesByProjectId).filter(([candidate]) => candidate !== projectId));
    this.setState({ workspacesByProjectId });
  }

  async selectProject(project: Project, target?: WorkspaceSelectionTarget): Promise<string | undefined> {
    const navigation = target?.navigation ?? this.beginNavigationOperation?.(WORKSPACE_SELECTION_SCOPE);
    if (!this.navigationIsCurrent(navigation)) return;
    const machineId = selectedMachineId(this.getState());
    const errorScope = projectBrowserErrorScope(machineId, project.id);
    this.sessions.clearActiveSession();
    this.setState({ selectedProject: project, workspaceResolution: undefined, selectedWorkspace: undefined, workspaces: [], isLoadingWorkspaces: true, ...resetWorkspaceScopedState() });
    const listRequestIsCurrent = this.beginWorkspaceListRequest(project.id, machineId);
    try {
      const resolution = await this.api.workspaceResolution(project.id, machineId);
      const workspaces = [...resolution.workspaces];
      if (!listRequestIsCurrent()
        || !this.navigationIsCurrent(navigation)
        || selectedMachineId(this.getState()) !== machineId
        || this.getState().selectedProject?.id !== project.id) return;
      this.setState({ workspaceResolution: resolution, workspaces, workspacesByProjectId: { ...this.getState().workspacesByProjectId, [project.id]: workspaces }, isLoadingWorkspaces: false });
      if (resolution.status === "degraded") throw new Error(resolution.diagnostics.map(({ message }) => message).join("; ") || "Workspace authority is degraded");
      const workspace = selectPreferredWorkspace(workspaces, { targetWorkspaceId: target?.workspaceId, latestWorkspaceId: this.workspaceSelection.latestWorkspaceId(machineProjectKey(machineId, project.id)) });
      if (workspace) {
        return await this.selectWorkspace(workspace, { sessionId: target?.sessionId, updateUrl: target?.updateUrl, navigation });
      }
      if (target?.workspaceId !== undefined && target.workspaceId !== "") {
        this.browserErrors.report(errorScope, `Workspace not found: ${target.workspaceId}`);
        return `Workspace not found: ${target.workspaceId}`;
      }
      if (target?.updateUrl !== false && this.navigationIsCurrent(navigation)) this.updateUrl();
    } catch (error) {
      if (this.navigationIsCurrent(navigation)
        && workspaceMutationIsCurrent(target)
        && selectedMachineId(this.getState()) === machineId
        && this.getState().selectedProject?.id === project.id) this.setState({ isLoadingWorkspaces: false });
      if (target?.signal?.aborted !== true) this.browserErrors.report(errorScope, String(error));
      return String(error);
    }
    return undefined;
  }

  async selectWorkspace(workspace: Workspace, target?: WorkspaceSelectionTarget): Promise<string | undefined> {
    const navigation = target?.navigation ?? this.beginNavigationOperation?.(WORKSPACE_SELECTION_SCOPE);
    if (!this.navigationIsCurrent(navigation) || !workspaceMutationIsCurrent(target)) return;
    const machineId = selectedMachineId(this.getState());
    const errorScope = workspaceBrowserErrorScope(machineId, workspace.projectId, workspace.id);
    this.workspaceSelection.rememberWorkspace({ ...workspace, projectId: machineProjectKey(machineId, workspace.projectId) });
    this.sessions.clearActiveSession();
    this.setState({ selectedWorkspace: workspace, isLoadingWorkspaces: false, ...resetWorkspaceScopedState() });
    try {
      const loadedSessions = target?.signal === undefined
        ? await this.api.sessions(workspace.path, machineId)
        : await this.api.sessions(workspace.path, machineId, { signal: target.signal });
      const sessions = mergeCachedNewSessions(workspace.path, loadedSessions, machineId);
      if (!this.navigationIsCurrent(navigation)
        || !workspaceMutationIsCurrent(target)
        || selectedMachineId(this.getState()) !== machineId
        || this.getState().selectedWorkspace?.id !== workspace.id
        || this.getState().selectedProject?.id !== workspace.projectId) return;
      this.setState({ sessions });
      const session = this.sessions.preferredSession(workspace.path, sessions, target?.sessionId);
      if (!this.navigationIsCurrent(navigation) || !workspaceMutationIsCurrent(target)) return;
      if (session) await this.sessions.selectSession(session, { deferChatLoading: true, updateUrl: target?.updateUrl, ...(navigation === undefined ? {} : { navigation }) });
      else if (target?.sessionId !== undefined && target.sessionId !== "") {
        this.browserErrors.report(errorScope, `Session not found: ${target.sessionId}`);
        return `Session not found: ${target.sessionId}`;
      }
      else if (target?.updateUrl !== false) this.updateUrl();
    } catch (error) {
      if (target?.signal?.aborted !== true) this.browserErrors.report(errorScope, String(error));
      return String(error);
    }
    return undefined;
  }


  async refreshProjectWorkspaces(
    projectId: string,
    machineId = selectedMachineId(this.getState()),
    options?: WorkspaceMutationGuard,
  ): Promise<Workspace[]> {
    return (await this.refreshProjectWorkspaceList(projectId, machineId, options)).workspaces;
  }

  private async refreshProjectWorkspaceList(
    projectId: string,
    machineId: string,
    options?: WorkspaceMutationGuard,
  ): Promise<{ workspaces: Workspace[]; isCurrent: () => boolean }> {
    if (!workspaceMutationIsCurrent(options)) return { workspaces: [], isCurrent: () => false };
    const project = this.getState().projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new Error("Project not found");
    const isCurrent = this.beginWorkspaceListRequest(projectId, machineId);
    const resolution = options?.signal === undefined
      ? await this.api.workspaceResolution(project.id, machineId)
      : await this.api.workspaceResolution(project.id, machineId, { signal: options.signal });
    const workspaces = [...resolution.workspaces];
    if (isCurrent() && workspaceMutationIsCurrent(options) && selectedMachineId(this.getState()) === machineId) {
      if (this.getState().selectedProject?.id === project.id) this.setState({ workspaceResolution: resolution });
      if (resolution.status === "degraded") throw new Error(resolution.diagnostics.map(({ message }) => message).join("; ") || "Workspace authority is degraded");
      this.applyProjectWorkspaces(project.id, workspaces);
    }
    return { workspaces, isCurrent };
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
    // Explicit project navigation already loads topology and owns selection.
    if (project === undefined || state.isLoadingWorkspaces) return;
    const machineId = selectedMachineId(state);
    // Callers are independent (browser resume and the plugin-facing app refresh), so two
    // refreshes for the same machine+project can overlap. Sharing one request keeps a slow
    // earlier response from landing last and overwriting a newer list, which would make a
    // just-created worktree disappear again.
    await this.topologyRefreshes.request(machineProjectKey(machineId, project.id), async () => {
      if (this.getState().isLoadingWorkspaces) return;
      const listRequestIsCurrent = this.beginWorkspaceListRequest(project.id, machineId);
      try {
        const resolution = await this.api.workspaceResolution(project.id, machineId);
        const current = this.getState();
        if (!listRequestIsCurrent() || selectedMachineId(current) !== machineId || current.selectedProject?.id !== project.id) return;
        this.setState({ workspaceResolution: resolution });
        // A provider outage is not evidence of removal. Automatic hints and
        // reconnects must not replace a previously healthy topology with fallback.
        if (resolution.status === "degraded") {
          throw new Error(resolution.diagnostics.map(({ message }) => message).join("; ") || "Workspace authority is degraded");
        }
        this.applyProjectWorkspaces(project.id, [...resolution.workspaces]);
      } catch (error) {
        this.onBackgroundError(`Failed to refresh workspaces for project ${project.id} on ${machineId}`, error);
      }
    });
  }

  async refreshAfterWorkspaceDeleted(
    projectId: string,
    workspaceId: string,
    machineId = selectedMachineId(this.getState()),
    options?: WorkspaceMutationGuard,
  ): Promise<void> {
    if (!workspaceMutationIsCurrent(options)) return;
    const navigation = this.beginNavigationOperation?.(WORKSPACE_SELECTION_SCOPE);
    const { workspaces, isCurrent } = await this.refreshProjectWorkspaceList(projectId, machineId, options);
    if (!isCurrent() || !this.navigationIsCurrent(navigation) || !workspaceMutationIsCurrent(options)) return;
    const state = this.getState();
    if (selectedMachineId(state) !== machineId || state.selectedProject?.id !== projectId || state.selectedWorkspace?.id !== workspaceId) return;

    const expected = navigationSelection(this.getState(), this.captureNavigation);
    const fallback = selectFallbackWorkspace(workspaces);
    if (this.navigateToWorkspace !== undefined) {
      await this.navigateToWorkspace(fallback, { expected });
    } else if (fallback !== undefined) {
      await this.selectWorkspace(fallback, { ...options, ...(navigation === undefined ? {} : { navigation }) });
    } else if (this.navigationIsCurrent(navigation) && workspaceMutationIsCurrent(options)) {
      this.clearSelection();
    }
  }

  /** Every list writer shares this counter: only the newest request may publish. */
  private beginWorkspaceListRequest(projectId: string, machineId: string): () => boolean {
    const key = machineProjectKey(machineId, projectId);
    const request = (this.workspaceListRequests.get(key) ?? 0) + 1;
    this.workspaceListRequests.set(key, request);
    return () => this.workspaceListRequests.get(key) === request;
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
  private navigationIsCurrent(navigation: NavigationFreshness | undefined): boolean {
    return navigation === undefined || navigation.isCurrent();
  }

  private refreshedSelection(selected: Workspace | undefined, workspaces: Workspace[]): Pick<AppState, "selectedWorkspace"> | undefined {
    if (selected === undefined) return undefined;
    const refreshed = workspaces.find((candidate) => candidate.id === selected.id);
    if (refreshed === undefined || sameWorkspaceSnapshot(selected, refreshed)) return undefined;
    return { selectedWorkspace: refreshed };
  }
}

function navigationSelection(state: ReturnType<GetState>, captureNavigation?: () => NavigationSelection): NavigationSelection {
  return captureNavigation?.() ?? {
    machineId: selectedMachineId(state),
    projectId: state.selectedProject?.id,
    workspaceId: state.selectedWorkspace?.id,
    ...(state.selectedSession === undefined || Reflect.get(state.selectedSession, "clientPendingStart") !== true ? { sessionId: state.selectedSession?.id } : {}),
  };
}

function workspaceMutationIsCurrent(options: WorkspaceMutationGuard | undefined): boolean {
  return options?.signal?.aborted !== true && options?.isCurrent?.() !== false;
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

