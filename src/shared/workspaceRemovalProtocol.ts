import type { WorkspaceRemovalRequest } from "./apiTypes.js";

/** Small JSON request carrying the host-issued confirmation precondition. */
export const WORKSPACE_REMOVAL_REQUEST_BODY_MAX_BYTES = 4 * 1024;
/** One sessiond-owned deadline across owner resolution, validation, and planning. */
export const WORKSPACE_REMOVAL_OPERATION_TIMEOUT_MS = 25_000;
/** Leaves time for cancellation to reach remote web/sessiond before gateway timeout. */
export const WORKSPACE_REMOVAL_FEDERATION_TIMEOUT_MS = 30_000;
export const WORKSPACE_REMOVAL_PRECONDITION_MAX_LENGTH = 256;

export function parseWorkspaceRemovalRequest(value: unknown): WorkspaceRemovalRequest {
  if (!isRecord(value)) throw new Error("Workspace removal request must be an object");
  return { precondition: requireWorkspaceRemovalPrecondition(value["precondition"]) };
}

export function requireWorkspaceRemovalPrecondition(value: unknown): string {
  if (
    typeof value !== "string"
    || value === ""
    || value.length > WORKSPACE_REMOVAL_PRECONDITION_MAX_LENGTH
  ) {
    throw new Error(
      `Workspace removal precondition must be a non-empty string of at most ${String(WORKSPACE_REMOVAL_PRECONDITION_MAX_LENGTH)} characters`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
