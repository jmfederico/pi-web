// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { MANUAL_CHAT_BEHAVIORS } from "../chatBehaviors.testSupport";
import type { SelectedSessionNotificationView } from "../sessionNotifications";
import { ChatView } from "./ChatView";
import { SessionNotificationTray } from "./SessionNotificationTray";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

it("passes notification inputs/actions to a stable tray across unrelated chat updates and session switches", async () => {
  const view = new ChatView();
  view.behaviors = MANUAL_CHAT_BEHAVIORS;
  view.sessionId = "session-1";
  const inbox: SelectedSessionNotificationView = {
    machineId: "local", sessionId: view.sessionId, cwd: "/repo", daemonInstanceId: "daemon",
    notifications: [{ id: "daemon:1", severity: "info", message: "Notice", truncated: false, receivedAt: "2026-07-18T00:00:00.000Z", order: 1 }],
    retainedCount: 1, discardedCount: 0, pendingDismissedIds: new Set(), dismissAllPending: false,
    dismissThrough: { order: 1, overflowWatermark: 0 }, announcements: [],
  };
  view.notificationInbox = inbox;
  view.onDismissAllNotifications = vi.fn();
  view.onDismissNotification = vi.fn();
  document.body.append(view); await view.updateComplete;
  const tray = view.renderRoot.querySelector("session-notification-tray");
  if (!(tray instanceof SessionNotificationTray)) throw new Error("Expected notification tray");
  await tray.updateComplete;
  expect(tray.notificationInbox).toBe(inbox);
  expect(tray.onDismissNotification).toBe(view.onDismissNotification);
  tray.renderRoot.querySelector<HTMLButtonElement>(".notification-clear")?.click();
  expect(view.onDismissAllNotifications).toHaveBeenCalledOnce();
  view.messages = [{ role: "assistant", parts: [{ type: "text", text: "Unrelated reply" }] }];
  await view.updateComplete;
  expect(view.renderRoot.querySelector("session-notification-tray")).toBe(tray);
  view.sessionId = "session-2"; await view.updateComplete; await tray.updateComplete;
  expect(tray.sessionId).toBe("session-2");
  expect(tray.renderRoot.querySelector(".notification-tray")).toBeNull();
});
