import { api } from "../api";
import type { GetState, SetState } from "./types";
import type { WorkspaceController } from "./workspaceController";

export class ProjectController {
  constructor(private readonly getState: GetState, private readonly setState: SetState, private readonly workspaces: WorkspaceController) {}

  async loadProjects() {
    this.setState({ error: "" });
    try {
      this.setState({ projects: await api.projects() });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async addProject(path: string, create?: boolean) {
    if (path.trim() === "") return;
    try {
      const project = await api.addProject(path.trim(), undefined, create);
      const projects = this.getState().projects;
      this.setState({ projects: [...projects.filter((p) => p.id !== project.id), project], projectDialogOpen: false });
      await this.workspaces.selectProject(project);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async closeProject(projectId: string) {
    try {
      await api.closeProject(projectId);
      const state = this.getState();
      this.setState({ projects: state.projects.filter((p) => p.id !== projectId) });
      if (state.selectedProject?.id === projectId) this.workspaces.clearSelection();
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }
}
