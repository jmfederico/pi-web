// @vitest-environment happy-dom
import { render } from "lit";
import type { ServerNotice } from "../../../shared/apiTypes";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../appState";
import type { AppAction } from "../actions";
import { browserErrorScopeKey, machineBrowserErrorScope, workspaceBrowserErrorScope } from "../browserErrors";
import { HttpRequestError } from "../api/http";
import { ServerNoticesController } from "../serverNotices";
import type { Machine, Workspace } from "../api";
import type { ParsedAppRoute } from "../route";
import { PiWebApp } from "./PiWebApp";
import { NotificationArea } from "./NotificationArea";
import { localization } from "../localization/browser";
import { BrowserErrorReporter, type BrowserError } from "../browserErrors";
import { navigationOrderPort } from "../api/navigationOrder";
import { NavigationOrderController } from "../controllers/navigationOrderController";
import { ProjectWorkspaceError, projectWorkspaceMessages } from "../controllers/projectWorkspaceMessages";
import { appFeedbackMessages } from "../appFeedbackMessages";

const workspace: Workspace = {
  id: "workspace-1",
  projectId: "project-1",
  path: "/repo-feature",
  label: "feature",
  isMain: false,
  effectiveConfig: {},
};

function createApp(): PiWebApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebApp();
}

function appState(app: PiWebApp): AppState {
  const value: unknown = Reflect.get(app, "state");
  if (!isAppState(value)) throw new Error("PiWebApp state was unavailable");
  return value;
}

function setState(app: PiWebApp, patch: Partial<AppState>): AppState {
  const next: AppState = { ...appState(app), ...patch };
  if (!Reflect.set(app, "state", next)) throw new Error("Could not set PiWebApp state");
  return next;
}

type ReportWorkspaceRemovalFailure = (workspace: Workspace, machineId: string, scope: ReturnType<typeof workspaceBrowserErrorScope>, error: unknown) => Promise<void>;
type SetRemoteRouteRestoreMessage = (route: ParsedAppRoute, options?: { exhausted?: boolean }) => void;
type RunAction = (action: AppAction) => void;

function setRemoteRouteRestoreMessage(app: PiWebApp): SetRemoteRouteRestoreMessage {
  const method: unknown = Reflect.get(app, "setRemoteRouteRestoreMessage");
  if (!isSetRemoteRouteRestoreMessage(method)) throw new Error("Remote route restore message boundary was unavailable");
  return (route, options) => { method.call(app, route, options); };
}

function privateRunAction(app: PiWebApp): RunAction {
  const method: unknown = Reflect.get(app, "runAction");
  if (!isRunAction(method)) throw new Error("Action error boundary was unavailable");
  return (action) => { method.call(app, action); };
}

function reportWorkspaceRemovalFailure(app: PiWebApp): ReportWorkspaceRemovalFailure {
  const method: unknown = Reflect.get(app, "reportWorkspaceRemovalFailure");
  if (!isReportWorkspaceRemovalFailure(method)) throw new Error("Workspace removal failure boundary was unavailable");
  return (workspace, machineId, scope, error) => method.call(app, workspace, machineId, scope, error);
}

function isReportWorkspaceRemovalFailure(value: unknown): value is ReportWorkspaceRemovalFailure {
  return typeof value === "function";
}

function isSetRemoteRouteRestoreMessage(value: unknown): value is SetRemoteRouteRestoreMessage {
  return typeof value === "function";
}

function isRunAction(value: unknown): value is RunAction {
  return typeof value === "function";
}

function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null && "browserErrors" in value;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await localization.setPreferences({ language: "en", formatLocale: "en" });
  document.body.replaceChildren();
  localStorage.clear();
});

function invoke(app: PiWebApp, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(app, name);
  if (typeof method !== "function") throw new Error(`Missing ${name}`);
  return Reflect.apply(method, app, args);
}

async function expectLiveFeedback(error: BrowserError | undefined, detail?: string): Promise<void> {
  if (error === undefined) throw new Error("Missing retained browser feedback");
  const english = error.displayMessage?.();
  expect(english).toBe(error.message);
  for (const language of ["en-XA", "ar-XB"]) {
    await localization.setPreferences({ language, formatLocale: "en" });
    expect(error.displayMessage?.()).not.toBe(english);
    if (detail !== undefined) expect(error.displayMessage?.()).toContain(detail);
    expect(error.message).toBe(english);
  }
  await localization.setPreferences({ language: "en", formatLocale: "ar" });
  expect(error.displayMessage?.()).toBe(english);
}

