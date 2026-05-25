import { api } from "../api";
import { queryNamespace, setNamespacedQueryKey } from "../namespacedQueryArgs";
import { selectedMachineId, type GetState, type SetState, type UpdateUrl } from "./types";

const FILES_ROUTE_NAMESPACE = queryNamespace("core:workspace.files");

export class FileExplorerController {
  constructor(private readonly getState: GetState, private readonly setState: SetState, private readonly updateUrl: UpdateUrl) {}

  async refreshFiles(): Promise<void> {
    const project = this.getState().selectedProject;
    const workspace = this.getState().selectedWorkspace;
    if (project === undefined || workspace === undefined) return;
    try {
      const machineId = selectedMachineId(this.getState());
      const root = await api.workspaceTree(project.id, workspace.id, "", machineId);
      const expanded = { ...this.getState().expandedDirs };
      await Promise.all(Object.keys(expanded).map(async (path) => { expanded[path] = (await api.workspaceTree(project.id, workspace.id, path, machineId)).entries; }));
      this.setState({ fileTree: root.entries, expandedDirs: expanded, fileTreeStale: false, error: "" });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async expandDir(path: string): Promise<void> {
    const project = this.getState().selectedProject;
    const workspace = this.getState().selectedWorkspace;
    if (project === undefined || workspace === undefined) return;
    if (this.getState().expandedDirs[path] !== undefined) {
      this.setState({ expandedDirs: omitKey(this.getState().expandedDirs, path) });
      return;
    }
    try {
      const response = await api.workspaceTree(project.id, workspace.id, path, selectedMachineId(this.getState()));
      this.setState({ expandedDirs: { ...this.getState().expandedDirs, [path]: response.entries }, error: "" });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async selectFile(path: string): Promise<void> {
    this.setState({ selectedFilePath: path, selectedFileContent: undefined, workspaceTool: "core:workspace.files", mainView: this.getState().mainView === "chat" ? "chat" : "core:workspace.files" });
    setNamespacedQueryKey(FILES_ROUTE_NAMESPACE, "file", path);
    this.updateUrl({ replace: true });
    await this.restoreFile(path);
  }

  async restoreFile(path: string): Promise<void> {
    const project = this.getState().selectedProject;
    const workspace = this.getState().selectedWorkspace;
    if (project === undefined || workspace === undefined) return;
    this.setState({ selectedFilePath: path, selectedFileContent: undefined });
    try {
      const content = await api.workspaceFile(project.id, workspace.id, path, selectedMachineId(this.getState()));
      if (this.getState().selectedFilePath === path) this.setState({ selectedFileContent: content, error: "" });
    } catch (error) {
      if (this.getState().selectedFilePath !== path) return;
      if (isUnavailableFileError(error)) {
        this.setState({ selectedFilePath: undefined, selectedFileContent: undefined, error: "" });
        setNamespacedQueryKey(FILES_ROUTE_NAMESPACE, "file", undefined, { replace: true });
        this.updateUrl({ replace: true });
        return;
      }
      this.setState({ error: String(error) });
    }
  }
}

function isUnavailableFileError(error: unknown): boolean {
  const message = String(error);
  return message.includes("Path does not exist") || message.includes("ENOENT") || message.includes("no such file or directory");
}

function omitKey<T>(record: Record<string, T>, keyToOmit: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== keyToOmit));
}
