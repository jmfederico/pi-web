import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../appState";
import type { AppAction } from "../actions";
import { browserErrorScopeKey, machineBrowserErrorScope, workspaceBrowserErrorScope } from "../browserErrors";
import { HttpRequestError } from "../api/http";
import { ServerNoticesController } from "../serverNotices";
import type { Machine, Workspace } from "../api";
import type { ParsedAppRoute } from "../route";
import { PiWebApp } from "./PiWebApp";

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp browser error boundaries", () => {
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

  it("keeps unexpected action failures on the global browser surface", async () => {
    const app = createApp();
    const runAction = privateRunAction(app);
    const action: AppAction = { id: "test.action", title: "Test action", run: () => Promise.reject(new Error("action failed")) };

    runAction(action);
    await vi.waitFor(() => {
      expect(appState(app).browserErrors[browserErrorScopeKey({ kind: "global" })]?.message).toBe("Action failed: action failed");
    });

    expect(appState(app).error).toBe("");
  });
});

describe("PiWebApp workspace removal browser error boundary", () => {
  it("does not add a browser fallback when a matching server notice is fresh", async () => {
    const app = createApp();
    setState(app, { selectedWorkspace: workspace });
    const noticesValue: unknown = Reflect.get(app, "serverNotices");
    if (!(noticesValue instanceof ServerNoticesController)) throw new Error("Server notices controller was unavailable");
    const notices = noticesValue;
    vi.spyOn(notices, "hasNotice").mockReturnValue(true);
    const scope = workspaceBrowserErrorScope("local", workspace.projectId, workspace.id);

    await reportWorkspaceRemovalFailure(app)(workspace, "local", scope, new HttpRequestError("workspace has unsubmitted changes", 400));

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
  });
});