describe("PiWebApp browser error boundaries", () => {
  it("retains machine-scoped navigation ordering failures through live language changes", async () => {
    const app = createApp();
    const failure = new Error("order.json / 日本語");
    vi.spyOn(navigationOrderPort, "load").mockRejectedValue(failure);
    const controller: unknown = Reflect.get(app, "navigationOrder");
    if (!(controller instanceof NavigationOrderController)) throw new Error("Missing navigation order");
    await expect(controller.ensure({ kind: "projects", machineId: "remote-1" })).rejects.toBe(failure);
    const error = appState(app).browserErrors[browserErrorScopeKey(machineBrowserErrorScope("remote-1"))];
    expect(error?.message).toBe("Failed to load or save navigation order: order.json / 日本語");
    await expectLiveFeedback(error, failure.message);
  });

  it("localizes remote-machine confirmation at invocation without altering its name or removing a cancelled machine", async () => {
    const app = createApp();
    const confirm = vi.fn<typeof window.confirm>(() => false);
    Object.assign(window, { confirm });
    const remote: Machine = { id: "remote-1", name: "User machine/日本語", kind: "remote", createdAt: "now", updatedAt: "now" };
    setState(app, { machines: [remote], selectedMachine: remote });
    for (const language of ["en", "en-XA", "ar-XB"]) {
      await localization.setPreferences({ language, formatLocale: "en" });
      await invoke(app, "removeMachine", remote);
      expect(confirm).toHaveBeenLastCalledWith(appFeedbackMessages.t("removeMachine", { name: remote.name }));
      expect(confirm.mock.lastCall?.[0]).toContain(remote.name);
      expect(appState(app).machines).toEqual([remote]);
    }
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it("keeps nested browser-owned action guidance live instead of freezing its language", async () => {
    const app = createApp();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = new ProjectWorkspaceError(() => projectWorkspaceMessages.t("projectNotFound"));
    privateRunAction(app)({ id: "test.action", title: "Test", run: () => { throw failure; } });
    await vi.waitFor(() => { expect(Object.keys(appState(app).browserErrors)).toHaveLength(1); });
    const error = appState(app).browserErrors[browserErrorScopeKey({ kind: "global" })];
    for (const language of ["en-XA", "ar-XB"]) {
      await localization.setPreferences({ language, formatLocale: "en" });
      expect(error?.displayMessage?.()).toBe(appFeedbackMessages.t("actionFailed", { detail: failure.message }));
      expect(error?.displayMessage?.()).not.toContain("Project not found");
    }
  });

  it("keeps remote route restore feedback on the affected machine", () => {
    const app = createApp();
    const remote: Machine = {
      id: "remote-1",
      name: "Remote",
      kind: "remote",
      createdAt: "now",
      updatedAt: "now",
    };
    setState(app, { machines: [remote], selectedMachine: remote, error: "A legacy failure" });

    setRemoteRouteRestoreMessage(app)({ machineId: remote.id, projectId: "project-1", workspaceId: undefined, sessionId: undefined, tool: undefined, view: undefined });

    expect(appState(app).error).toBe("A legacy failure");
    expect(appState(app).browserErrors[browserErrorScopeKey(machineBrowserErrorScope(remote.id))]?.message).toBe("Remote is unavailable; reconnecting…");
  });

  it("retains live reconnect feedback without nesting banners or recognizing English diagnostic prefixes", async () => {
    const app = createApp();
    const remote: Machine = { id: "remote-1", name: "Remote/日本語", kind: "remote", createdAt: "now", updatedAt: "now" };
    setState(app, { machines: [remote], selectedMachine: remote });
    const scope = machineBrowserErrorScope(remote.id);
    // This is a raw diagnostic, even though it starts like the old generated banner.
    const detail = `${remote.name} is unavailable: raw connection failure`;
    new BrowserErrorReporter(() => appState(app), (patch) => { setState(app, patch); }).report(scope, detail);
    const route: ParsedAppRoute = { machineId: remote.id, projectId: undefined, workspaceId: undefined, sessionId: undefined, tool: undefined, view: undefined };
    const report = setRemoteRouteRestoreMessage(app);
    report(route);
    const first = appState(app).browserErrors[browserErrorScopeKey(scope)];
    expect(first?.message).toBe(`${remote.name} is unavailable; reconnecting… ${detail}`);
    for (const language of ["en-XA", "ar-XB"]) {
      await localization.setPreferences({ language, formatLocale: "en" });
      expect(first?.displayMessage?.()).not.toBe(first?.message);
      expect(first?.displayMessage?.()).toContain(detail);
      expect(first?.displayMessage?.()).toContain(remote.name);
      report(route, { exhausted: true });
      const retry = appState(app).browserErrors[browserErrorScopeKey(scope)];
      expect(retry?.displayMessage?.()).toContain(detail);
      expect(retry?.displayMessage?.().split(detail)).toHaveLength(2);
    }
    await localization.setPreferences({ language: "en", formatLocale: "ar" });
    expect(appState(app).browserErrors[browserErrorScopeKey(scope)]?.displayMessage?.()).toBe(`${remote.name} is still unavailable. ${detail}`);
  });

  it("keeps unexpected action failures on the global browser surface", async () => {
    const app = createApp();
    const runAction = privateRunAction(app);
    const failure = new Error("action failed");
    const originalWarn = console.warn;
    const capturedWarnings: unknown[][] = [];
    const unexpectedWarnings: unknown[][] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      if (args.length === 2 && args[0] === "Action failed: test.action" && args[1] === failure) {
        capturedWarnings.push(args);
      } else {
        unexpectedWarnings.push(args);
        originalWarn(...args);
      }
    });
    const action: AppAction = { id: "test.action", title: "Test action", run: () => Promise.reject(failure) };

    runAction(action);
    await vi.waitFor(() => {
      expect(appState(app).browserErrors[browserErrorScopeKey({ kind: "global" })]?.message).toBe("Action failed: action failed");
    });

    expect(appState(app).error).toBe("");
    expect(unexpectedWarnings).toEqual([]);
    expect(capturedWarnings).toEqual([["Action failed: test.action", failure]]);
    await expectLiveFeedback(appState(app).browserErrors[browserErrorScopeKey({ kind: "global" })], failure.message);
  });
});

