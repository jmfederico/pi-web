import type { Workspace } from "../api";
import { browserLocalStorage, parseStoredString, PersistentValueMap, type KeyValueStorage } from "./sessionStorageMemory";

export interface WorkspaceSelectionMemory {
  latestWorkspaceId(projectId: string): string | undefined;
  rememberWorkspace(workspace: Workspace): void;
  forgetProject(projectId: string): void;
}

export class InMemoryWorkspaceSelectionMemory implements WorkspaceSelectionMemory {
  private readonly workspaceIdsByProject = new Map<string, string>();

  latestWorkspaceId(projectId: string): string | undefined {
    return this.workspaceIdsByProject.get(projectId);
  }

  rememberWorkspace(workspace: Workspace): void {
    this.workspaceIdsByProject.set(workspace.projectId, workspace.id);
  }

  forgetProject(projectId: string): void {
    this.workspaceIdsByProject.delete(projectId);
  }
}

const workspaceSelectionStorageKey = "pi-web:workspace-selection:v1";

export class SessionStorageWorkspaceSelectionMemory implements WorkspaceSelectionMemory {
  private readonly workspaceIdsByProject: PersistentValueMap<string>;

  constructor(storage: KeyValueStorage | undefined = browserLocalStorage()) {
    this.workspaceIdsByProject = new PersistentValueMap(workspaceSelectionStorageKey, parseStoredString, storage);
  }

  latestWorkspaceId(projectId: string): string | undefined {
    return this.workspaceIdsByProject.get(projectId);
  }

  rememberWorkspace(workspace: Workspace): void {
    this.workspaceIdsByProject.set(workspace.projectId, workspace.id);
  }

  forgetProject(projectId: string): void {
    this.workspaceIdsByProject.delete(projectId);
  }
}

export function selectPreferredWorkspace(workspaces: Workspace[], options?: { targetWorkspaceId?: string | undefined; latestWorkspaceId?: string | undefined }): Workspace | undefined {
  const targetWorkspaceId = options?.targetWorkspaceId;
  if (targetWorkspaceId !== undefined && targetWorkspaceId !== "") return workspaces.find((workspace) => workspace.id === targetWorkspaceId);

  const latestWorkspaceId = options?.latestWorkspaceId;
  if (latestWorkspaceId !== undefined && latestWorkspaceId !== "") return workspaces.find((workspace) => workspace.id === latestWorkspaceId) ?? workspaces[0];

  return workspaces[0];
}
