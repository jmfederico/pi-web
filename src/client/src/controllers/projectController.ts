import { api as defaultApi, type Project } from "../api";
import { selectedMachineId, type GetState, type SetState } from "./types";
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
  api?: Pick<typeof defaultApi, "projects" | "addProject" | "closeProject" | "setWorkspaceTrust">;
}

export class ProjectController {
  private readonly api: Pick<typeof defaultApi, "projects" | "addProject" | "closeProject" | "setWorkspaceTrust">;

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    private readonly workspaces: Pick<WorkspaceController, "selectProject" | "forgetProject" | "clearSelection">,
    deps: ProjectControllerDependencies = {},
  ) {
    this.api = deps.api ?? defaultApi;
  }

  async loadProjects() {
    const machineId = selectedMachineId(this.getState());
    this.setState({ error: "", isLoadingProjects: true });
    try {
      const projects = await this.api.projects(machineId);
      if (selectedMachineId(this.getState()) !== machineId) return;
      const projectIds = new Set(projects.map((project) => project.id));
      const workspacesByProjectId = Object.fromEntries(Object.entries(this.getState().workspacesByProjectId).filter(([projectId]) => projectIds.has(projectId)));
      this.setState({ projects, workspacesByProjectId });
    } catch (error) {
      if (selectedMachineId(this.getState()) === machineId) this.setState({ error: String(error) });
    } finally {
      if (selectedMachineId(this.getState()) === machineId) this.setState({ isLoadingProjects: false });
    }
  }

  async addProject(path: string, create?: boolean, trustChoice?: ProjectTrustChoice) {
    if (path.trim() === "") return;
    const machineId = selectedMachineId(this.getState());
    try {
      const project = await this.api.addProject(path.trim(), undefined, create, machineId);
      if (selectedMachineId(this.getState()) !== machineId) return;
      const projects = this.getState().projects;
      this.setState({ projects: [...projects.filter((p) => p.id !== project.id), project], projectDialogOpen: false });
      await this.workspaces.selectProject(project);
      if (trustChoice?.changed === true) {
        await this.applyTrustChoice(project, trustChoice.trusted, machineId);
      }
    } catch (error) {
      if (selectedMachineId(this.getState()) === machineId) this.setState({ error: String(error) });
    }
  }

  /**
   * Pin the dialog's trust choice once the project's main workspace exists.
   * The write goes through the id-based trust route (server-resolved path),
   * never a client-chosen path; without a main workspace the project simply
   * keeps its default trust.
   */
  private async applyTrustChoice(project: Project, trusted: boolean, machineId: string): Promise<void> {
    const mainWorkspace = this.getState().workspaces.find((workspace) => workspace.isMain);
    if (mainWorkspace === undefined) return;
    await this.api.setWorkspaceTrust(project.id, mainWorkspace.id, trusted, machineId);
  }

  async closeProject(projectId: string) {
    const machineId = selectedMachineId(this.getState());
    try {
      await this.api.closeProject(projectId, machineId);
      if (selectedMachineId(this.getState()) !== machineId) return;
      this.workspaces.forgetProject(projectId);
      const state = this.getState();
      this.setState({ projects: state.projects.filter((p) => p.id !== projectId) });
      if (state.selectedProject?.id === projectId) this.workspaces.clearSelection();
    } catch (error) {
      if (selectedMachineId(this.getState()) === machineId) this.setState({ error: String(error) });
    }
  }
}