describe("PiWebApp workspace removal browser error boundary", () => {
  it("retains unavailable-removal guidance without attempting provider removal", async () => {
    const app = createApp();
    setState(app, { selectedWorkspace: workspace });
    await invoke(app, "deleteWorkspace", workspace);
    const error = appState(app).browserErrors[browserErrorScopeKey(workspaceBrowserErrorScope("local", workspace.projectId, workspace.id))];
    expect(error?.message).toBe("Workspace removal is not available");
    await expectLiveFeedback(error);
  });

  it("retains completed-removal refresh feedback and nested browser guidance while scheduling a retry", async () => {
    const app = createApp();
    setState(app, { selectedProject: { id: workspace.projectId, name: "Repo", path: "/repo", createdAt: "now" } });
    const controller = new AbortController();
    Reflect.set(app, "workspaceDeletionRefreshAbort", controller);
    const generation: unknown = Reflect.get(app, "workspaceDeletionRefreshGeneration");
    const workspaces: unknown = Reflect.get(app, "workspaces");
    if (typeof workspaces !== "object" || workspaces === null) throw new Error("Missing workspaces");
    const failure = new ProjectWorkspaceError(() => projectWorkspaceMessages.t("projectNotFound"));
    const refresh = vi.fn(() => Promise.reject(failure));
    Reflect.set(workspaces, "refreshAfterWorkspaceDeleted", refresh);
    await invoke(app, "handleCompletedWorkspaceDeletionRun", {
      id: "run", projectId: workspace.projectId, status: "succeeded",
      metadata: { "pi.operation": "workspace.delete", "target.workspaceId": workspace.id },
    }, "local", workspace.projectId, generation, controller);
    expect(refresh).toHaveBeenCalledOnce();
    const scope = workspaceBrowserErrorScope("local", workspace.projectId, workspace.id);
    const error = appState(app).browserErrors[browserErrorScopeKey(scope)];
    expect(error?.message).toContain("Retrying");
    for (const language of ["en-XA", "ar-XB"]) {
      await localization.setPreferences({ language, formatLocale: "en" });
      expect(error?.displayMessage?.()).toBe(appFeedbackMessages.t("workspaceRemovalRefreshFailed", { detail: failure.message }));
    }
  });

  it("renders retained generated server notices live, keeps raw plugin messages and dismisses the original id", async () => {
    const app = createApp();
    const controller: unknown = Reflect.get(app, "serverNotices");
    if (!(controller instanceof ServerNoticesController)) throw new Error("Missing notices");
    const diagnostic = "raw <img> /repo {value}";
    const notices: ServerNotice[] = [
      { id: "start", severity: "error", message: `Workspace removal failed: ${diagnostic}`, presentation: { kind: "workspaceRemovalFailed", detail: diagnostic }, createdAt: "2026-08-01T00:00:00.000Z" },
      { id: "exit", severity: "warning", message: "Workspace removal failed. See terminal output.", presentation: { kind: "workspaceRemovalCommandFailed" }, createdAt: "2026-08-01T00:00:00.000Z" },
      { id: "plugin", severity: "info", message: "Workspace removal failed. See terminal output.", source: "plugin:custom", createdAt: "2026-08-01T00:00:00.000Z" },
    ];
    vi.spyOn(controller, "projection").mockReturnValue({ machineId: "local", status: "fresh", daemonInstanceId: "daemon", revision: 1, notices });
    const dismiss = vi.spyOn(controller, "dismiss").mockResolvedValue();
    const container = document.createElement("div");
    document.body.append(container);
    for (const language of ["en", "en-XA", "ar-XB"]) {
      await localization.setPreferences({ language, formatLocale: "en" });
      render(invoke(app, "renderNotificationArea", appState(app)), container);
      const area = container.querySelector("notification-area");
      if (!(area instanceof NotificationArea)) throw new Error("Missing unified notifications");
      await area.updateComplete;
      const items = area.groups.flatMap((group) => group.items);
      expect(items).toHaveLength(3);
      expect(items[0]?.message).toContain(diagnostic);
      expect(items[0]?.message === notices[0]?.message).toBe(language === "en");
      expect(items[1]?.message === notices[1]?.message).toBe(language === "en");
      expect(items[2]?.message).toBe(notices[2]?.message);
      expect(area.renderRoot.querySelector("img")).toBeNull();
    }
    const area = container.querySelector("notification-area");
    if (!(area instanceof NotificationArea)) throw new Error("Missing unified notifications");
    await area.groups.flatMap((group) => group.items)[0]?.dismiss?.();
    expect(dismiss).toHaveBeenCalledWith("local", "start");
  });

  it("does not add a browser fallback when a matching server notice is fresh", async () => {
    const app = createApp();
    setState(app, { selectedWorkspace: workspace });
    const noticesValue: unknown = Reflect.get(app, "serverNotices");
    if (!(noticesValue instanceof ServerNoticesController)) throw new Error("Server notices controller was unavailable");
    const notices = noticesValue;
    const hasNotice = vi.spyOn(notices, "hasNotice").mockImplementation((machineId, matches) => {
      expect(machineId).toBe("local");
      return matches({
        id: "notice-1",
        severity: "error",
        message: "Workspace removal failed: workspace has unsubmitted changes",
        createdAt: "2026-08-01T00:00:00.000Z",
        source: "workspace.delete",
        scope: { projectId: workspace.projectId },
        context: { targetWorkspaceId: workspace.id },
      });
    });
    const scope = workspaceBrowserErrorScope("local", workspace.projectId, workspace.id);

    await reportWorkspaceRemovalFailure(app)(workspace, "local", scope, new HttpRequestError("workspace has unsubmitted changes", 400));

    expect(hasNotice).toHaveBeenCalledTimes(2);
    expect(appState(app).browserErrors).toEqual({});
  });

  it("uses the browser fallback when a server response has no matching notice", async () => {
    const app = createApp();
    setState(app, { selectedWorkspace: workspace });
    const noticesValue: unknown = Reflect.get(app, "serverNotices");
    if (!(noticesValue instanceof ServerNoticesController)) throw new Error("Server notices controller was unavailable");
    const notices = noticesValue;
    const hasNotice = vi.spyOn(notices, "hasNotice").mockReturnValue(false);
    const refresh = vi.spyOn(notices, "refresh").mockResolvedValue();
    const scope = workspaceBrowserErrorScope("local", workspace.projectId, workspace.id);

    await reportWorkspaceRemovalFailure(app)(workspace, "local", scope, new HttpRequestError("workspace confirmation is stale", 409));

    expect(appState(app).browserErrors[browserErrorScopeKey(scope)]?.message).toBe("Failed to start workspace removal: workspace confirmation is stale");
    expect(hasNotice).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledWith("local");
    await expectLiveFeedback(appState(app).browserErrors[browserErrorScopeKey(scope)], "workspace confirmation is stale");
  });

  it("keeps browser feedback for the gateway's session-daemon-unavailable response", async () => {
    const app = createApp();
    setState(app, { selectedWorkspace: workspace });
    const noticesValue: unknown = Reflect.get(app, "serverNotices");
    if (!(noticesValue instanceof ServerNoticesController)) throw new Error("Server notices controller was unavailable");
    const notices = noticesValue;
    const hasNotice = vi.spyOn(notices, "hasNotice");
    const scope = workspaceBrowserErrorScope("local", workspace.projectId, workspace.id);

    await reportWorkspaceRemovalFailure(app)(workspace, "local", scope, new HttpRequestError("Session daemon unavailable: connection refused", 502));

    expect(appState(app).browserErrors[browserErrorScopeKey(scope)]?.message).toBe("Failed to start workspace removal: Session daemon unavailable: connection refused");
    expect(hasNotice).not.toHaveBeenCalled();
    await expectLiveFeedback(appState(app).browserErrors[browserErrorScopeKey(scope)], "Session daemon unavailable: connection refused");
  });
});
