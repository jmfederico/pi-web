import { message } from "./localization/service";

export default {
  navigationOrderFailed: message<{ detail: string }>("Failed to load or save navigation order: {detail}", "Navigation ordering failure; diagnostic stays unchanged"),
  workspaceRemovalUnavailable: message("Workspace removal is not available", "Requested workspace has no supported removal action"),
  workspaceRemovalFailed: message<{ detail: string }>("Failed to start workspace removal: {detail}", "Workspace removal could not start; diagnostic stays unchanged"),
  workspaceRemovalRefreshFailed: message<{ detail: string }>("Workspace removal succeeded, but refreshing the workspace list failed: {detail}. Retrying…", "Removal completed but the list refresh will be retried; diagnostic stays unchanged"),
  removeMachine: message<{ name: string }>("Remove {name}?\n\nThis only removes it from this PI WEB gateway.", "Confirmation for forgetting a remote machine, not deleting its data; machine name stays unchanged"),
  actionFailed: message<{ detail: string }>("Action failed: {detail}", "Unexpected action failure; raw diagnostics stay unchanged and browser-owned nested guidance retains live localization"),
  activityLabel: message("Recent activity in another instance", "Accessible name of the cross-instance session activity alert"),
  activityNotice: message("Recently active in another PI-WEB instance. Avoid working on this session in both instances at once.", "Session activity warning above the composer"),
  dismissActivity: message("Dismiss and continue", "Acknowledge cross-instance activity and resume composing"),
  loadingConversation: message("Loading conversation…", "Selected conversation is being loaded before the transcript mounts"),
};
