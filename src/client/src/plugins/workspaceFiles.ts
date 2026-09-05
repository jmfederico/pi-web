import { MAX_INLINE_PREVIEW_BYTES } from "../../../shared/workspaceFiles";
import {
  uploadWorkspaceFile as defaultUploadWorkspaceFile,
  workspaceUploadPath,
  WorkspaceUploadCancelledError,
  type DeleteWorkspaceFileResponse,
  type FileContentResponse,
  type FileTreeResponse,
  type MoveWorkspaceFileOptions,
  type MoveWorkspaceFileResponse,
  type WriteWorkspaceFileOptions,
  type WriteWorkspaceFileResponse,
  type Workspace,
} from "../api";
import { workspaceFilePreviewUrl as defaultWorkspaceFilePreviewUrl } from "../api/urls";
import type {
  WorkspaceFileRequestOptions,
  WorkspaceFilesCapabilityV1,
  WorkspaceInvalidation,
} from "./types";

/**
 * API surface the workspace files helper needs. Structurally satisfied by
 * `workspacesApi`; declared here so the helper stays testable with fakes.
 */
export interface WorkspaceFilesApi {
  workspaceFile(projectId: string, workspaceId: string, path: string, machineId?: string, options?: WorkspaceFileRequestOptions): Promise<FileContentResponse>;
  workspaceTree(projectId: string, workspaceId: string, path?: string, machineId?: string, options?: WorkspaceFileRequestOptions): Promise<FileTreeResponse>;
  writeWorkspaceFile(projectId: string, workspaceId: string, path: string, content: string | Uint8Array, options?: WriteWorkspaceFileOptions, machineId?: string): Promise<WriteWorkspaceFileResponse>;
  deleteWorkspaceFile(projectId: string, workspaceId: string, path: string, machineId?: string): Promise<DeleteWorkspaceFileResponse>;
  moveWorkspaceFile(projectId: string, workspaceId: string, fromPath: string, toPath: string, options?: MoveWorkspaceFileOptions, machineId?: string): Promise<MoveWorkspaceFileResponse>;
}

export interface CreateWorkspaceFilesOptions {
  readonly defaultUploadFolder: string;
  readonly maxInlinePreviewBytes?: number;
  readonly onInvalidate?: (invalidation: WorkspaceInvalidation) => void;
  readonly uploadWorkspaceFile?: typeof defaultUploadWorkspaceFile;
  readonly workspaceFilePreviewUrl?: typeof defaultWorkspaceFilePreviewUrl;
}

const workspaceFilesMutationInvalidation: WorkspaceInvalidation = Object.freeze({
  reason: "mutation",
  resources: Object.freeze(["workspace.files"] as const),
});

/**
 * Build the versioned `files` capability exposed to workspace callbacks.
 * Authority is captured here: callers cannot choose a project, workspace, or
 * machine. Host adapters retain URL resolution, federation, and transport.
 */
export function createWorkspaceFiles(
  api: WorkspaceFilesApi,
  workspace: Pick<Workspace, "id" | "projectId">,
  machineId: string,
  options: CreateWorkspaceFilesOptions,
): WorkspaceFilesCapabilityV1 {
  const previewUrl = options.workspaceFilePreviewUrl ?? defaultWorkspaceFilePreviewUrl;
  const uploadFile = options.uploadWorkspaceFile ?? defaultUploadWorkspaceFile;
  const publishMutation = () => { options.onInvalidate?.(workspaceFilesMutationInvalidation); };

  return {
    capabilityVersion: 1,
    defaultUploadFolder: options.defaultUploadFolder,
    maxInlinePreviewBytes: options.maxInlinePreviewBytes ?? MAX_INLINE_PREVIEW_BYTES,
    readFile: (path, requestOptions) => api.workspaceFile(workspace.projectId, workspace.id, path, machineId, requestOptions),
    listFiles: (path, requestOptions) => api.workspaceTree(workspace.projectId, workspace.id, path, machineId, requestOptions),
    writeFile: async (path, content, writeOptions) => {
      const result = await api.writeWorkspaceFile(workspace.projectId, workspace.id, path, content, writeOptions, machineId);
      publishMutation();
      return result;
    },
    deleteFile: async (path) => {
      const result = await api.deleteWorkspaceFile(workspace.projectId, workspace.id, path, machineId);
      publishMutation();
      return result;
    },
    moveFile: async (fromPath, toPath, moveOptions) => {
      const result = await api.moveWorkspaceFile(workspace.projectId, workspace.id, fromPath, toPath, moveOptions, machineId);
      publishMutation();
      return result;
    },
    previewUrl: (path, referenceOptions) => previewUrl(workspace.projectId, workspace.id, path, {
      machineId,
      ...(referenceOptions?.version === undefined ? {} : { modifiedAt: referenceOptions.version }),
    }),
    downloadUrl: (path, referenceOptions) => previewUrl(workspace.projectId, workspace.id, path, {
      machineId,
      download: true,
      ...(referenceOptions?.version === undefined ? {} : { modifiedAt: referenceOptions.version }),
    }),
    uploadFile: (file, uploadOptions) => {
      const path = workspaceUploadPath(uploadOptions?.destinationFolder ?? options.defaultUploadFolder, file.name);
      const task = uploadFile(workspace.projectId, workspace.id, { path, file }, {
        machineId,
        createDirs: uploadOptions?.createDirs ?? true,
        overwrite: uploadOptions?.overwrite ?? false,
        ...(uploadOptions?.onProgress === undefined ? {} : { onProgress: uploadOptions.onProgress }),
      });
      const completed = task.promise.then(
        (result) => {
          publishMutation();
          return result;
        },
        (error: unknown) => { throw publicUploadError(error); },
      );
      return { path, completed, cancel: () => { task.cancel(); } };
    },
  };
}

function publicUploadError(error: unknown): unknown {
  if (!(error instanceof WorkspaceUploadCancelledError)) return error;
  if (typeof DOMException !== "undefined") return new DOMException(error.message, "AbortError");
  const abortError = new Error(error.message);
  abortError.name = "AbortError";
  return abortError;
}
