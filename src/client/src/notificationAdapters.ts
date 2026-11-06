import type { NotificationGroup } from "./notificationArea";
import { notificationMessage, type SelectedSessionNotificationView } from "./sessionNotifications";

/** The caller captures the selection and guards actions against a later target. */
export function sessionNotificationGroup(
  view: SelectedSessionNotificationView,
  actions: {
    scopeLabel?: string;
    dismiss: (notificationId: string) => void | Promise<void>;
    clear: () => void | Promise<void>;
  },
): NotificationGroup {
  const owner = ["session", view.machineId, view.sessionId, view.cwd, view.daemonInstanceId];
  return {
    id: JSON.stringify(owner),
    discardedCount: view.discardedCount,
    pending: view.dismissAllPending,
    items: view.notifications.map((notification) => ({
      id: JSON.stringify([...owner, notification.id]),
      severity: notification.severity,
      message: notificationMessage(notification),
      receivedAt: notification.receivedAt,
      truncated: notification.truncated,
      source: "session",
      ...(actions.scopeLabel === undefined ? {} : { scopeLabel: actions.scopeLabel }),
      pending: view.dismissAllPending || view.pendingDismissedIds.has(notification.id),
      dismiss: () => actions.dismiss(notification.id),
    })),
    clear: actions.clear,
  };
}
