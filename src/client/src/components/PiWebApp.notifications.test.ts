// @vitest-environment happy-dom
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { AppState } from "../appState";
import { api, noticesApi, type SessionInfo } from "../api";
import { BrowserErrorReporter, browserErrorScopeKey, machineBrowserErrorScope, sessionBrowserErrorScope } from "../browserErrors";
import { SessionNotificationController } from "../controllers/sessionNotificationController";
import { SessionController } from "../controllers/sessionController";
import { ServerNoticesController } from "../serverNotices";
import { installSelectedNotificationSnapshot } from "../sessionNotifications";
import type { ServerNotice, SessionNotificationInboxSnapshot } from "../../../shared/apiTypes";
import { PiWebApp } from "./PiWebApp";
import { NotificationArea } from "./NotificationArea";
import { localization } from "../localization/browser";

const session: SessionInfo = { id: "session", cwd: "/repo", path: "/repo/session.jsonl", name: "Selected session", created: "now", modified: "now", messageCount: 0, firstMessage: "" };
const snapshot: SessionNotificationInboxSnapshot = {
  daemonInstanceId: "daemon", catalogRevision: 1,
  summary: { sessionId: session.id, cwd: session.cwd, inboxRevision: 1, retainedCount: 1, discardedCount: 2, highestSeverity: "warning" },
  notifications: [{ id: "notice", message: "Session warning", severity: "warning", receivedAt: "2026-08-01T00:00:00Z", truncated: false, order: 1 }],
  dismissThrough: { order: 1, overflowWatermark: 2 },
};

function state(app: PiWebApp): AppState {
  const value: unknown = Reflect.get(app, "state");
  if (!isAppState(value)) throw new Error("Missing app state");
  return value;
}
function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null && "browserErrors" in value;
}
function patch(app: PiWebApp, values: Partial<AppState>): void { Reflect.set(app, "state", { ...state(app), ...values }); }
function invoke(app: PiWebApp, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(app, name);
  if (typeof method !== "function") throw new Error(`Missing ${name}`);
  return Reflect.apply(method, app, args);
}
function server(app: PiWebApp): ServerNoticesController {
  const controller: unknown = Reflect.get(app, "serverNotices");
  if (!(controller instanceof ServerNoticesController)) throw new Error("Missing server notice controller");
  return controller;
}
function notifications(app: PiWebApp): SessionNotificationController {
  const controller: unknown = Reflect.get(app, "notifications");
  if (!(controller instanceof SessionNotificationController)) throw new Error("Missing session notification controller");
  return controller;
}
function reporter(app: PiWebApp): BrowserErrorReporter { return new BrowserErrorReporter(() => state(app), (values) => { patch(app, values); }); }
function createApp(): PiWebApp {
  window.history.replaceState(null, "", "/");
  return new PiWebApp();
}
async function areaFor(app: PiWebApp, host: HTMLElement, wholeShell = false): Promise<NotificationArea> {
  // Render the real shell/template without starting PiWebApp's network-owning connected lifecycle.
  render(wholeShell ? app.render() : invoke(app, "renderNotificationArea", state(app)), host);
  const area = host.querySelector("notification-area");
  if (!(area instanceof NotificationArea)) throw new Error("Missing unified notification area");
  await area.updateComplete;
  return area;
}
function host(): HTMLElement { const value = document.createElement("div"); document.body.append(value); return value; }
function notice(id: string, severity: ServerNotice["severity"] = "info"): ServerNotice {
  return { id, severity, message: `Server ${id}`, createdAt: "2026-08-01T00:00:00Z" };
}
function installServer(app: PiWebApp, notices: ServerNotice[], revision = 1): void {
  server(app).applyEvent("local", { type: "notices.updated", snapshot: { daemonInstanceId: "daemon", revision, notices } });
}
function items(area: NotificationArea) { return area.groups.flatMap((group) => group.items); }

afterEach(async () => {
  document.body.replaceChildren();
  localStorage.clear(); sessionStorage.clear();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await localization.setPreferences({ language: "en", formatLocale: "en" });
});

