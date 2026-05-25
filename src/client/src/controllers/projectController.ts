import { api } from "../api";
import { selectedMachineId, type GetState, type SetState } from "./types";
import type { WorkspaceController } from "./workspaceController";

export class ProjectController {
  constructor(private readonly getState: GetState, private readonly setState: SetState, private readonly workspaces: WorkspaceController) {}

  async loadProjects() {
    this.setState({ error: "", isLoadingProjects: true });
    try {
      const projects = await api.projects(selectedMachineId(this.getState()));
      const projectIds = new Set(projects.map((project) => project.id));
      const workspacesByProjectId = Object.fromEntries(Object.entries(this.getState().workspacesByProjectId).filter(([projectId]) => projectIds.has(projectId)));
      this.setState({ projects, workspacesByProjectId });
    } catch (error) {
      this.setState({ error: String(error) });
    } finally {
      this.setState({ isLoadingProjects: false });
    }
  }

  async addProject(path: string, create?: boolean) {
    if (path.trim() === "") return;
    try {
      const project = await api.addProject(path.trim(), undefined, create, selectedMachineId(this.getState()));
      const projects = this.getState().projects;
      this.setState({ projects: [...projects.filter((p) => p.id !== project.id), project], projectDialogOpen: false });
      await this.workspaces.selectProject(project);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async closeProject(projectId: string) {
    try {
      await api.closeProject(projectId, selectedMachineId(this.getState()));
      this.workspaces.forgetProject(projectId);
      const state = this.getState();
      this.setState({ projects: state.projects.filter((p) => p.id !== projectId) });
      if (state.selectedProject?.id === projectId) this.workspaces.clearSelection();
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }
}
