import type { QueuedSessionMessage } from "./api";

// The wire action remains "edit" for compatibility; the UI calls it Recall.
export type QueuedMessageAction = "edit" | "remove" | "toggle";

export interface QueuedMessageActionTarget {
  machineId: string;
  sessionId: string;
  action: QueuedMessageAction;
  index: number;
  expectedQueue: QueuedSessionMessage[];
}

export function queuedMessageAttachmentLabel(message: QueuedSessionMessage): string | undefined {
  const count = message.attachmentCount ?? 0;
  if (count > 0) return `${String(count)} ${count === 1 ? "attachment" : "attachments"}`;
  return message.hasAttachments === true ? "Attachments" : undefined;
}

/** Queues are displayed in delivery order: steering first, then follow-ups. */
export function queuedMessageRecallConfirmation(messages: readonly QueuedSessionMessage[], index: number): string | undefined {
  const message = messages[index];
  const hasAttachments = message?.hasAttachments === true || (message?.attachmentCount ?? 0) > 0;
  const warning = hasAttachments
    ? "Recall this message? Only its text will return to the composer. Its attachments will be lost."
    : "Recall this message?";
  const later = messages.slice(index + 1);
  if (later.length === 0) return hasAttachments ? warning : undefined;
  const steers = later.filter((message) => message.kind === "steer").length;
  const followUps = later.length - steers;
  const parts = [
    steers === 0 ? undefined : `${String(steers)} later ${steers === 1 ? "steer" : "steers"}`,
    followUps === 0 ? undefined : `${String(followUps)} queued ${followUps === 1 ? "follow-up" : "follow-ups"}`,
  ].filter((part) => part !== undefined);
  return `${warning}\n\nThis will also remove ${parts.join(" and ")}.`;
}