it("renders browser and server events in the shell without a selected conversation", async () => {
  const app = createApp();
  reporter(app).report({ kind: "global" }, "Browser failure");
  installServer(app, [notice("info"), notice("warning", "warning")]);
  const container = host();
  const area = await areaFor(app, container, true);
  expect(container.querySelector("conversation-layout")).toBeNull();
  // The area lives in the shell's auto-hiding top chrome, which sits inside main.
  expect(area.closest("main")).not.toBeNull();
  expect(area.closest(".top-chrome")).not.toBeNull();
  expect(items(area).map(({ source, severity }) => [source, severity])).toEqual([["browser", "error"], ["server", "info"], ["server", "warning"]]);
  expect(area.renderRoot.textContent).toContain("Browser failure");
  expect(area.renderRoot.textContent).toContain("Server info");
  const dismiss = vi.spyOn(server(app), "dismiss").mockResolvedValue();
  await items(area).find((item) => item.source === "server")?.dismiss?.();
  expect(dismiss).toHaveBeenCalledWith("local", "info");
  await items(area).find((item) => item.source === "browser")?.dismiss?.();
  expect(state(app).browserErrors).toEqual({});
});

it("filters browser errors by route and server events by selected machine/context", async () => {
  const app = createApp();
  reporter(app).report({ kind: "global" }, "global");
  reporter(app).report(machineBrowserErrorScope("remote"), "remote");
  reporter(app).report(sessionBrowserErrorScope("local", "other"), "other session");
  installServer(app, [notice("machine"), { ...notice("project"), scope: { projectId: "other" } }]);
  const container = host();
  let area = await areaFor(app, container);
  expect(items(area).map((item) => item.message)).toEqual(["global", "Server machine"]);
  window.history.replaceState(null, "", "/?machine=remote");
  const remote = { id: "remote", name: "Remote", kind: "remote" as const, createdAt: "now", updatedAt: "now" };
  patch(app, { selectedMachine: remote, machines: [remote] });
  area = await areaFor(app, container);
  expect(items(area).map((item) => item.message)).toEqual(["global", "remote"]);
  expect(items(area)[1]?.scopeLabel).toContain("Remote");
});

it("keeps browser occurrences stable across translation and protects same-text replacements from old clear closures", async () => {
  const app = createApp();
  const scope = machineBrowserErrorScope("local");
  let message = "localized";
  reporter(app).reportLocalized(scope, () => message);
  reporter(app).report({ kind: "global" }, "global");
  const container = host();
  const area = await areaFor(app, container);
  const old = items(area).find((item) => item.message === "localized");
  const clear = area.groups.find((group) => group.id === "browser")?.clear;
  message = "translated";
  await areaFor(app, container);
  expect(items(area).find((item) => item.message === "translated")?.id).toBe(old?.id);
  reporter(app).reportLocalized(scope, () => message);
  await clear?.();
  await old?.dismiss?.();
  expect(Object.values(state(app).browserErrors).map((error) => error.message)).toEqual(["translated"]);
  await areaFor(app, container);
  expect(items(area)[0]?.id).not.toBe(old?.id);
});

it("starts captured server clears together, preserves later notices, and reports partial failure without snapshot spam", async () => {
  const app = createApp();
  installServer(app, [notice("one"), notice("two")]);
  let finishFirst: ((value: { daemonInstanceId: string; revision: number; notices: ServerNotice[] }) => void) | undefined;
  let failSecond: ((error: Error) => void) | undefined;
  const dismiss = vi.spyOn(noticesApi, "dismiss")
    .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { failSecond = reject; }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const container = host();
  const area = await areaFor(app, container);
  const clearing = area.groups.find((group) => group.items.some((item) => item.source === "server"))?.clear?.();
  expect(dismiss.mock.calls).toEqual([["local", "daemon", "one"], ["local", "daemon", "two"]]);
  installServer(app, [notice("two"), notice("new")], 2);
  finishFirst?.({ daemonInstanceId: "daemon", revision: 2, notices: [notice("two"), notice("new")] });
  failSecond?.(new Error("dismiss refused"));
  await clearing;
  await areaFor(app, container);
  expect(items(area).filter((item) => item.source === "server").map((item) => item.message)).toEqual(["Server two", "Server new"]);
  expect(items(area).some((item) => item.source === "browser" && item.message.includes("dismiss refused"))).toBe(true);
  const errorsBeforeRefresh = state(app).browserErrors;
  vi.spyOn(noticesApi, "snapshot").mockRejectedValue(new Error("snapshot unavailable"));
  await server(app).refresh("local");
  expect(state(app).browserErrors).toBe(errorsBeforeRefresh);
});

