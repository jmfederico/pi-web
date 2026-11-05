// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { SessionInfo } from "../api";
import { localization } from "../localization/browser";
import { sessionNotificationMessages } from "../sessionNotificationMessages";
import { notificationDismissLabel, type SelectedSessionNotificationView } from "../sessionNotifications";
import { installPopoverFake } from "./anchoredPopup.testSupport";
installPopoverFake();
import { SessionList, sessionNavigationMessages as messages } from "./SessionList";
import { SessionNotificationTray } from "./SessionNotificationTray";

let release: (() => void) | undefined;
afterEach(async () => {
  document.body.replaceChildren();
  release?.(); release = undefined;
  await localization.setPreferences({ language: "en", formatLocale: "en" });
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return { id, path: `/sessions/${id}.jsonl`, cwd: "/workspace", created: "2026-06-09T00:00:00.000Z", modified: "2026-06-09T00:00:00.000Z", messageCount: 1234, firstMessage: "User <b>message</b>", persisted: true, ...overrides };
}
function required<T extends HTMLElement>(host: HTMLElement, selector: string, type: new () => T): T {
  const found = host.shadowRoot?.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`Missing ${selector}`);
  return found;
}
async function settle(view: SessionList | SessionNotificationTray): Promise<void> {
  await view.updateComplete;
  await view.updateComplete;
}

it("keeps session selection, focus, expansion, content and tree caches stable across live locales", async () => {
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
  const view = new SessionList();
  const root = session("root");
  const child = session("child", { parentSessionPath: root.path, agentSubsession: true });
  view.sessions = [root, child];
  view.unreadSessionIds = new Set([child.id]);
  view.sending = { [child.id]: true };
  view.onSelect = vi.fn(); view.onArchiveMany = vi.fn();
  document.body.append(view);
  await settle(view);
  required(view, ".bulk-select-entry", HTMLButtonElement).click();
  await settle(view);
  const checkbox = required(view, ".session-checkbox", HTMLInputElement);
  checkbox.focus();
  await settle(view);
  const rows = view.automaticSessionCandidates(view.sessions);
  const calls = scroll.mock.calls.length;
  for (const language of ["en-XA", "ar-XB", "en"]) {
    await localization.setPreferences({ language, formatLocale: "de-DE" });
    await settle(view);
    expect(required(view, ".section-unread-count", HTMLElement).textContent).toBe(messages.t("unread", { count: 1 }));
    expect(required(view, ".session-meta", HTMLElement).textContent).toBe(messages.t("sessionMeta", { state: "other", count: 1234 }));
    expect(required(view, ".agent-subsession-label", HTMLElement).textContent).toContain(messages.t("agentSubsessions", { count: 1 }));
    expect(required(view, ".bulk-row button", HTMLElement).textContent).toBe(messages.t("clearSelected", { count: 2 }));
    expect(checkbox.checked).toBe(true);
    expect(checkbox.getAttribute("aria-label")).toBe(messages.t("selectSession", { label: root.firstMessage }));
    expect(view.shadowRoot?.activeElement).toBe(checkbox);
    expect(view.automaticSessionCandidates(view.sessions)).toEqual(rows);
    expect(required(view, ".agent-subsession-toggle", HTMLElement).getAttribute("aria-expanded")).toBe("false");
    expect(view.shadowRoot?.textContent).toContain(root.firstMessage);
    expect(view.shadowRoot?.querySelector("b")).toBeNull();
    expect(view.onSelect).not.toHaveBeenCalled();
    expect(view.onArchiveMany).not.toHaveBeenCalled();
    expect(scroll.mock.calls.length).toBe(calls);
  }
});

it("updates intervention status and collapsed rollup labels when language changes", async () => {
  const view = new SessionList();
  const root = session("root", { interventionRequired: true });
  const child = session("child", { parentSessionPath: root.path, agentSubsession: true, interventionRequired: true });
  view.sessions = [root, child];
  document.body.append(view);
  await settle(view);
  release = localization.registerCatalog({ id: "intervention-test", namespace: "core.activityBadge", locale: "de", load: () => Promise.resolve({ needsInput: "Eingabe erforderlich" }) });
  await localization.setPreferences({ language: "de", formatLocale: "de-DE" });
  await settle(view);
  expect(required(view, ".session-meta", HTMLElement).textContent).toContain("Eingabe erforderlich");
  expect(required(view, ".action-row .activity-indicator", HTMLElement).getAttribute("aria-label")).toBe("Eingabe erforderlich");
  expect(required(view, ".agent-subsession-toggle .activity-indicator", HTMLElement).title).toBe("Eingabe erforderlich");
});

