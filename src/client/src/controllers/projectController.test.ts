import { describe, expect, it, vi } from "vitest";
import type { AppState } from "../appState";
import { initialAppState } from "../appState";
import type { Project, Workspace } from "../api";
import { browserErrorScopeKey, machineBrowserErrorScope, projectBrowserErrorScope } from "../browserErrors";
import { ProjectController } from "./projectController";

function project(id: string, path: string): Project {
  return { id, name: id, path, createdAt: "now" };
}

function workspace(projectId: string, path: string): Workspace {
  return { id: path, projectId, path, label: path, isMain: true, effectiveConfig: {} };
}

describe("ProjectController", () => {
  it("reports project loading failures under the selected machine", async () => {
    let state: AppState = { ...initialAppState(), error: "A global failure" };
    const setState = (patch: Partial<AppState>) => { state = { ...state, ...patch }; };
    const failure = new Error("Projects unavailable");
    const controller = new ProjectController(
      () => state,
      setState,
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects: vi.fn().mockRejectedValue(failure),
          addProject: vi.fn(),
          closeProject: vi.fn(),
          setWorkspaceTrust: vi.fn(),
        },
      },
    );

    await controller.loadProjects();

    expect(state.error).toBe("A global failure");
    expect(state.browserErrors[browserErrorScopeKey(machineBrowserErrorScope("local"))]?.message).toBe(String(failure));
  });

  it("reports project close failures under that project without overwriting a global error", async () => {
    let state: AppState = { ...initialAppState(), error: "A global failure" };
    const setState = (patch: Partial<AppState>) => { state = { ...state, ...patch }; };
    const failure = new Error("Project is busy");
    const controller = new ProjectController(
      () => state,
      setState,
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects: vi.fn(),
          addProject: vi.fn(),
          closeProject: vi.fn().mockRejectedValue(failure),
          setWorkspaceTrust: vi.fn(),
        },
      },
    );

    await controller.closeProject("project-a");

    expect(state.error).toBe("A global failure");
    expect(state.browserErrors[browserErrorScopeKey(projectBrowserErrorScope("local", "project-a"))]?.message).toBe(String(failure));
  });

  it("reports a project creation failure under the selected machine", async () => {
    let state: AppState = { ...initialAppState(), error: "A global failure" };
    const setState = (patch: Partial<AppState>) => { state = { ...state, ...patch }; };
    const failure = new Error("Project path is invalid");
    const controller = new ProjectController(
      () => state,
      setState,
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects: vi.fn(),
          addProject: vi.fn().mockRejectedValue(failure),
          closeProject: vi.fn(),
          setWorkspaceTrust: vi.fn(),
        },
      },
    );

    await controller.addProject("/invalid");

    expect(state.error).toBe("A global failure");
    expect(state.browserErrors[browserErrorScopeKey(machineBrowserErrorScope("local"))]?.message).toBe(String(failure));
  });

  it("reports trust-write failures under the project that was added", async () => {
    const addedProject = project("added", "/added");
    const addedWorkspace = workspace(addedProject.id, addedProject.path);
    let state: AppState = { ...initialAppState() };
    const setState = (patch: Partial<AppState>) => { state = { ...state, ...patch }; };
    const failure = new Error("Trust write failed");
    const selectProject = vi.fn(() => {
      state = { ...state, workspaces: [addedWorkspace] };
      return Promise.resolve();
    });
    const controller = new ProjectController(
      () => state,
      setState,
      { selectProject, forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects: vi.fn(),
          addProject: vi.fn().mockResolvedValue(addedProject),
          closeProject: vi.fn(),
          setWorkspaceTrust: vi.fn().mockRejectedValue(failure),
        },
      },
    );

    await controller.addProject("/added", undefined, { trusted: true, changed: true });

    expect(state.browserErrors[browserErrorScopeKey(projectBrowserErrorScope("local", addedProject.id))]?.message).toBe(String(failure));
  });

  it("drops cached workspaces for projects a reload no longer lists", async () => {
    const currentProject = project("current", "/current");
    const removedProject = project("removed", "/removed");
    let state: AppState = {
      ...initialAppState(),
      projects: [removedProject],
      workspacesByProjectId: {
        [currentProject.id]: [workspace(currentProject.id, currentProject.path)],
        [removedProject.id]: [workspace(removedProject.id, removedProject.path)],
      },
    };
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects: vi.fn().mockResolvedValue([currentProject]),
          addProject: vi.fn(),
          closeProject: vi.fn(),
          setWorkspaceTrust: vi.fn(),
        },
      },
    );

    await controller.loadProjects();

    expect(state.projects).toEqual([currentProject]);
    expect(state.workspacesByProjectId).toEqual({
      [currentProject.id]: [workspace(currentProject.id, currentProject.path)],
    });
  });

  it("closes the project dialog before selecting the project it added", async () => {
    const addedProject = project("added", "/added");
    let state: AppState = { ...initialAppState(), projectDialogOpen: true };
    const selectProject = vi.fn((selected: Project): Promise<void> => {
      expect(selected).toBe(addedProject);
      expect(state.projects).toEqual([addedProject]);
      expect(state.projectDialogOpen).toBe(false);
      return Promise.resolve();
    });
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject, forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects: vi.fn(),
          addProject: vi.fn().mockResolvedValue(addedProject),
          closeProject: vi.fn(),
          setWorkspaceTrust: vi.fn(),
        },
      },
    );

    await controller.addProject(" /added ");

    expect(selectProject).toHaveBeenCalledOnce();
  });

  it("pins a touched trust choice on the project's main workspace after adding it", async () => {
    const addedProject = project("added", "/added");
    const addedWorkspace = workspace(addedProject.id, addedProject.path);
    let state: AppState = { ...initialAppState(), projectDialogOpen: true };
    const setWorkspaceTrust = vi.fn().mockResolvedValue({ path: "/added", decision: true, trusted: true });
    const selectProject = vi.fn((): Promise<void> => {
      state = { ...state, workspaces: [addedWorkspace] };
      return Promise.resolve();
    });
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject, forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects: vi.fn(),
          addProject: vi.fn().mockResolvedValue(addedProject),
          closeProject: vi.fn(),
          setWorkspaceTrust,
        },
      },
    );

    await controller.addProject("/added", true, { trusted: true, changed: true });

    expect(setWorkspaceTrust).toHaveBeenCalledOnce();
    expect(setWorkspaceTrust).toHaveBeenCalledWith(addedProject.id, addedWorkspace.id, true, "local");
  });

  it("does not write trust when the dialog choice was not touched", async () => {
    const addedProject = project("added", "/added");
    let state: AppState = { ...initialAppState(), projectDialogOpen: true };
    const setWorkspaceTrust = vi.fn();
    const selectProject = vi.fn((): Promise<void> => {
      state = { ...state, workspaces: [workspace(addedProject.id, addedProject.path)] };
      return Promise.resolve();
    });
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject, forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects: vi.fn(),
          addProject: vi.fn().mockResolvedValue(addedProject),
          closeProject: vi.fn(),
          setWorkspaceTrust,
        },
      },
    );

    await controller.addProject("/added");
    await controller.addProject("/added", undefined, { trusted: true, changed: false });

    expect(setWorkspaceTrust).not.toHaveBeenCalled();
  });

  it("forgets a closed project's workspaces before clearing the selection it held", async () => {
    const closedProject = project("closed", "/closed");
    const remainingProject = project("remaining", "/remaining");
    let state: AppState = {
      ...initialAppState(),
      projects: [closedProject, remainingProject],
      selectedProject: closedProject,
      workspacesByProjectId: {
        [closedProject.id]: [workspace(closedProject.id, closedProject.path)],
        [remainingProject.id]: [workspace(remainingProject.id, remainingProject.path)],
      },
    };
    const events: string[] = [];
    const forgetProject = vi.fn((projectId: string) => {
      events.push("forget");
      state = {
        ...state,
        workspacesByProjectId: Object.fromEntries(Object.entries(state.workspacesByProjectId).filter(([id]) => id !== projectId)),
      };
    });
    const clearSelection = vi.fn(() => { events.push("clear"); });
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject, clearSelection },
      {
        api: {
          projects: vi.fn(),
          addProject: vi.fn(),
          closeProject: vi.fn().mockResolvedValue(undefined),
          setWorkspaceTrust: vi.fn(),
        },
      },
    );

    await controller.closeProject(closedProject.id);

    expect(events).toEqual(["forget", "clear"]);
    expect(state.projects).toEqual([remainingProject]);
    expect(state.workspacesByProjectId[closedProject.id]).toBeUndefined();
    expect(clearSelection).toHaveBeenCalledOnce();
  });
});
