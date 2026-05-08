import { api, type Project, type Workspace } from "../api";
import type { GetState, RouteTarget, SetState, UpdateUrl } from "./types";
import type { SessionController } from "./sessionController";

export class WorkspaceController {
  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    private readonly updateUrl: UpdateUrl,
    private readonly sessions: SessionController,
  ) {}

  clearSelection(options?: { updateUrl?: boolean | undefined }) {
    this.sessions.clearActiveSession();
    this.setState({ selectedProject: undefined, selectedWorkspace: undefined, sessions: [], workspaces: [], fileTree: [], expandedDirs: {}, selectedFilePath: undefined, selectedFileContent: undefined, fileTreeStale: false, gitStatus: undefined, selectedDiffPath: undefined, selectedDiff: undefined, selectedStagedDiff: undefined, gitStale: false, error: "" });
    if (options?.updateUrl !== false) this.updateUrl();
  }

  async selectProject(project: Project, target?: RouteTarget) {
    this.sessions.clearActiveSession();
    this.setState({ selectedProject: project, selectedWorkspace: undefined, sessions: [], workspaces: [], fileTree: [], expandedDirs: {}, selectedFilePath: undefined, selectedFileContent: undefined, fileTreeStale: false, gitStatus: undefined, selectedDiffPath: undefined, selectedDiff: undefined, selectedStagedDiff: undefined, gitStale: false, error: "" });
    try {
      const workspaces = await api.workspaces(project.id);
      this.setState({ workspaces });
      const workspace = target?.workspaceId !== undefined && target.workspaceId !== "" ? workspaces.find((w) => w.id === target.workspaceId) : workspaces[0];
      if (workspace) await this.selectWorkspace(workspace, { sessionId: target?.sessionId, updateUrl: target?.updateUrl });
      else if (target?.updateUrl !== false) this.updateUrl();
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async selectWorkspace(workspace: Workspace, target?: { sessionId?: string | undefined; updateUrl?: boolean | undefined }) {
    this.sessions.clearActiveSession();
    this.setState({ selectedWorkspace: workspace, sessions: [], fileTree: [], expandedDirs: {}, selectedFilePath: undefined, selectedFileContent: undefined, fileTreeStale: false, gitStatus: undefined, selectedDiffPath: undefined, selectedDiff: undefined, selectedStagedDiff: undefined, gitStale: false, error: "" });
    try {
      const sessions = await api.sessions(workspace.path);
      this.setState({ sessions });
      const sessionId = target?.sessionId;
      const session = sessionId !== undefined && sessionId !== "" ? sessions.find((s) => s.id === sessionId || s.id.startsWith(sessionId)) : sessions.find((s) => s.archived !== true);
      if (session) await this.sessions.selectSession(session, { updateUrl: target?.updateUrl });
      else if (target?.updateUrl !== false) this.updateUrl();
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }
}
