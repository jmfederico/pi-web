import { workspaceDeleteOperation, workspaceDeleteOperationMetadataKey, targetWorkspaceIdMetadataKey } from "../../shared/workspaceDeletion";
import type { AppState } from "./appState";
import type { TerminalCommandRun, Workspace } from "./api";

export { targetWorkspaceIdMetadataKey, workspaceDeleteOperation, workspaceDeleteOperationMetadataKey, workspaceDeletionMetadata } from "../../shared/workspaceDeletion";

/** Removal availability and wording come from the current owner, never Git fields. */
export function canDeleteWorkspace(workspace: Workspace | undefined): boolean {
  return workspace?.removal !== undefined && !workspace.isMain;
}

export function workspaceRemovalConfirmation(workspace: Workspace): string | undefined {
  return workspace.removal?.confirmation;
}

export function workspaceDeletionRunFilter(projectId?: string): { projectId?: string; metadata: Record<string, string> } {
  return {
    ...(projectId === undefined ? {} : { projectId }),
    metadata: { [workspaceDeleteOperationMetadataKey]: workspaceDeleteOperation },
  };
}

export function latestWorkspaceDeletionRuns(runs: TerminalCommandRun[]): Record<string, TerminalCommandRun> {
  const latest: Record<string, TerminalCommandRun> = {};
  for (const run of runs) {
    const workspaceId = targetWorkspaceIdForRun(run);
    if (workspaceId === undefined) continue;
    const current = latest[workspaceId];
    if (current === undefined || run.createdAt.localeCompare(current.createdAt) >= 0) latest[workspaceId] = run;
  }
  return latest;
}

export function pendingWorkspaceDeletionIds(runsByWorkspaceId: Record<string, TerminalCommandRun>): string[] {
  return Object.entries(runsByWorkspaceId)
    .filter(([, run]) => isWorkspaceDeletionRunPending(run))
    .map(([workspaceId]) => workspaceId);
}

export function isWorkspaceDeletionPending(state: Pick<AppState, "workspaceDeletionRuns">, workspace: Workspace | undefined): boolean {
  if (workspace === undefined) return false;
  const run = state.workspaceDeletionRuns[workspace.id];
  return run !== undefined && isWorkspaceDeletionRunPending(run);
}

export function targetWorkspaceIdForRun(run: TerminalCommandRun): string | undefined {
  return run.metadata[targetWorkspaceIdMetadataKey];
}

export function isWorkspaceDeletionRunPending(run: TerminalCommandRun): boolean {
  return run.status === "queued" || run.status === "running";
}

