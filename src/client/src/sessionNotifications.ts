import {
  SESSION_NOTIFICATION_LIMIT,
  SESSION_NOTIFICATION_MESSAGE_BYTES,
  type SessionNotification,
  type SessionNotificationDismissThrough,
  type SessionNotificationInboxEvent,
  type SessionNotificationInboxSnapshot,
  type SessionNotificationSeverity,
  type SessionNotificationSummary,
} from "../../shared/apiTypes";

export type SessionNotificationProjectionStatus = "loading" | "fresh" | "stale";

export interface SessionNotificationTarget {
  machineId: string;
  sessionId: string;
  cwd: string;
}

export interface SessionNotificationAnnouncement {
  id: string;
  severity: SessionNotificationSeverity;
  message: string;
}

export interface SelectedSessionNotificationInbox extends SessionNotificationTarget {
  status: SessionNotificationProjectionStatus;
  daemonInstanceId?: string;
  catalogRevision: number;
  summary?: SessionNotificationSummary;
  notifications: SessionNotification[];
  dismissThrough: SessionNotificationDismissThrough;
  optimisticDismissedIds: string[];
  optimisticDismissAllThrough?: SessionNotificationDismissThrough;
  announcements: SessionNotificationAnnouncement[];
}

export interface SelectedSessionNotificationView extends SessionNotificationTarget {
  daemonInstanceId: string;
  notifications: SessionNotification[];
  retainedCount: number;
  discardedCount: number;
  highestSeverity?: SessionNotificationSeverity;
  dismissThrough: SessionNotificationDismissThrough;
  pendingDismissedIds: ReadonlySet<string>;
  dismissAllPending: boolean;
  announcements: SessionNotificationAnnouncement[];
}

export interface NotificationReducerResult<T> {
  value: T;
  needsRefresh: boolean;
  changed: boolean;
}

const emptyDismissThrough: SessionNotificationDismissThrough = { order: 0, overflowWatermark: 0 };

export function loadingSelectedNotificationInbox(target: SessionNotificationTarget): SelectedSessionNotificationInbox {
  return {
    ...target,
    status: "loading",
    catalogRevision: 0,
    notifications: [],
    dismissThrough: emptyDismissThrough,
    optimisticDismissedIds: [],
    announcements: [],
  };
}

export function installSelectedNotificationSnapshot(
  current: SelectedSessionNotificationInbox | undefined,
  target: SessionNotificationTarget,
  snapshot: SessionNotificationInboxSnapshot,
): SelectedSessionNotificationInbox {
  if (snapshot.summary.sessionId !== target.sessionId || snapshot.summary.cwd !== target.cwd) throw new Error("Notification inbox snapshot does not match the selected session");
  const sameDaemon = current !== undefined
    && notificationTargetsEqual(current, target)
    && current.daemonInstanceId === snapshot.daemonInstanceId;
  return {
    ...target,
    status: "fresh",
    daemonInstanceId: snapshot.daemonInstanceId,
    catalogRevision: snapshot.catalogRevision,
    summary: snapshot.summary,
    notifications: snapshot.notifications,
    dismissThrough: snapshot.dismissThrough,
    optimisticDismissedIds: sameDaemon ? current.optimisticDismissedIds : [],
    ...(sameDaemon && current.optimisticDismissAllThrough !== undefined ? { optimisticDismissAllThrough: current.optimisticDismissAllThrough } : {}),
    announcements: sameDaemon ? current.announcements : [],
  };
}

