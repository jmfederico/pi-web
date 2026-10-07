import type { SessionActivity, SessionStatus } from "./api";

/** Existing runtime presentation, independent of editor focus and action permissions. */
export function composerActivityText(status: SessionStatus | undefined, activity: SessionActivity | undefined, sending = false): string | undefined {
  if (sending) return "Sending your message…";
  const state = status === undefined ? activity?.label
    : status.isCompacting ? "compacting"
    : status.isBashRunning ? "bash"
    : status.isStreaming ? "running"
    : status.pendingMessageCount > 0 ? "queued" : "idle";
  if (state === undefined || (state === "idle" && activity?.phase !== "active")) return undefined;
  if (activity === undefined || (state !== "idle" && activity.phase === "idle")) return state;
  return activity.detail !== undefined && activity.detail !== "" ? `${activity.label}: ${activity.detail}` : activity.label;
}
