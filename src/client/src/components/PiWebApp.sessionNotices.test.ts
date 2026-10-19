// @vitest-environment happy-dom
import { LitElement } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionInfo, SessionStatus } from "../api";
import { initialAppState, type AppState } from "../appState";
import type { SelectedSessionNotificationInbox } from "../sessionNotifications";
import { PiWebApp } from "./PiWebApp";
import { SessionNotificationTray } from "./SessionNotificationTray";

// The notices live in the shell's own top chrome, so this case mounts the shell
// without its network bootstrap and inspects the committed shadow DOM.
class SessionNoticesApp extends PiWebApp {
  override connectedCallback(): void {
    LitElement.prototype.connectedCallback.call(this);
  }

  override getBoundingClientRect(): DOMRect {
    return { width: 1200, height: 800, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
  }
}
customElements.define("session-notices-test-app", SessionNoticesApp);

const apps: PiWebApp[] = [];

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  apps.splice(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function selectedSession(): SessionInfo {
  return {
    id: "session-1",
    cwd: "/repo",
    path: "/repo/session-1.jsonl",
    created: "2026-07-14T00:00:00.000Z",
    modified: "2026-07-14T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
  };
}

function warningStatus(): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    warnings: [{ severity: "warning", message: "subscription auth is active" }],
  };
}

function inbox(): SelectedSessionNotificationInbox {
  return {
    machineId: "local",
    sessionId: "session-1",
    cwd: "/repo",
    status: "fresh",
    daemonInstanceId: "daemon",
    catalogRevision: 1,
    summary: { sessionId: "session-1", cwd: "/repo", inboxRevision: 1, retainedCount: 1, discardedCount: 0, highestSeverity: "error" },
    notifications: [{ id: "daemon:1", severity: "error", message: "Notice", truncated: false, receivedAt: "2026-07-18T00:00:00.000Z", order: 1 }],
    dismissThrough: { order: 0, overflowWatermark: 0 },
    optimisticDismissedIds: [],
    announcements: [],
  };
}

function noticesState(): AppState {
  return { ...initialAppState(), selectedSession: selectedSession(), status: warningStatus(), selectedNotificationInbox: inbox() };
}

async function mountApp(state: AppState): Promise<PiWebApp> {
  const app = new SessionNoticesApp();
  apps.push(app);
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebApp state");
  document.body.append(app);
  await app.updateComplete;
  await app.updateComplete;
  return app;
}

it("renders session warnings and the notification tray inside the auto-hiding top chrome", async () => {
  const app = await mountApp(noticesState());
  const chrome = app.renderRoot.querySelector(".top-chrome");
  if (!(chrome instanceof HTMLElement)) throw new Error("Expected the top chrome");

  const tray = chrome.querySelector("session-notification-tray");
  expect(tray).toBeInstanceOf(SessionNotificationTray);
  expect(chrome.querySelector(".top-notices .session-warning")).not.toBeNull();
  // The notices are chrome content, not transcript content: the scroll that
  // slides the app bar away takes them along instead of leaving them underneath.
  expect(app.renderRoot.querySelector("chat-view .top-notices")).toBeNull();
});

it("passes the selected inbox and the app's own dismiss actions to the tray", async () => {
  const app = await mountApp(noticesState());
  const tray = app.renderRoot.querySelector("session-notification-tray");
  if (!(tray instanceof SessionNotificationTray)) throw new Error("Expected notification tray");
  await tray.updateComplete;

  expect(tray.sessionId).toBe("session-1");
  expect(tray.notificationInbox?.notifications.map((notification) => notification.id)).toEqual(["daemon:1"]);
  expect(tray.onDismissNotification).toBe(Reflect.get(app, "handleDismissNotification"));
  expect(tray.onDismissAllNotifications).toBe(Reflect.get(app, "handleDismissAllNotifications"));
});

it("keeps the same tray across unrelated shell updates and re-targets it on a session switch", async () => {
  const app = await mountApp(noticesState());
  const tray = app.renderRoot.querySelector("session-notification-tray");
  if (!(tray instanceof SessionNotificationTray)) throw new Error("Expected notification tray");

  const calls = [...initialAppState().sessions];
  Reflect.set(app, "state", { ...noticesState(), sessions: calls });
  await app.updateComplete;
  expect(app.renderRoot.querySelector("session-notification-tray")).toBe(tray);

  const other: SessionInfo = { ...selectedSession(), id: "session-2" };
  Reflect.set(app, "state", { ...noticesState(), selectedSession: other, selectedNotificationInbox: undefined });
  await app.updateComplete;
  await tray.updateComplete;
  expect(tray.sessionId).toBe("session-2");
  expect(tray.renderRoot.querySelector(".notification-tray")).toBeNull();
});

it("drops the notices with the session, so an empty shell shows no header band", async () => {
  const app = await mountApp({ ...initialAppState() });

  expect(app.renderRoot.querySelector(".top-chrome .top-notices")).toBeNull();
});
