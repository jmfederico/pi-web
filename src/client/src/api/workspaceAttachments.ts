export const DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER = ".pi-web/attachments";

export interface WorkspaceAttachmentsFolderConfig {
  attachments?: {
    defaultFolder?: string;
  };
}

export function effectiveWorkspaceAttachmentsFolder(config: WorkspaceAttachmentsFolderConfig | undefined): string {
  return config?.attachments?.defaultFolder ?? DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER;
}

// The workspace parameter accepts undefined because composer call sites resolve
// the folder before a workspace selection exists.
export function workspaceEffectiveAttachmentsFolder(config: WorkspaceAttachmentsFolderConfig | undefined, fallbackFolder: string): string {
  return config?.attachments?.defaultFolder ?? fallbackFolder;
}
