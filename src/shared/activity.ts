import type { SessionActivity, SessionStatus, WorkspaceActivity } from "./apiTypes.js";

export function isSessionActive(status?: SessionStatus, activity?: SessionActivity): boolean {
  return activity?.phase === "active"
    || status?.isStreaming === true
    || status?.isBashRunning === true
    || status?.isCompacting === true
    || (status?.pendingMessageCount ?? 0) > 0;
}

export function isWorkspaceActivityActive(activity: WorkspaceActivity | undefined): boolean {
  return activity !== undefined && (activity.hasSessionActivity || activity.hasTerminalActivity);
}
