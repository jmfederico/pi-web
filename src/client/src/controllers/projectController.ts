import { api as defaultApi, type Project } from "../api";
import { BrowserErrorReporter, machineBrowserErrorScope, projectBrowserErrorScope } from "../browserErrors";
import { selectedMachineId, type GetState, type NavigationDestinationOptions, type NavigationSelection, type SetState } from "./types";
import type { WorkspaceController } from "./workspaceController";

/**
 * Trust choice the add-project dialog submits with the path. `changed` is
 * false for the pre-filled existing/default value, so adding a project never
 * pins a decision the user did not make in this dialog.
 */
export interface ProjectTrustChoice {
  trusted: boolean;
  changed: boolean;
}

export interface ProjectControllerDependencies {
  api?: Pick<typeof defaultApi, "projects" | "addProject" | "closeProject" | "workspaces" | "setWorkspaceTrust">;
  navigateToProject?: (project: Project | undefined, options?: NavigationDestinationOptions) => Promise<boolean>;
  captureNavigation?: () => NavigationSelection;
}

export class ProjectController {
  private readonly api: NonNullable<ProjectControllerDependencies["api"]>;
  private readonly navigateToProject: ProjectControllerDependencies["navigateToProject"];
  private readonly captureNavigation: ProjectControllerDependencies["captureNavigation"];
  private readonly browserErrors: BrowserErrorReporter;

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    private readonly workspaces: Pick<WorkspaceController, "selectProject" | "forgetProject" | "clearSelection">,
    deps: ProjectControllerDependencies = {},
  ) {
    this.api = deps.api ?? defaultApi;
    this.navigateToProject = deps.navigateToProject;
    this.captureNavigation = deps.captureNavigation;
    this.browserErrors = new BrowserErrorReporter(getState, setState);
  }

  async loadProjects() {
    const machineId = selectedMachineId(this.getState());
    this.setState({ isLoadingProjects: true });
    try {
      const projects = await this.api.projects(machineId);
      if (selectedMachineId(this.getState()) !== machineId) return;
      const projectIds = new Set(projects.map((project) => project.id));
      const workspacesByProjectId = Object.fromEntries(Object.entries(this.getState().workspacesByProjectId).filter(([projectId]) => projectIds.has(projectId)));
      this.setState({ projects, workspacesByProjectId });
    } catch (error) {
      this.browserErrors.report(machineBrowserErrorScope(machineId), String(error));
    } finally {
      if (selectedMachineId(this.getState()) === machineId) this.setState({ isLoadingProjects: false });
    }
  }

  async addProject(path: string, create?: boolean, trustChoice?: ProjectTrustChoice) {
    if (path.trim() === "") return;
    const machineId = selectedMachineId(this.getState());
    const expected = navigationSelection(this.getState(), this.captureNavigation);
    let project: Project;
    try {
      project = await this.api.addProject(path.trim(), undefined, create, machineId);
    } catch (error) {
      this.browserErrors.report(machineBrowserErrorScope(machineId), String(error));
      return;
    }
    try {
      if (selectedMachineId(this.getState()) === machineId) {
        const projects = this.getState().projects;
        this.setState({ projects: [...projects.filter((p) => p.id !== project.id), project], projectDialogOpen: false });
      }
      // The explicit decision belongs to creation, not to the navigation that
      // may have been superseded. Persist it before selecting the project.
      if (trustChoice?.changed === true) {
        await this.applyTrustChoice(project, trustChoice.trusted, machineId);
      }
      if (selectedMachineId(this.getState()) !== machineId) return;
      if (this.navigateToProject !== undefined) await this.navigateToProject(project, { expected });
      else await this.workspaces.selectProject(project);
    } catch (error) {
      this.browserErrors.report(projectBrowserErrorScope(machineId, project.id), String(error));
    }
  }

  /**
   * Pin the dialog's trust choice once the project's main workspace exists.
   * The write goes through the id-based trust route (server-resolved path),
   * never a client-chosen path or the currently selected workspace.
   */
  private async applyTrustChoice(project: Project, trusted: boolean, machineId: string): Promise<void> {
    const workspaces = await this.api.workspaces(project.id, machineId);
    const mainWorkspace = workspaces.find((workspace) => workspace.projectId === project.id && workspace.isMain);
    if (mainWorkspace === undefined) throw new Error(`Cannot save trust choice for project ${project.id}: main workspace unavailable`);
    await this.api.setWorkspaceTrust(project.id, mainWorkspace.id, trusted, machineId);
  }

  async closeProject(projectId: string) {
    const machineId = selectedMachineId(this.getState());
    try {
      await this.api.closeProject(projectId, machineId);
      if (selectedMachineId(this.getState()) !== machineId) return;
      this.workspaces.forgetProject(projectId);
      const state = this.getState();
      const wasSelected = state.selectedProject?.id === projectId;
      this.setState({ projects: state.projects.filter((p) => p.id !== projectId) });
      if (!wasSelected) return;
      const expected = navigationSelection(this.getState(), this.captureNavigation);
      if (this.navigateToProject !== undefined) await this.navigateToProject(undefined, { expected });
      else this.workspaces.clearSelection();
    } catch (error) {
      this.browserErrors.report(projectBrowserErrorScope(machineId, projectId), String(error));
    }
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
