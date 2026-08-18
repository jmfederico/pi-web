import { describe, expect, it } from "vitest";
import type {
  SessionNotification,
  SessionNotificationInboxEvent,
  SessionNotificationInboxSnapshot,
  SessionNotificationSummary,
} from "../../shared/apiTypes";
import {
  applySelectedNotificationEvent,
  installSelectedNotificationSnapshot,
  notificationAnnouncementLabel,
  notificationDismissLabel,
  notificationFocusTargetAfterDismiss,
  notificationInboxOverflowLabel,
  notificationInboxTotalCount,
  notificationMessageTruncationLabel,
  notificationTargetKey,
  notificationTrayHeading,
  notificationTrayIsCollapsed,
  selectedNotificationView,
  setNotificationTrayCollapsed,
  type SessionNotificationAnnouncement,
  type SessionNotificationTarget,
} from "./sessionNotifications";

const target: SessionNotificationTarget = { machineId: "local", sessionId: "session-1", cwd: "/repo" };

function notification(order: number, severity: SessionNotification["severity"] = "info", message = `notice ${String(order)}`): SessionNotification {
  return {
    id: `daemon-a:${String(order)}`,
    message,
    truncated: false,
    severity,
    receivedAt: `2026-07-18T00:00:${String(order).padStart(2, "0")}.000Z`,
    order,
  };
}

function summary(overrides: Partial<SessionNotificationSummary> = {}): SessionNotificationSummary {
  return {
    sessionId: "session-1",
    cwd: "/repo",
    inboxRevision: 1,
    retainedCount: 1,
    discardedCount: 0,
    highestSeverity: "info",
    ...overrides,
  };
}

function snapshot(notifications: SessionNotification[] = [notification(1)], overrides: Partial<SessionNotificationInboxSnapshot> = {}): SessionNotificationInboxSnapshot {
  return {
    daemonInstanceId: "daemon-a",
    catalogRevision: 1,
    summary: summary({ retainedCount: notifications.length, ...optionalHighestSeverity(notifications) }),
    notifications,
    dismissThrough: { order: notifications[0]?.order ?? 0, overflowWatermark: 0 },
    ...overrides,
  };
}

function addedEvent(entry: SessionNotification, inboxRevision: number, catalogRevision = inboxRevision): SessionNotificationInboxEvent {
  const notifications = [entry, notification(1)].filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
  return {
    type: "notifications.inbox",
    daemonInstanceId: "daemon-a",
    catalogRevision,
    summary: summary({ inboxRevision, retainedCount: notifications.length, ...optionalHighestSeverity(notifications) }),
    dismissThrough: { order: entry.order, overflowWatermark: 0 },
    delta: { kind: "added", notification: entry },
  };
}

describe("selected notification projection", () => {
  it("joins a snapshot with newer buffered events without duplicate cards or replay announcements", () => {
    let inbox = installSelectedNotificationSnapshot(undefined, target, snapshot());

    expect(inbox.announcements).toEqual([]);

    const added = addedEvent(notification(2, "warning"), 2);
    const first = applySelectedNotificationEvent(inbox, target, added);
    inbox = first.value;
    const duplicate = applySelectedNotificationEvent(inbox, target, added);

    expect(first.needsRefresh).toBe(false);
    expect(inbox.notifications.map((entry) => entry.id)).toEqual(["daemon-a:2", "daemon-a:1"]);
    expect(inbox.announcements).toEqual([{ id: "daemon-a:2:daemon-a:2", severity: "warning", message: "notice 2" }]);
    expect(duplicate.changed).toBe(false);
    expect(duplicate.value.announcements).toHaveLength(1);
  });

  it("marks gaps and resync deltas stale and clears old-daemon contents", () => {
    const current = installSelectedNotificationSnapshot(undefined, target, snapshot());
    const gap = applySelectedNotificationEvent(current, target, addedEvent(notification(3), 3));

    expect(gap.value.status).toBe("stale");
    expect(gap.needsRefresh).toBe(true);

    const resyncEvent: SessionNotificationInboxEvent = {
      ...addedEvent(notification(2), 2),
      delta: { kind: "resync" },
    };
    expect(applySelectedNotificationEvent(current, target, resyncEvent).needsRefresh).toBe(true);

    const restarted = applySelectedNotificationEvent(current, target, {
      ...addedEvent(notification(1), 1),
      daemonInstanceId: "daemon-b",
      catalogRevision: 1,
    });
    expect(restarted.value).toMatchObject({ status: "stale", notifications: [] });
    expect(restarted.value).not.toHaveProperty("daemonInstanceId");
  });

  it("drops old-daemon optimistic cutoffs and announcements when a restart snapshot arrives", () => {
    const current = {
      ...installSelectedNotificationSnapshot(undefined, target, snapshot()),
      optimisticDismissedIds: ["daemon-a:1"],
      optimisticDismissAllThrough: { order: 99, overflowWatermark: 12 },
      announcements: [{ id: "old-announcement", severity: "error" as const, message: "old" }],
    };
    const restarted = installSelectedNotificationSnapshot(current, target, snapshot([notification(1)], { daemonInstanceId: "daemon-b" }));

    expect(restarted.optimisticDismissedIds).toEqual([]);
    expect(restarted.optimisticDismissAllThrough).toBeUndefined();
    expect(restarted.announcements).toEqual([]);
    expect(selectedNotificationView(restarted)?.notifications).toHaveLength(1);
  });

  it("applies optimistic individual and cutoff dismissals while preserving newer arrivals", () => {
    const base = installSelectedNotificationSnapshot(undefined, target, snapshot(
      [notification(5, "error"), notification(4, "warning"), notification(3)],
      {
        summary: summary({ inboxRevision: 5, retainedCount: 3, discardedCount: 2, highestSeverity: "error" }),
        dismissThrough: { order: 5, overflowWatermark: 2 },
      },
    ));
    const optimistic = {
      ...base,
      notifications: [notification(6), ...base.notifications],
      summary: summary({ inboxRevision: 6, retainedCount: 4, discardedCount: 3, highestSeverity: "error" }),
      dismissThrough: { order: 6, overflowWatermark: 3 },
      optimisticDismissedIds: ["daemon-a:4"],
      optimisticDismissAllThrough: { order: 5, overflowWatermark: 2 },
    };

    const view = selectedNotificationView(optimistic);

    expect(view?.notifications.map((entry) => entry.order)).toEqual([6]);
    expect(view).toMatchObject({ retainedCount: 1, discardedCount: 1, highestSeverity: "info", dismissAllPending: true });
  });
});

