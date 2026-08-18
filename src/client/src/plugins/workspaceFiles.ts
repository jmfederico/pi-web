import type { DeleteWorkspaceFileResponse, FileContentResponse, FileTreeResponse, MoveWorkspaceFileOptions, MoveWorkspaceFileResponse, WriteWorkspaceFileOptions, WriteWorkspaceFileResponse, Workspace } from "../api";
import type { WorkspaceFiles } from "./types";

/**
 * API surface the workspace files helper needs. Structurally satisfied by
 * `workspacesApi`; declared here so the helper stays testable with fakes.
 */
export interface WorkspaceFilesApi {
  workspaceFile(projectId: string, workspaceId: string, path: string, machineId?: string): Promise<FileContentResponse>;
  workspaceTree(projectId: string, workspaceId: string, path?: string, machineId?: string): Promise<FileTreeResponse>;
  writeWorkspaceFile(projectId: string, workspaceId: string, path: string, content: string | Uint8Array, options?: WriteWorkspaceFileOptions, machineId?: string): Promise<WriteWorkspaceFileResponse>;
  deleteWorkspaceFile(projectId: string, workspaceId: string, path: string, machineId?: string): Promise<DeleteWorkspaceFileResponse>;
  moveWorkspaceFile(projectId: string, workspaceId: string, fromPath: string, toPath: string, options?: MoveWorkspaceFileOptions, machineId?: string): Promise<MoveWorkspaceFileResponse>;
}

/**
 * Build the `files` helper exposed to workspace panel and label callbacks.
 * Every call is bound to the callback's workspace and machine, so local and
 * federated machines behave the same. `onFilesChanged` runs after a mutation
 * succeeds so the host can refresh its file explorer.
 */
export function createWorkspaceFiles(api: WorkspaceFilesApi, workspace: Pick<Workspace, "id" | "projectId">, machineId: string, onFilesChanged?: () => void): WorkspaceFiles {
  return {
    readFile: (path) => api.workspaceFile(workspace.projectId, workspace.id, path, machineId),
    listFiles: (path) => api.workspaceTree(workspace.projectId, workspace.id, path, machineId),
    writeFile: async (path, content, options) => {
      const result = await api.writeWorkspaceFile(workspace.projectId, workspace.id, path, content, options, machineId);
      onFilesChanged?.();
      return result;
    },
    deleteFile: async (path) => {
      const result = await api.deleteWorkspaceFile(workspace.projectId, workspace.id, path, machineId);
      onFilesChanged?.();
      return result;
    },
    moveFile: async (fromPath, toPath, options) => {
      const result = await api.moveWorkspaceFile(workspace.projectId, workspace.id, fromPath, toPath, options, machineId);
      onFilesChanged?.();
      return result;
    },
  };
}