export function applySelectedNotificationEvent(
  current: SelectedSessionNotificationInbox | undefined,
  target: SessionNotificationTarget,
  event: SessionNotificationInboxEvent,
): NotificationReducerResult<SelectedSessionNotificationInbox> {
  if (event.summary.sessionId !== target.sessionId || event.summary.cwd !== target.cwd) {
    return { value: current ?? loadingSelectedNotificationInbox(target), needsRefresh: false, changed: false };
  }
  if (current === undefined || !notificationTargetsEqual(current, target)) {
    return { value: staleSelectedNotificationInbox(target), needsRefresh: true, changed: true };
  }
  if (current.daemonInstanceId !== event.daemonInstanceId) {
    return {
      value: staleSelectedNotificationInbox(target),
      needsRefresh: true,
      changed: current.status !== "stale" || current.daemonInstanceId !== undefined || current.notifications.length > 0,
    };
  }
  const currentRevision = current.summary?.inboxRevision ?? 0;
  if (event.summary.inboxRevision <= currentRevision) return { value: current, needsRefresh: false, changed: false };
  if (current.status !== "fresh" || event.summary.inboxRevision !== currentRevision + 1 || event.delta.kind === "resync") {
    const stale = { ...current, status: "stale" as const };
    return { value: stale, needsRefresh: true, changed: current.status !== "stale" };
  }

  let notifications: SessionNotification[];
  let announcement: SessionNotificationAnnouncement | undefined;
  switch (event.delta.kind) {
    case "added": {
      const delta = event.delta;
      if (current.notifications.some((notification) => notification.id === delta.notification.id)) {
        return { value: { ...current, status: "stale" }, needsRefresh: true, changed: true };
      }
      notifications = [delta.notification, ...current.notifications]
        .filter((notification) => notification.id !== delta.evictedNotificationId)
        .sort((left, right) => right.order - left.order)
        .slice(0, SESSION_NOTIFICATION_LIMIT);
      announcement = {
        id: `${event.daemonInstanceId}:${String(event.summary.inboxRevision)}:${delta.notification.id}`,
        severity: delta.notification.severity,
        message: delta.notification.message,
      };
      break;
    }
    case "dismissed": {
      const dismissed = new Set(event.delta.notificationIds);
      notifications = current.notifications.filter((notification) => !dismissed.has(notification.id));
      break;
    }
    case "cleared":
      notifications = [];
      break;
  }

  const newestOrder = notifications[0]?.order ?? 0;
  if (!notificationListMatchesSummary(notifications, event.summary)
    || event.dismissThrough.order !== newestOrder
    || event.dismissThrough.overflowWatermark < event.summary.discardedCount) {
    return { value: { ...current, status: "stale" }, needsRefresh: true, changed: true };
  }
  const announcements = announcement === undefined
    ? current.announcements
    : [...current.announcements, announcement].slice(-SESSION_NOTIFICATION_LIMIT);
  return {
    value: {
      ...current,
      status: "fresh",
      daemonInstanceId: event.daemonInstanceId,
      catalogRevision: event.catalogRevision,
      summary: event.summary,
      notifications,
      dismissThrough: event.dismissThrough,
      announcements,
    },
    needsRefresh: false,
    changed: true,
  };
}

export function selectedNotificationView(inbox: SelectedSessionNotificationInbox | undefined): SelectedSessionNotificationView | undefined {
  if (inbox?.status !== "fresh" || inbox.daemonInstanceId === undefined || inbox.summary === undefined) return undefined;
  const pendingDismissedIds = new Set(inbox.optimisticDismissedIds);
  const through = inbox.optimisticDismissAllThrough;
  const notifications = inbox.notifications.filter((notification) => !pendingDismissedIds.has(notification.id) && (through === undefined || notification.order > through.order));
  let discardedCount = effectiveDiscardedCount(inbox.summary.discardedCount, inbox.dismissThrough.overflowWatermark, through?.overflowWatermark);
  if (notifications.length === 0 && pendingDismissedIds.size > 0) discardedCount = 0;
  return {
    machineId: inbox.machineId,
    sessionId: inbox.sessionId,
    cwd: inbox.cwd,
    daemonInstanceId: inbox.daemonInstanceId,
    notifications,
    retainedCount: notifications.length,
    discardedCount,
    ...optionalSeverity(highestNotificationSeverity(notifications)),
    dismissThrough: inbox.dismissThrough,
    pendingDismissedIds,
    dismissAllPending: through !== undefined,
    announcements: inbox.announcements,
  };
}

export function notificationSeverityLabel(severity: SessionNotificationSeverity): "Info" | "Warning" | "Error" {
  if (severity === "error") return "Error";
  if (severity === "warning") return "Warning";
  return "Info";
}

export function notificationAnnouncementLabel(announcement: Pick<SessionNotificationAnnouncement, "severity">): string {
  return `${notificationSeverityLabel(announcement.severity)} notification received.`;
}

export function notificationInboxTotalCount(inbox: Pick<SelectedSessionNotificationView, "retainedCount" | "discardedCount">): number {
  return inbox.retainedCount + inbox.discardedCount;
}

export function notificationTrayHeading(inbox: Pick<SelectedSessionNotificationView, "retainedCount" | "discardedCount">): string {
  return `Notifications (${String(notificationInboxTotalCount(inbox))})`;
}