describe("notification presentation helpers", () => {
  it("chooses next, previous, then header focus targets", () => {
    const notifications = [notification(3), notification(2), notification(1)];

    expect(notificationFocusTargetAfterDismiss(notifications, "daemon-a:2")).toEqual({ kind: "notification", notificationId: "daemon-a:1" });
    expect(notificationFocusTargetAfterDismiss(notifications, "daemon-a:1")).toEqual({ kind: "notification", notificationId: "daemon-a:2" });
    expect(notificationFocusTargetAfterDismiss([notification(1)], "daemon-a:1")).toEqual({ kind: "header" });
  });

  it("retains collapse state by exact machine, cwd, and session identity", () => {
    const collapsed = setNotificationTrayCollapsed(new Set(), target, true);

    expect(notificationTrayIsCollapsed(collapsed, target)).toBe(true);
    expect(notificationTrayIsCollapsed(collapsed, { ...target, machineId: "remote" })).toBe(false);
    expect(notificationTrayIsCollapsed(collapsed, { ...target, cwd: "/other" })).toBe(false);
    expect(notificationTrayIsCollapsed(collapsed, { ...target, sessionId: "session-2" })).toBe(false);
    expect(notificationTargetKey(target)).not.toBe(notificationTargetKey({ ...target, cwd: "/repo|session-1" }));
    expect(notificationTrayIsCollapsed(setNotificationTrayCollapsed(collapsed, target, false), target)).toBe(false);
  });

  it("derives compact tray copy and a count that includes older unseen notifications", () => {
    const counts = { retainedCount: 2, discardedCount: 23 };

    expect(notificationInboxTotalCount(counts)).toBe(25);
    expect(notificationTrayHeading(counts)).toBe("Notifications (25)");
    expect(notificationInboxOverflowLabel(1)).toBe("1 older notification not shown.");
    expect(notificationInboxOverflowLabel(23)).toBe("23 older notifications not shown.");
    expect(notificationMessageTruncationLabel({ truncated: true })).toBe("Message truncated at 8 KiB.");
    expect(notificationMessageTruncationLabel({ truncated: false })).toBeUndefined();
  });

  it("keeps live announcements concise and dismiss labels meaningful", () => {
    const announcement: SessionNotificationAnnouncement = {
      id: "daemon-a:2:daemon-a:2",
      severity: "error",
      message: "An arbitrarily long extension message that should not be read by the assertive live region",
    };
    const longNotification = notification(2, "warning", `  Build failed\n${"x".repeat(100)}`);

    expect(notificationAnnouncementLabel(announcement)).toBe("Error notification received.");
    expect(notificationDismissLabel(longNotification)).toMatch(/^Dismiss notification: Build failed x+…$/u);
    expect(notificationDismissLabel({ message: "   ", severity: "warning" })).toBe("Dismiss warning notification");
  });
});

function optionalHighestSeverity(notifications: readonly SessionNotification[]): { highestSeverity?: SessionNotification["severity"] } {
  const severity = highestSeverity(notifications);
  return severity === undefined ? {} : { highestSeverity: severity };
}

function highestSeverity(notifications: readonly SessionNotification[]): SessionNotification["severity"] | undefined {
  if (notifications.some((entry) => entry.severity === "error")) return "error";
  if (notifications.some((entry) => entry.severity === "warning")) return "warning";
  return notifications.length === 0 ? undefined : "info";
}