it("projects the matching session outside chat, routes clear through its watermark, and rejects stale selection/daemon actions", async () => {
  const app = createApp();
  patch(app, { selectedSession: session, sessions: [session], mainView: "workspace" });
  const controller = notifications(app);
  controller.prepareSelectedSession(session, "local");
  const target = { machineId: "local", sessionId: session.id, cwd: session.cwd };
  patch(app, { selectedNotificationInbox: installSelectedNotificationSnapshot(undefined, target, snapshot) });
  const container = host();
  const area = await areaFor(app, container);
  const original = area.groups.find((group) => group.items.some((item) => item.source === "session"));
  expect(original?.discardedCount).toBe(2);
  expect(original?.items[0]?.scopeLabel).toContain("Selected session");
  const dismiss = vi.spyOn(controller, "dismissNotification").mockResolvedValue();
  await original?.items[0]?.dismiss?.();
  expect(dismiss).toHaveBeenCalledWith("notice");
  dismiss.mockClear();
  patch(app, { selectedSession: { ...session, id: "different" } });
  await original?.items[0]?.dismiss?.(); await original?.clear?.();
  expect(dismiss).not.toHaveBeenCalled();
  await areaFor(app, container);
  expect(items(area).filter((item) => item.source === "session")).toEqual([]);
  patch(app, { selectedSession: session, selectedNotificationInbox: installSelectedNotificationSnapshot(undefined, target, { ...snapshot, daemonInstanceId: "replacement" }) });
  await original?.items[0]?.dismiss?.();
  expect(dismiss).not.toHaveBeenCalled();
  patch(app, { selectedNotificationInbox: installSelectedNotificationSnapshot(undefined, target, snapshot) });
  await areaFor(app, container);
  const group = area.groups.find((candidate) => candidate.items.some((item) => item.source === "session"));
  const clearApi = vi.spyOn(api, "dismissAllNotifications").mockResolvedValue({ ...snapshot, summary: { ...snapshot.summary, inboxRevision: 2, retainedCount: 0, discardedCount: 0 }, notifications: [] });
  await group?.clear?.();
  expect(clearApi).toHaveBeenCalledWith({ id: session.id, cwd: session.cwd }, "daemon", snapshot.dismissThrough, "local");
  expect(dismiss).not.toHaveBeenCalled();
});

it("routes retry only for the captured browser failure and surfaces rejected area actions", async () => {
  const app = createApp();
  patch(app, { selectedSession: session });
  window.history.replaceState(null, "", "/?session=session");
  const controller: unknown = Reflect.get(app, "sessions");
  if (!(controller instanceof SessionController)) throw new Error("Missing sessions");
  const refresh = vi.spyOn(controller, "refreshSelectedSession").mockResolvedValue();
  const scope = sessionBrowserErrorScope("local", session.id, { cwd: session.cwd });
  reporter(app).report(scope, "Refresh failed", "session-refresh");
  const container = host();
  const area = await areaFor(app, container);
  const old = items(area)[0];
  const retry = old?.retry?.();
  expect(retry).toBe(refresh.mock.results[0]?.value);
  await retry;
  expect(refresh).toHaveBeenCalledWith(session.id, { recoverNetwork: true });
  reporter(app).report(scope, "Refresh failed", "session-refresh");
  await old?.retry?.();
  expect(refresh).toHaveBeenCalledOnce();
  area.onActionError(new Error("action rejected"));
  expect(state(app).browserErrors[browserErrorScopeKey({ kind: "global" })]?.message).toContain("action rejected");
});

it("does not clear a newer inbox or a replaced legacy error from a captured group", async () => {
  const app = createApp();
  const target = { machineId: "local", sessionId: session.id, cwd: session.cwd };
  patch(app, { selectedSession: session, error: "old", selectedNotificationInbox: installSelectedNotificationSnapshot(undefined, target, snapshot) });
  const area = await areaFor(app, host());
  const oldGroups = area.groups;
  const clear = vi.spyOn(notifications(app), "dismissAll").mockResolvedValue();
  patch(app, { error: "new", selectedNotificationInbox: installSelectedNotificationSnapshot(undefined, target, { ...snapshot, catalogRevision: 2 }) });
  await Promise.all(oldGroups.map(async (group) => { await group.clear?.(); }));
  expect(state(app).error).toBe("new");
  expect(clear).not.toHaveBeenCalled();
  expect(state(app).browserErrors[browserErrorScopeKey({ kind: "global" })]).toBeUndefined();
});
