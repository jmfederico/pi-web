import type { WorkspaceCreationRequest } from "./apiTypes.js";

/** Small JSON request carrying the chosen parent directory and workspace name. */
export const WORKSPACE_CREATION_REQUEST_BODY_MAX_BYTES = 8 * 1024;
/** One sessiond-owned deadline across owner resolution and planning. */
export const WORKSPACE_CREATION_OPERATION_TIMEOUT_MS = 25_000;
export const WORKSPACE_CREATION_NAME_MAX_LENGTH = 128;
export const WORKSPACE_CREATION_PARENT_PATH_MAX_LENGTH = 4_096;

export const workspaceCreateOperation = "workspace.create";
const workspaceCreateOperationMetadataKey = "pi.operation";
const createdWorkspaceNameMetadataKey = "created.workspaceName";

export function workspaceCreationMetadata(name: string): Record<string, string> {
  return {
    [workspaceCreateOperationMetadataKey]: workspaceCreateOperation,
    [createdWorkspaceNameMetadataKey]: name,
  };
}

export function parseWorkspaceCreationRequest(value: unknown): WorkspaceCreationRequest {
  if (!isRecord(value)) throw new Error("Workspace creation request must be an object");
  return {
    parentPath: requireWorkspaceCreationParentPath(value["parentPath"]),
    name: requireWorkspaceCreationName(value["name"]),
  };
}

/**
 * Host-generic name validation. Providers decide what the name means, but a name
 * that can traverse directories or split a path is rejected before any provider
 * sees it.
 */
export function requireWorkspaceCreationName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Workspace name must be a string");
  const name = value.trim();
  if (name === "" || name.length > WORKSPACE_CREATION_NAME_MAX_LENGTH) {
    throw new Error(
      `Workspace name must be a non-empty string of at most ${String(WORKSPACE_CREATION_NAME_MAX_LENGTH)} characters`,
    );
  }
  if (name === "." || name === "..") throw new Error("Workspace name must not be a relative path segment");
  if (/[/\\\0]/u.test(name)) throw new Error("Workspace name must not contain path separators");
  return name;
}

export function requireWorkspaceCreationParentPath(value: unknown): string {
  if (typeof value !== "string") throw new Error("Workspace parent path must be a string");
  const parentPath = value.trim();
  if (parentPath === "" || parentPath.length > WORKSPACE_CREATION_PARENT_PATH_MAX_LENGTH) {
    throw new Error(
      `Workspace parent path must be a non-empty string of at most ${String(WORKSPACE_CREATION_PARENT_PATH_MAX_LENGTH)} characters`,
    );
  }
  if (!parentPath.startsWith("/")) throw new Error("Workspace parent path must be absolute");
  if (parentPath.includes("\0")) throw new Error("Workspace parent path must not contain NUL");
  return parentPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
