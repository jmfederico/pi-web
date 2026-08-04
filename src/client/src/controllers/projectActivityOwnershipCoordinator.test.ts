import { describe, expect, it, vi } from "vitest";
import type { AppState } from "../appState";
import { initialAppState } from "../appState";
import type { Machine, Project, Workspace, WorkspaceActivity } from "../api";
import { projectActivityIndicator } from "../workspaceActivity";
import { ActivityController } from "./activityController";
import { ProjectActivityOwnershipCoordinator } from "./projectActivityOwnershipCoordinator";
import { ProjectController } from "./projectController";

const localMachine: Machine = {
  id: "local",
  name: "Local",
  kind: "local",
  createdAt: "now",
  updatedAt: "now",
};

function project(id = "p1", path = "/repo"): Project {
  return { id, name: id, path, createdAt: "now" };
}

function workspace(projectId: string, path: string): Workspace {
  return {
    id: path,
    projectId,
    path,
    label: path,
    isMain: path === "/repo",
    effectiveConfig: {},
  };
}

function activity(cwd: string, patch: Partial<WorkspaceActivity> = {}): WorkspaceActivity {
  return { cwd, hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "now", ...patch };
}

function machine(id: string): Machine {
  return {
    id,
    name: id,
    kind: id === "local" ? "local" : "remote",
    createdAt: "now",
    updatedAt: "now",
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolveDeferred: ((value: T) => void) | undefined;
  let rejectDeferred: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  if (resolveDeferred === undefined || rejectDeferred === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

describe("ProjectActivityOwnershipCoordinator", () => {
  it("hydrates an external worktree before project selection without changing selection state", async () => {
    const candidate = project();
    const externalActivity = activity("/tmp/repo-worktree");
    const discoveredWorkspaces = [workspace(candidate.id, candidate.path), workspace(candidate.id, externalActivity.cwd)];
    let state: AppState = {
      ...initialAppState(),
      selectedMachine: localMachine,
      projects: [candidate],
      workspaceActivities: { [externalActivity.cwd]: externalActivity },
    };
    const initialSelection = {
      selectedProject: state.selectedProject,
      selectedWorkspace: state.selectedWorkspace,
      selectedSession: state.selectedSession,
      workspaces: state.workspaces,
      mainView: state.mainView,
      workspaceTool: state.workspaceTool,
    };
    const loadWorkspaces = vi.fn<(projectId: string, machineId?: string) => Promise<Workspace[]>>()
      .mockResolvedValue(discoveredWorkspaces);
    const coordinator = new ProjectActivityOwnershipCoordinator(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { api: { workspaces: loadWorkspaces } },
    );

    expect(projectActivityIndicator(candidate, [], state.workspaceActivities)).toBeUndefined();

    await coordinator.handleActivityApplied(localMachine.id);

    expect(loadWorkspaces).toHaveBeenCalledOnce();
    expect(loadWorkspaces).toHaveBeenCalledWith(candidate.id, localMachine.id);
    expect(state.workspacesByProjectId[candidate.id]).toEqual(discoveredWorkspaces);
    expect(projectActivityIndicator(candidate, state.workspacesByProjectId[candidate.id] ?? [], state.workspaceActivities)).toBe("session");
    expect({
      selectedProject: state.selectedProject,
      selectedWorkspace: state.selectedWorkspace,
      selectedSession: state.selectedSession,
      workspaces: state.workspaces,
      mainView: state.mainView,
      workspaceTool: state.workspaceTool,
    }).toEqual(initialSelection);
  });

  it("does not request workspace topology for activity inside a project root", async () => {
    const candidate = project();
    const inRootActivity = activity("/repo/packages/client");
    let state: AppState = {
      ...initialAppState(),
      selectedMachine: localMachine,
      projects: [candidate],
      workspaceActivities: { [inRootActivity.cwd]: inRootActivity },
    };
    const loadWorkspaces = vi.fn<(projectId: string, machineId?: string) => Promise<Workspace[]>>();
    const coordinator = new ProjectActivityOwnershipCoordinator(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { api: { workspaces: loadWorkspaces } },
    );

    await coordinator.handleActivityApplied(localMachine.id);

    expect(loadWorkspaces).not.toHaveBeenCalled();
    expect(projectActivityIndicator(candidate, [], state.workspaceActivities)).toBe("session");
  });

  it("refreshes a populated but stale cache for a newly active external worktree", async () => {
    const candidate = project();
    const mainWorkspace = workspace(candidate.id, candidate.path);
    const externalWorkspace = workspace(candidate.id, "/tmp/new-worktree");
    const externalActivity = activity(externalWorkspace.path);
    let state: AppState = {
      ...initialAppState(),
      selectedMachine: localMachine,
      projects: [candidate],
      workspacesByProjectId: { [candidate.id]: [mainWorkspace] },
      workspaceActivities: { [externalActivity.cwd]: externalActivity },
    };
    const loadWorkspaces = vi.fn<(projectId: string, machineId?: string) => Promise<Workspace[]>>()
      .mockResolvedValue([mainWorkspace, externalWorkspace]);
    const coordinator = new ProjectActivityOwnershipCoordinator(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { api: { workspaces: loadWorkspaces } },
    );

    await coordinator.handleActivityApplied(localMachine.id);

    expect(loadWorkspaces).toHaveBeenCalledOnce();
    expect(state.workspacesByProjectId[candidate.id]).toEqual([mainWorkspace, externalWorkspace]);
  });

  it("coalesces several unknown CWDs into one pass and resolves them from one topology response", async () => {
    const candidate = project();
    const firstActivity = activity("/tmp/worktree-one");
    const secondActivity = activity("/tmp/worktree-two");
    const discoveredWorkspaces = [
      workspace(candidate.id, candidate.path),
      workspace(candidate.id, firstActivity.cwd),
      workspace(candidate.id, secondActivity.cwd),
    ];
    let state: AppState = {
      ...initialAppState(),
      selectedMachine: localMachine,
      projects: [candidate],
      workspaceActivities: {
        [firstActivity.cwd]: firstActivity,
        [secondActivity.cwd]: secondActivity,
      },
    };
    const loadWorkspaces = vi.fn<(projectId: string, machineId?: string) => Promise<Workspace[]>>()
      .mockResolvedValue(discoveredWorkspaces);
    const coordinator = new ProjectActivityOwnershipCoordinator(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { api: { workspaces: loadWorkspaces } },
    );

    await coordinator.handleActivityApplied(localMachine.id);
    state = {
      ...state,
      workspaceActivities: {
        [firstActivity.cwd]: { ...firstActivity, updatedAt: "heartbeat" },
        [secondActivity.cwd]: { ...secondActivity, updatedAt: "heartbeat" },
      },
    };
    await coordinator.handleActivityApplied(localMachine.id);

    expect(loadWorkspaces).toHaveBeenCalledOnce();
    expect(projectActivityIndicator(candidate, discoveredWorkspaces, state.workspaceActivities)).toBe("session");
  });

  it("shares an in-flight pass and does not loop after a full negative result", async () => {
    const candidate = project();
    const unknownActivity = activity("/tmp/unmatched");
    const response = deferred<Workspace[]>();
    let state: AppState = {
      ...initialAppState(),
      selectedMachine: localMachine,
      projects: [candidate],
      workspaceActivities: { [unknownActivity.cwd]: unknownActivity },
    };
    const loadWorkspaces = vi.fn<(projectId: string, machineId?: string) => Promise<Workspace[]>>()
      .mockReturnValue(response.promise);
    const coordinator = new ProjectActivityOwnershipCoordinator(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { api: { workspaces: loadWorkspaces } },
    );

    const firstPass = coordinator.handleActivityApplied(localMachine.id);
    const duplicatePasses = [
      coordinator.handleActivityApplied(localMachine.id),
      coordinator.handleActivityApplied(localMachine.id),
    ];

    expect(loadWorkspaces).toHaveBeenCalledOnce();

    response.resolve([]);
    await Promise.all([firstPass, ...duplicatePasses]);
    state = {
      ...state,
      workspaceActivities: {
        [unknownActivity.cwd]: { ...unknownActivity, updatedAt: "later-heartbeat" },
      },
    };
    await coordinator.handleActivityApplied(localMachine.id);

    expect(loadWorkspaces).toHaveBeenCalledOnce();
  });

  it("coalesces CWDs arriving during a pass into at most one trailing pass", async () => {
    const candidate = project();
    const firstResponse = deferred<Workspace[]>();
    const trailingResponse = deferred<Workspace[]>();
    const trailingStarted = deferred<undefined>();
    const firstActivity = activity("/tmp/first");
    const secondActivity = activity("/tmp/second");
    const thirdActivity = activity("/tmp/third");
    let state: AppState = {
      ...initialAppState(),
      selectedMachine: localMachine,
      projects: [candidate],
      workspaceActivities: { [firstActivity.cwd]: firstActivity },
    };
    let requestCount = 0;
    const loadWorkspaces = vi.fn<(projectId: string, machineId?: string) => Promise<Workspace[]>>()
      .mockImplementation(() => {
        requestCount += 1;
        if (requestCount === 1) return firstResponse.promise;
        trailingStarted.resolve(undefined);
        return trailingResponse.promise;
      });
    const coordinator = new ProjectActivityOwnershipCoordinator(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { api: { workspaces: loadWorkspaces } },
    );

    const firstPass = coordinator.handleActivityApplied(localMachine.id);
    state = {
      ...state,
      workspaceActivities: {
        [firstActivity.cwd]: firstActivity,
        [secondActivity.cwd]: secondActivity,
        [thirdActivity.cwd]: thirdActivity,
      },
    };
    const arrivalNotifications = [
      coordinator.handleActivityApplied(localMachine.id),
      coordinator.handleActivityApplied(localMachine.id),
      coordinator.handleActivityApplied(localMachine.id),
    ];

    expect(loadWorkspaces).toHaveBeenCalledOnce();

    firstResponse.resolve([]);
    await trailingStarted.promise;
    expect(loadWorkspaces).toHaveBeenCalledTimes(2);

    state = {
      ...state,
      workspaceActivities: Object.fromEntries(Object.entries(state.workspaceActivities).map(([cwd, current]) => [
        cwd,
        { ...current, updatedAt: "heartbeat-during-trailing-pass" },
      ])),
    };
    const trailingHeartbeats = [
      coordinator.handleActivityApplied(localMachine.id),
      coordinator.handleActivityApplied(localMachine.id),
    ];
    trailingResponse.resolve([]);
    await Promise.all([firstPass, ...arrivalNotifications, ...trailingHeartbeats]);
    await coordinator.handleActivityApplied(localMachine.id);

    expect(loadWorkspaces).toHaveBeenCalledTimes(2);
  });

  it("permits one fresh pass after inactivity/reactivation and after applied topology invalidation", async () => {
    const candidate = project();
    const unknownActivity = activity("/tmp/reactivated");
    let state: AppState = {
      ...initialAppState(),
      selectedMachine: localMachine,
      projects: [candidate],
      workspaceActivities: { [unknownActivity.cwd]: unknownActivity },
    };
    const loadWorkspaces = vi.fn<(projectId: string, machineId?: string) => Promise<Workspace[]>>()
      .mockResolvedValue([]);
    const coordinator = new ProjectActivityOwnershipCoordinator(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { api: { workspaces: loadWorkspaces } },
    );

    await coordinator.handleActivityApplied(localMachine.id);
    await coordinator.handleActivityApplied(localMachine.id);
    expect(loadWorkspaces).toHaveBeenCalledTimes(1);

    state = { ...state, workspaceActivities: {} };
    await coordinator.handleActivityApplied(localMachine.id);
    state = {
      ...state,
      workspaceActivities: {
        [unknownActivity.cwd]: { ...unknownActivity, updatedAt: "reactivated" },
      },
    };
    await coordinator.handleActivityApplied(localMachine.id);
    expect(loadWorkspaces).toHaveBeenCalledTimes(2);

    await coordinator.handleProjectsApplied(localMachine.id);
    await coordinator.handleActivityApplied(localMachine.id);
    expect(loadWorkspaces).toHaveBeenCalledTimes(3);
  });

  it("discovers terminal-only activity while keeping an unmatched terminal CWD bounded", async () => {
    const candidate = project();
    const ownedActivity = activity("/tmp/terminal-worktree", { hasSessionActivity: false, hasTerminalActivity: true });
    const unmatchedActivity = activity("/tmp/unmatched-terminal", { hasSessionActivity: false, hasTerminalActivity: true });
    const discoveredWorkspaces = [workspace(candidate.id, candidate.path), workspace(candidate.id, ownedActivity.cwd)];
    let state: AppState = {
      ...initialAppState(),
      selectedMachine: localMachine,
      projects: [candidate],
      workspaceActivities: {
        [ownedActivity.cwd]: ownedActivity,
        [unmatchedActivity.cwd]: unmatchedActivity,
      },
    };
    const loadWorkspaces = vi.fn<(projectId: string, machineId?: string) => Promise<Workspace[]>>()
      .mockResolvedValue(discoveredWorkspaces);
    const coordinator = new ProjectActivityOwnershipCoordinator(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { api: { workspaces: loadWorkspaces } },
    );

    await coordinator.handleActivityApplied(localMachine.id);
    await coordinator.handleActivityApplied(localMachine.id);

    expect(loadWorkspaces).toHaveBeenCalledOnce();
    expect(projectActivityIndicator(candidate, discoveredWorkspaces, state.workspaceActivities)).toBe("terminal");
  });

  it("ignores non-selected-machine notifications without consuming the selected machine's activity gate", async () => {
    const candidate = project();
    const externalActivity = activity("/tmp/selected-machine-worktree");
    let state: AppState = {
      ...initialAppState(),
      selectedMachine: localMachine,
      projects: [candidate],
      workspaceActivities: { [externalActivity.cwd]: externalActivity },
    };
    const loadWorkspaces = vi.fn<(projectId: string, machineId?: string) => Promise<Workspace[]>>()
      .mockResolvedValue([workspace(candidate.id, externalActivity.cwd)]);
    const coordinator = new ProjectActivityOwnershipCoordinator(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { api: { workspaces: loadWorkspaces } },
    );

    await coordinator.handleActivityApplied("remote");
    await coordinator.handleProjectsApplied(localMachine.id);
    expect(loadWorkspaces).not.toHaveBeenCalled();

    await coordinator.handleActivityApplied(localMachine.id);

    expect(loadWorkspaces).toHaveBeenCalledOnce();
    expect(loadWorkspaces).toHaveBeenCalledWith(candidate.id, localMachine.id);
  });

  it("rejects a deferred response after an A-to-B-to-A machine transition", async () => {
    const machineA = machine("machine-a");
    const machineB = machine("machine-b");
    const candidate = project();
    const externalActivity = activity("/tmp/machine-a-worktree");
    const staleResponse = deferred<Workspace[]>();
    const currentWorkspaces = [workspace(candidate.id, candidate.path), workspace(candidate.id, externalActivity.cwd)];
    let state: AppState = {
      ...initialAppState(),
      selectedMachine: machineA,
      projects: [candidate],
      workspaceActivities: { [externalActivity.cwd]: externalActivity },
    };
    const loadWorkspaces = vi.fn<(projectId: string, machineId?: string) => Promise<Workspace[]>>()
      .mockImplementationOnce(() => staleResponse.promise)
      .mockResolvedValueOnce(currentWorkspaces);
    const coordinator = new ProjectActivityOwnershipCoordinator(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { api: { workspaces: loadWorkspaces } },
    );

    const stalePass = coordinator.handleActivityApplied(machineA.id);
    state = {
      ...state,
      selectedMachine: machineB,
      projects: [],
      workspaceActivities: {},
      workspacesByProjectId: {},
    };
    coordinator.handleSelectedMachineChanged();
    state = {
      ...state,
      selectedMachine: machineA,
      projects: [candidate],
      workspaceActivities: { [externalActivity.cwd]: externalActivity },
      workspacesByProjectId: {},
    };
    coordinator.handleSelectedMachineChanged();

    staleResponse.resolve([workspace(candidate.id, externalActivity.cwd)]);
    await stalePass;

    expect(state.workspacesByProjectId[candidate.id]).toBeUndefined();

    await coordinator.handleActivityApplied(machineA.id);

    expect(loadWorkspaces).toHaveBeenCalledTimes(2);
    expect(loadWorkspaces).toHaveBeenNthCalledWith(1, candidate.id, machineA.id);
    expect(loadWorkspaces).toHaveBeenNthCalledWith(2, candidate.id, machineA.id);
    expect(state.workspacesByProjectId[candidate.id]).toEqual(currentWorkspaces);
  });

  it("does not resurrect a project removed while discovery is in flight", async () => {
    const candidate = project();
    const externalActivity = activity("/tmp/removed-project-worktree");
    const staleResponse = deferred<Workspace[]>();
    let state: AppState = {
      ...initialAppState(),
      selectedMachine: localMachine,
      projects: [candidate],
      workspaceActivities: { [externalActivity.cwd]: externalActivity },
    };
    const loadWorkspaces = vi.fn<(projectId: string, machineId?: string) => Promise<Workspace[]>>()
      .mockReturnValue(staleResponse.promise);
    const coordinator = new ProjectActivityOwnershipCoordinator(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { api: { workspaces: loadWorkspaces } },
    );

    const stalePass = coordinator.handleActivityApplied(localMachine.id);
    state = { ...state, projects: [], workspacesByProjectId: {} };
    await coordinator.handleProjectsApplied(localMachine.id);
    staleResponse.resolve([workspace(candidate.id, externalActivity.cwd)]);
    await stalePass;

    expect(state.projects).toEqual([]);
    expect(state.workspacesByProjectId[candidate.id]).toBeUndefined();
  });

  it("rejects an old pass after a project-list replacement and applies only the new pass", async () => {
    const originalProject = project("p1", "/old-repo");
    const replacementProject = project("p1", "/new-repo");
    const externalActivity = activity("/tmp/replacement-worktree");
    const staleResponse = deferred<Workspace[]>();
    const currentResponse = deferred<Workspace[]>();
    const staleWorkspaces = [workspace(originalProject.id, originalProject.path), workspace(originalProject.id, externalActivity.cwd)];
    const currentWorkspaces = [workspace(replacementProject.id, replacementProject.path), workspace(replacementProject.id, externalActivity.cwd)];
    let state: AppState = {
      ...initialAppState(),
      selectedMachine: localMachine,
      projects: [originalProject],
      workspaceActivities: { [externalActivity.cwd]: externalActivity },
    };
    const loadWorkspaces = vi.fn<(projectId: string, machineId?: string) => Promise<Workspace[]>>()
      .mockImplementationOnce(() => staleResponse.promise)
      .mockImplementationOnce(() => currentResponse.promise);
    const coordinator = new ProjectActivityOwnershipCoordinator(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { api: { workspaces: loadWorkspaces } },
    );

    const stalePass = coordinator.handleActivityApplied(localMachine.id);
    state = { ...state, projects: [replacementProject] };
    const replacementPass = coordinator.handleProjectsApplied(localMachine.id);

    expect(loadWorkspaces).toHaveBeenCalledTimes(2);

    staleResponse.resolve(staleWorkspaces);
    await stalePass;
    expect(state.workspacesByProjectId[replacementProject.id]).toBeUndefined();

    currentResponse.resolve(currentWorkspaces);
    await replacementPass;
    expect(state.workspacesByProjectId[replacementProject.id]).toEqual(currentWorkspaces);
  });

  it("does not overwrite a newer per-project workspace-cache entry", async () => {
    const candidate = project();
    const externalActivity = activity("/tmp/stale-discovery-worktree");
    const originalCache = [workspace(candidate.id, candidate.path)];
    const newerCache = [...originalCache, workspace(candidate.id, "/tmp/newer-topology")];
    const staleResponse = deferred<Workspace[]>();
    let state: AppState = {
      ...initialAppState(),
      selectedMachine: localMachine,
      projects: [candidate],
      workspacesByProjectId: { [candidate.id]: originalCache },
      workspaceActivities: { [externalActivity.cwd]: externalActivity },
    };
    const loadWorkspaces = vi.fn<(projectId: string, machineId?: string) => Promise<Workspace[]>>()
      .mockReturnValue(staleResponse.promise);
    const coordinator = new ProjectActivityOwnershipCoordinator(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { api: { workspaces: loadWorkspaces } },
    );

    const stalePass = coordinator.handleActivityApplied(localMachine.id);
    state = {
      ...state,
      workspacesByProjectId: { ...state.workspacesByProjectId, [candidate.id]: newerCache },
    };
    staleResponse.resolve([...originalCache, workspace(candidate.id, externalActivity.cwd)]);
    await stalePass;
    await coordinator.handleActivityApplied(localMachine.id);

    expect(state.workspacesByProjectId[candidate.id]).toBe(newerCache);
    expect(loadWorkspaces).toHaveBeenCalledOnce();
  });

  it("reports partial failures without retries or selection/global-error side effects", async () => {
    const failedProject = project("failed", "/failed");
    const successfulProject = project("successful", "/successful");
    const selectedWorkspace = workspace(failedProject.id, failedProject.path);
    const unknownActivity = activity("/tmp/possibly-failed-owner");
    const failure = new Error("topology unavailable");
    const reporterFailure = new Error("reporter unavailable");
    let state: AppState = {
      ...initialAppState(),
      selectedMachine: localMachine,
      projects: [failedProject, successfulProject],
      selectedProject: failedProject,
      selectedWorkspace,
      workspaces: [selectedWorkspace],
      workspaceActivities: { [unknownActivity.cwd]: unknownActivity },
      error: "existing global error",
    };
    const initialSelection = {
      selectedProject: state.selectedProject,
      selectedWorkspace: state.selectedWorkspace,
      selectedSession: state.selectedSession,
      workspaces: state.workspaces,
      mainView: state.mainView,
    };
    const loadWorkspaces = vi.fn<(projectId: string, machineId?: string) => Promise<Workspace[]>>()
      .mockImplementation((projectId) => projectId === failedProject.id ? Promise.reject(failure) : Promise.resolve([]));
    const onError = vi.fn(() => { throw reporterFailure; });
    const coordinator = new ProjectActivityOwnershipCoordinator(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { api: { workspaces: loadWorkspaces }, onError },
    );

    await expect(coordinator.handleActivityApplied(localMachine.id)).resolves.toBeUndefined();
    await coordinator.handleActivityApplied(localMachine.id);

    expect(loadWorkspaces.mock.calls).toEqual([
      [failedProject.id, localMachine.id],
      [successfulProject.id, localMachine.id],
    ]);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith({ machineId: localMachine.id, projectId: failedProject.id, error: failure });
    expect(state.error).toBe("existing global error");
    expect({
      selectedProject: state.selectedProject,
      selectedWorkspace: state.selectedWorkspace,
      selectedSession: state.selectedSession,
      workspaces: state.workspaces,
      mainView: state.mainView,
    }).toEqual(initialSelection);
  });

  it.each(["activity-before-project", "project-before-activity"] as const)(
    "coordinates real controller hooks in %s ordering without opening the project",
    async (ordering) => {
      const candidate = project();
      const externalActivity = activity("/tmp/controller-ordered-worktree");
      const discoveredWorkspaces = [workspace(candidate.id, candidate.path), workspace(candidate.id, externalActivity.cwd)];
      let state: AppState = { ...initialAppState(), selectedMachine: localMachine };
      const ownershipTasks: Promise<void>[] = [];
      const loadWorkspaces = vi.fn<(projectId: string, machineId?: string) => Promise<Workspace[]>>()
        .mockResolvedValue(discoveredWorkspaces);
      const coordinator = new ProjectActivityOwnershipCoordinator(
        () => state,
        (patch) => { state = { ...state, ...patch }; },
        { api: { workspaces: loadWorkspaces } },
      );
      const activityController = new ActivityController(
        () => state,
        (patch) => { state = { ...state, ...patch }; },
        { onActivityApplied: (machineId) => { ownershipTasks.push(coordinator.handleActivityApplied(machineId)); } },
      );
      const selectProject = vi.fn();
      const projectController = new ProjectController(
        () => state,
        (patch) => { state = { ...state, ...patch }; },
        { selectProject, forgetProject: vi.fn(), clearSelection: vi.fn() },
        {
          api: {
            projects: vi.fn().mockResolvedValue([candidate]),
            addProject: vi.fn(),
            closeProject: vi.fn(),
          },
          onProjectsApplied: (machineId) => { ownershipTasks.push(coordinator.handleProjectsApplied(machineId)); },
        },
      );

      if (ordering === "activity-before-project") {
        activityController.applyWorkspaceActivity(externalActivity, localMachine.id);
        await projectController.loadProjects();
      } else {
        await projectController.loadProjects();
        activityController.applyWorkspaceActivity(externalActivity, localMachine.id);
      }
      await Promise.all(ownershipTasks);

      expect(loadWorkspaces).toHaveBeenCalledOnce();
      expect(state.workspacesByProjectId[candidate.id]).toEqual(discoveredWorkspaces);
      expect(projectActivityIndicator(candidate, discoveredWorkspaces, state.workspaceActivities)).toBe("session");
      expect(selectProject).not.toHaveBeenCalled();
      expect(state.selectedProject).toBeUndefined();
      expect(state.selectedWorkspace).toBeUndefined();
      expect(state.selectedSession).toBeUndefined();
    },
  );
});
