import { api } from "../api";
import { queryNamespace, setNamespacedQueryKey } from "../namespacedQueryArgs";
import { selectedMachineId, type GetState, type SetState, type UpdateUrl } from "./types";

const GIT_ROUTE_NAMESPACE = queryNamespace("core:workspace.git");

export class GitController {
  private pollTimer: number | undefined;

  constructor(private readonly getState: GetState, private readonly setState: SetState, private readonly updateUrl: UpdateUrl) {}

  dispose(): void {
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  async refreshGit(): Promise<void> {
    const project = this.getState().selectedProject;
    const workspace = this.getState().selectedWorkspace;
    if (project === undefined || workspace === undefined) return;
    try {
      const status = await api.gitStatus(project.id, workspace.id, selectedMachineId(this.getState()));
      this.setState({ gitStatus: status, gitStale: false, error: "" });
      const selectedDiffPath = this.getState().selectedDiffPath;
      if (selectedDiffPath !== undefined) {
        if (status.files.some((file) => file.path === selectedDiffPath)) await this.refreshDiff(selectedDiffPath);
        else {
          this.setState({ selectedDiffPath: undefined, selectedDiff: undefined, selectedStagedDiff: undefined });
          setNamespacedQueryKey(GIT_ROUTE_NAMESPACE, "diff", undefined, { replace: true });
        }
      }
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async selectDiff(path: string): Promise<void> {
    this.setState({ selectedDiffPath: path, selectedDiff: undefined, selectedStagedDiff: undefined, workspaceTool: "core:workspace.git", mainView: this.getState().mainView === "chat" ? "chat" : "core:workspace.git" });
    setNamespacedQueryKey(GIT_ROUTE_NAMESPACE, "diff", path);
    this.updateUrl({ replace: true });
    await this.refreshDiff(path);
  }

  async restoreDiff(path: string): Promise<void> {
    this.setState({ selectedDiffPath: path, selectedDiff: undefined, selectedStagedDiff: undefined });
    await this.refreshDiff(path);
  }

  async refreshDiff(path: string): Promise<void> {
    const project = this.getState().selectedProject;
    const workspace = this.getState().selectedWorkspace;
    if (project === undefined || workspace === undefined) return;
    try {
      const [selectedDiff, selectedStagedDiff] = await Promise.all([
        api.gitDiff(project.id, workspace.id, { path }, selectedMachineId(this.getState())),
        api.gitDiff(project.id, workspace.id, { path, staged: true }, selectedMachineId(this.getState())),
      ]);
      this.setState({ selectedDiff, selectedStagedDiff, error: "" });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  updatePolling(): void {
    this.dispose();
    const state = this.getState();
    if (state.workspaceTool === "core:workspace.git" || state.mainView === "core:workspace.git") {
      this.pollTimer = window.setInterval(() => { void this.refreshGit(); }, 8000);
    }
  }
}