export function notificationDismissLabel(notification: Pick<SessionNotification, "message" | "severity">): string {
  const message = notification.message.replace(/\s+/gu, " ").trim();
  if (message === "") return `Dismiss ${notificationSeverityLabel(notification.severity).toLowerCase()} notification`;
  const maxCharacters = 80;
  const characters = Array.from(message);
  const summary = characters.length <= maxCharacters ? message : `${characters.slice(0, maxCharacters - 1).join("").trimEnd()}…`;
  return `Dismiss notification: ${summary}`;
}

export type NotificationFocusTarget = { kind: "notification"; notificationId: string } | { kind: "header" };

export function notificationFocusTargetAfterDismiss(notifications: readonly SessionNotification[], notificationId: string): NotificationFocusTarget {
  const index = notifications.findIndex((notification) => notification.id === notificationId);
  if (index === -1) return { kind: "header" };
  const next = notifications[index + 1];
  if (next !== undefined) return { kind: "notification", notificationId: next.id };
  const previous = notifications[index - 1];
  return previous === undefined ? { kind: "header" } : { kind: "notification", notificationId: previous.id };
}

export function notificationTargetKey(target: SessionNotificationTarget): string {
  return JSON.stringify([target.machineId, target.cwd, target.sessionId]);
}

export function notificationTrayIsCollapsed(collapsedTargetKeys: ReadonlySet<string>, target: SessionNotificationTarget): boolean {
  return collapsedTargetKeys.has(notificationTargetKey(target));
}

export function setNotificationTrayCollapsed(collapsedTargetKeys: ReadonlySet<string>, target: SessionNotificationTarget, collapsed: boolean): ReadonlySet<string> {
  const next = new Set(collapsedTargetKeys);
  const key = notificationTargetKey(target);
  if (collapsed) next.add(key);
  else next.delete(key);
  return next;
}

export function notificationInboxOverflowLabel(discardedCount: number): string {
  return `${String(discardedCount)} older ${discardedCount === 1 ? "notification" : "notifications"} not shown.`;
}

export function notificationMessageTruncationLabel(notification: Pick<SessionNotification, "truncated">): string | undefined {
  if (!notification.truncated) return undefined;
  const kibibytes = SESSION_NOTIFICATION_MESSAGE_BYTES / 1024;
  return `Message truncated at ${String(kibibytes)} KiB.`;
}

export function notificationTargetsEqual(left: SessionNotificationTarget, right: SessionNotificationTarget): boolean {
  return left.machineId === right.machineId && left.sessionId === right.sessionId && left.cwd === right.cwd;
}

function higherNotificationSeverity(
  left: SessionNotificationSeverity | undefined,
  right: SessionNotificationSeverity | undefined,
): SessionNotificationSeverity | undefined {
  if (left === "error" || right === "error") return "error";
  if (left === "warning" || right === "warning") return "warning";
  if (left === "info" || right === "info") return "info";
  return undefined;
}

function staleSelectedNotificationInbox(target: SessionNotificationTarget): SelectedSessionNotificationInbox {
  return {
    ...loadingSelectedNotificationInbox(target),
    status: "stale",
  };
}

function notificationListMatchesSummary(notifications: readonly SessionNotification[], summary: SessionNotificationSummary): boolean {
  return notifications.length === summary.retainedCount && highestNotificationSeverity(notifications) === summary.highestSeverity;
}

function highestNotificationSeverity(notifications: readonly SessionNotification[]): SessionNotificationSeverity | undefined {
  let highest: SessionNotificationSeverity | undefined;
  for (const notification of notifications) highest = higherNotificationSeverity(highest, notification.severity);
  return highest;
}

function effectiveDiscardedCount(discardedCount: number, overflowWatermark: number, throughOverflowWatermark: number | undefined): number {
  if (discardedCount === 0 || throughOverflowWatermark === undefined) return discardedCount;
  const firstWatermark = overflowWatermark - discardedCount + 1;
  const acknowledged = Math.max(0, Math.min(discardedCount, throughOverflowWatermark - firstWatermark + 1));
  return discardedCount - acknowledged;
}

function optionalSeverity(severity: SessionNotificationSeverity | undefined): { highestSeverity?: SessionNotificationSeverity } {
  return severity === undefined ? {} : { highestSeverity: severity };
}