it("keeps a session action menu open and renders destructive confirmations in the current language", async () => {
  const view = new SessionList();
  const archived = session("archived", { archived: true, name: "User <img> session" });
  view.sessions = [archived];
  view.onDeleteArchived = vi.fn();
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  document.body.append(view);
  await settle(view);
  required(view, ".subheading .section-toggle", HTMLButtonElement).click();
  await settle(view);
  required(view, ".action-menu-toggle", HTMLButtonElement).click();
  await settle(view);
  const button = required(view, ".action-menu-panel .danger", HTMLButtonElement);
  button.focus();
  release = localization.registerCatalog({ id: "session-test", namespace: "core.sessionNavigation", locale: "de", load: () => Promise.resolve({ deleteArchived: "Archivierte Sitzung löschen", confirmDelete: "Archivierte Sitzung „{label}“ dauerhaft löschen? Dies kann nicht rückgängig gemacht werden." }) });
  for (const language of ["de", "en-XA", "ar-XB"]) {
    await localization.setPreferences({ language, formatLocale: "de-DE" });
    await settle(view);
    expect(required(view, ".action-menu-panel .danger", HTMLElement)).toBe(button);
    expect(button.textContent).toBe(messages.t("deleteArchived"));
    expect(view.shadowRoot?.activeElement).toBe(button);
    expect(confirm).not.toHaveBeenCalled();
  }
  button.click();
  expect(confirm).toHaveBeenCalledExactlyOnceWith(messages.t("confirmDelete", { label: archived.name ?? "" }));
  expect(view.onDeleteArchived).not.toHaveBeenCalled();
});

it("updates notification chrome, announcements and regional time without changing content, collapse or callbacks", async () => {
  const notification = { id: "daemon:1", message: "User <b>notice</b> https://example.com/value", severity: "warning" as const, truncated: true, receivedAt: "2026-07-18T00:00:00.000Z", order: 1 };
  const inbox: SelectedSessionNotificationView = { machineId: "local", sessionId: "s", cwd: "/repo", daemonInstanceId: "daemon", notifications: [notification], retainedCount: 1, discardedCount: 1234, highestSeverity: "warning", dismissThrough: { order: 1, overflowWatermark: 0 }, pendingDismissedIds: new Set(), dismissAllPending: false, announcements: [{ id: "a", severity: "warning", message: notification.message }] };
  const view = new SessionNotificationTray();
  view.sessionId = "s"; view.notificationInbox = inbox;
  view.onDismissNotification = vi.fn(); view.onDismissAllNotifications = vi.fn();
  document.body.append(view);
  await settle(view);
  const toggle = required(view, ".notification-toggle", HTMLButtonElement);
  const announcement = required(view, "[data-announcement-id='a']", HTMLElement);
  toggle.click(); toggle.focus();
  for (const language of ["en-XA", "ar-XB", "en"]) {
    await localization.setPreferences({ language, formatLocale: "ar-EG", timeZone: "Asia/Tokyo", hourCycle: "h23" });
    await settle(view);
    expect(required(view, ".notification-heading", HTMLElement).textContent).toBe(sessionNotificationMessages.t("heading", { count: 1235 }));
    expect(toggle.getAttribute("aria-label")).toBe(sessionNotificationMessages.t("expand"));
    expect(required(view, ".notification-list", HTMLElement).hidden).toBe(true);
    expect(view.shadowRoot?.activeElement).toBe(toggle);
    expect(required(view, ".notification-message", HTMLElement).textContent).toBe(notification.message);
    expect(view.shadowRoot?.querySelector("b")).toBeNull();
    expect(required(view, ".notification-row-dismiss", HTMLElement).getAttribute("aria-label")).toBe(notificationDismissLabel(notification));
    expect(required(view, "time", HTMLElement).textContent).toBe(new Intl.DateTimeFormat("ar-EG", { timeStyle: "short", timeZone: "Asia/Tokyo", hourCycle: "h23" }).format(new Date(notification.receivedAt)));
    expect(required(view, "[data-announcement-id='a']", HTMLElement)).toBe(announcement);
    expect(announcement.textContent).toBe(sessionNotificationMessages.t("announcement", { severity: "warning" }));
    expect(view.onDismissNotification).not.toHaveBeenCalled(); expect(view.onDismissAllNotifications).not.toHaveBeenCalled();
  }
  toggle.click(); await settle(view);
  required(view, ".notification-row-dismiss", HTMLButtonElement).click();
  expect(view.onDismissNotification).toHaveBeenCalledExactlyOnceWith(notification.id);
});
