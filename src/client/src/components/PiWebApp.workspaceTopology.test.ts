// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type Project } from "../api";
import { navigationOrderPort } from "../api/navigationOrder";
import type { AppState } from "../appState";
import { SessionController } from "../controllers/sessionController";
import { RealtimeSocket, type BrowserRealtimeEvent } from "../sessionSocket";
import { WorkspaceController } from "../controllers/workspaceController";
import { PiWebApp } from "./PiWebApp";

type RefreshCallback = () => void | Promise<void>;

const project: Project = { id: "project-1", name: "repo", path: "/repo", createdAt: "2026-07-20T00:00:00.000Z" };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp workspace topology refresh wiring", () => {
  it("refreshes a visible idle selected transcript", async () => {
    const app = createApp();
    selectSessionForPolling(app);
    vi.stubGlobal("document", { visibilityState: "visible" });
    const sessions: unknown = Reflect.get(app, "sessions");
    if (!hasSelectedSessionRefresh(sessions)) throw new Error("PiWebApp SessionController was unavailable");
    const refresh = vi.spyOn(sessions, "refreshSelectedSession").mockResolvedValue();
    const tick: unknown = Reflect.get(app, "refreshSelectedTranscript");
    if (typeof tick !== "function") throw new Error("Selected transcript refresh was unavailable");

    await tick.call(app);

    expect(refresh).toHaveBeenCalledOnce();
    // The timer-driven poll is a best-effort background refresh: failures must
    // not churn the global error state.
    expect(refresh).toHaveBeenCalledWith("session-1", { silent: true });
  });

  it.each([
    ["hidden document", { visibilityState: "hidden", isStreaming: false }],
  ])("does not poll a %s", async (_label: string, options: { visibilityState: string; isStreaming: boolean }) => {
    const app = createApp();
    selectSessionForPolling(app, options.isStreaming);
    vi.stubGlobal("document", { visibilityState: options.visibilityState });
    const sessions: unknown = Reflect.get(app, "sessions");
    if (!hasSelectedSessionRefresh(sessions)) throw new Error("PiWebApp SessionController was unavailable");
    const refresh = vi.spyOn(sessions, "refreshSelectedSession").mockResolvedValue();
    const tick: unknown = Reflect.get(app, "refreshSelectedTranscript");
    if (typeof tick !== "function") throw new Error("Selected transcript refresh was unavailable");

    await tick.call(app);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("uses one slow reconciliation loop even when the conversation is active", async () => {
    vi.useFakeTimers();
    const app = createApp();
    selectSessionForPolling(app, true);
    vi.stubGlobal("document", { visibilityState: "visible" });
    const sessions: unknown = Reflect.get(app, "sessions");
    if (!hasSelectedSessionRefresh(sessions)) throw new Error("SessionController unavailable");
    const refresh = vi.spyOn(sessions, "refreshSelectedSession").mockResolvedValue();
    vi.stubGlobal("window", { location: window.location, localStorage: window.localStorage, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const schedule: unknown = Reflect.get(app, "scheduleSelectedSessionRefresh");
    if (typeof schedule !== "function") throw new Error("Transcript polling unavailable");
    schedule.call(app);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.clearAllTimers();
  });

  it("re-lists the selected project's workspaces on the browser-resume refresh", async () => {
    const app = createApp();
    stubBackgroundRefreshes(app);
    const refreshTopology = spyOnTopologyRefresh(app);
    const refreshSurface = replaceRefresh(app, "refreshCurrentWorkspaceSurface");
    const refreshSessions = spyOnWorkspaceSessionsRefresh(app);
    const sessions: unknown = Reflect.get(app, "sessions");
    if (!(sessions instanceof SessionController)) throw new Error("SessionController was unavailable");
    const refreshSelected = vi.spyOn(sessions, "refreshSelectedSession").mockResolvedValue();
    const resumeSelected = vi.spyOn(sessions, "resumeSelectedSession");

    await browserResumeRefresh(app)();

    expect(resumeSelected).toHaveBeenCalledExactlyOnceWith({ reconnect: false });
    expect(refreshSelected).toHaveBeenCalledExactlyOnceWith(undefined, { recoverNetwork: true });
    expect(refreshSessions).toHaveBeenCalledExactlyOnceWith("local", { recoverNetwork: true });
    expect(refreshTopology).toHaveBeenCalledOnce();
    expect(refreshSurface).toHaveBeenCalledOnce();
  });

  it("does not wait for an unread request before refreshing the conversation after resume", async () => {
    const app = createApp();
    stubBackgroundRefreshes(app);
    const unread: unknown = Reflect.get(app, "sessionUnread");
    if (typeof unread !== "object" || unread === null) throw new Error("Unread controller was unavailable");
    let finishUnread: (() => void) | undefined;
    const pendingUnread = new Promise<void>((resolve) => { finishUnread = resolve; });
    Reflect.set(unread, "refreshAll", () => pendingUnread);
    const refreshSessions = spyOnWorkspaceSessionsRefresh(app);
    spyOnTopologyRefresh(app);

    const refresh = browserResumeRefresh(app)();
    expect(refreshSessions).toHaveBeenCalledOnce();
    if (finishUnread === undefined) throw new Error("Unread completion was unavailable");
    finishUnread();
    await refresh;
  });

  it("re-lists the selected project's workspaces on the plugin-facing app-data refresh", async () => {
    const app = createApp();
    stubBackgroundRefreshes(app);
    const refreshTopology = spyOnTopologyRefresh(app);
    const refreshSurface = replaceRefresh(app, "refreshCurrentWorkspaceSurface");

    await refreshAppData(app);

    expect(refreshTopology).toHaveBeenCalledOnce();
    expect(refreshSurface).toHaveBeenCalledOnce();
  });

  it("still re-lists workspaces when a sibling refresh in the same resume batch fails", async () => {
    const app = createApp();
    stubBackgroundRefreshes(app);
    failBackgroundRefresh(app, "refreshMachineStatusSnapshots", new Error("machine status unavailable"));
    const refreshTopology = spyOnTopologyRefresh(app);
    const refreshSessions = spyOnWorkspaceSessionsRefresh(app);

    await expect(browserResumeRefresh(app)()).rejects.toThrow("machine status unavailable");
    expect(refreshTopology).toHaveBeenCalledOnce();
    expect(refreshSessions).toHaveBeenCalledOnce();
  });
});

describe("PiWebApp realtime workspace invalidations", () => {
  it.each(["local", "machine-a"])("refreshes topology and session lifecycle for a matching project on %s, even while the agent is active", (machineId) => {
    const app = createApp();
    selectSessionForPolling(app, true);
    setAppState(app, { selectedMachine: machine(machineId), selectedProject: project });
    const refreshTopology = spyOnTopologyRefresh(app);
    const refreshSessions = spyOnWorkspaceSessionsRefresh(app);
    const sessions: unknown = Reflect.get(app, "sessions");
    if (!(sessions instanceof SessionController)) throw new Error("SessionController was unavailable");
    const applySessionEvent = vi.spyOn(sessions, "applyGlobalEvent");
    const [onEvent, , sourceMachineId] = captureRealtimeConnection(app);

    onEvent({ type: "workspaces.changed", projectId: project.id });

    expect(sourceMachineId).toBe(machineId);
    expect(refreshTopology).toHaveBeenCalledOnce();
    expect(refreshSessions).toHaveBeenCalledExactlyOnceWith(machineId, { recoverNetwork: true });
    expect(applySessionEvent).not.toHaveBeenCalled();
  });

  it.each([
    { label: "another machine with the same project id", source: "machine-b", projectId: project.id, selectedProject: project },
    { label: "another project on the selected machine", source: "machine-a", projectId: "project-2", selectedProject: project },
    { label: "no selected project", source: "machine-a", projectId: project.id, selectedProject: undefined },
  ])("ignores a notification for $label", ({ source, projectId, selectedProject }) => {
    const app = createApp();
    setAppState(app, { selectedMachine: machine("machine-a"), selectedProject });
    const refreshTopology = spyOnTopologyRefresh(app);
    const refreshSessions = spyOnWorkspaceSessionsRefresh(app);

    deliverRealtimeEvent(app, source, { type: "workspaces.changed", projectId });

    expect(refreshTopology).not.toHaveBeenCalled();
    expect(refreshSessions).not.toHaveBeenCalled();
  });

  it("coalesces a burst of notifications through the existing WorkspaceController", async () => {
    vi.useFakeTimers();
    const app = createApp();
    setAppState(app, { selectedMachine: machine("machine-a"), selectedProject: project });
    const loadWorkspaces = vi.spyOn(api, "workspaceResolution").mockResolvedValue({ projectId: project.id, status: "provider", ownerPluginId: "git", diagnostics: [], workspaces: [] });
    const [onEvent] = captureRealtimeConnection(app);

    onEvent({ type: "workspaces.changed", projectId: project.id });
    onEvent({ type: "workspaces.changed", projectId: project.id });
    onEvent({ type: "workspaces.changed", projectId: project.id });
    expect(loadWorkspaces).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();

    // Debouncing and trailing-pass semantics belong to workspaceController.test.ts;
    // this boundary only proves notifications use that same coalesced refresh path.
    expect(loadWorkspaces).toHaveBeenCalledExactlyOnceWith(project.id, "machine-a");
  });
});

describe("PiWebApp realtime topology and session-list recovery", () => {
  it("re-lists topology and workspace sessions on each socket open, including reconnects", () => {
    const app = createApp();
    selectSessionForPolling(app, true);
    setAppState(app, { selectedMachine: machine("machine-a"), selectedProject: project });
    const refreshSessions = spyOnWorkspaceSessionsRefresh(app);
    const refreshTopology = spyOnTopologyRefresh(app);
    stubRealtimeSiblingRefreshes(app);
    const [, onOpen] = captureRealtimeConnection(app);
    if (onOpen === undefined) throw new Error("Realtime onOpen callback was unavailable");

    onOpen();
    expect(refreshSessions).toHaveBeenCalledExactlyOnceWith("machine-a", { recoverNetwork: true });
    expect(refreshTopology).toHaveBeenCalledOnce();

    refreshSessions.mockClear();
    refreshTopology.mockClear();
    onOpen();
    expect(refreshSessions).toHaveBeenCalledExactlyOnceWith("machine-a", { recoverNetwork: true });
    expect(refreshTopology).toHaveBeenCalledOnce();
  });

  it("does not refresh the current topology from a previously selected machine's open callback", () => {
    const app = createApp();
    setAppState(app, { selectedMachine: machine("machine-a"), selectedProject: project });
    spyOnWorkspaceSessionsRefresh(app);
    const refreshTopology = spyOnTopologyRefresh(app);
    stubRealtimeSiblingRefreshes(app);
    const [onEvent, onOpen] = captureRealtimeConnection(app);
    if (onOpen === undefined) throw new Error("Realtime onOpen callback was unavailable");

    // Project ids can be identical on different machines.
    setAppState(app, { selectedMachine: machine("machine-b") });
    onOpen();
    onEvent({ type: "workspaces.changed", projectId: project.id });

    expect(refreshTopology).not.toHaveBeenCalled();
  });
});

function machine(id: string): NonNullable<AppState["selectedMachine"]> {
  return { id, name: id, kind: id === "local" ? "local" : "remote", createdAt: project.createdAt, updatedAt: project.createdAt };
}

function setAppState(app: PiWebApp, patch: Partial<AppState>): void {
  const state: unknown = Reflect.get(app, "state");
  if (typeof state !== "object" || state === null) throw new Error("PiWebApp state was unavailable");
  Reflect.set(app, "state", { ...state, ...patch });
}

function captureRealtimeConnection(app: PiWebApp) {
  const connect = vi.spyOn(RealtimeSocket.prototype, "connect").mockImplementation(() => undefined);
  const connectRealtime: unknown = Reflect.get(app, "connectRealtime");
  if (typeof connectRealtime !== "function") throw new Error("Realtime connection was unavailable");
  connectRealtime.call(app);
  const connection = connect.mock.calls[0];
  if (connection === undefined) throw new Error("Realtime callbacks were unavailable");
  return connection;
}

function deliverRealtimeEvent(app: PiWebApp, machineId: string, event: BrowserRealtimeEvent): void {
  const handle: unknown = Reflect.get(app, "handleRealtimeEvent");
  if (typeof handle !== "function") throw new Error("Realtime event handler was unavailable");
  handle.call(app, machineId, event);
}

function stubRealtimeSiblingRefreshes(app: PiWebApp): void {
  for (const name of ["sessionUnread", "serverNotices"]) {
    const controller: unknown = Reflect.get(app, name);
    if (typeof controller !== "object" || controller === null) throw new Error(`${name} was unavailable`);
    Reflect.set(controller, "refresh", vi.fn().mockResolvedValue(undefined));
  }
}

function spyOnWorkspaceSessionsRefresh(app: PiWebApp) {
  const controller: unknown = Reflect.get(app, "sessions");
  if (!(controller instanceof SessionController)) throw new Error("PiWebApp SessionController was unavailable");
  return vi.spyOn(controller, "refreshCurrentWorkspaceSessions").mockResolvedValue(undefined);
}

function createApp(): PiWebApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebApp();
}

function selectSessionForPolling(app: PiWebApp, isStreaming = false): void {
  const state: unknown = Reflect.get(app, "state");
  if (typeof state !== "object" || state === null) throw new Error("PiWebApp state was unavailable");
  Reflect.set(app, "state", {
    ...state,
    selectedSession: { id: "session-1", cwd: "/workspace", archived: false },
    status: { isStreaming, isCompacting: false, isBashRunning: false, pendingMessageCount: 0 },
  });
}

/**
 * Replaces the sibling refreshes that already have their own coverage so this test
 * observes only whether the resume/app-data paths include workspace topology.
 */
function stubBackgroundRefreshes(app: PiWebApp): void {
  vi.spyOn(navigationOrderPort, "load").mockResolvedValue({ ids: [], revision: 0 });
  const result = () => Promise.resolve();
  for (const name of [
    "refreshMachineStatusSnapshots",
    "refreshWorkspaceDeletionRuns",
    "loadClientConfig",
    "refreshCurrentWorkspaceSurface",
    "schedulePiWebStatusRefresh",
  ]) {
    if (!Reflect.set(app, name, result)) throw new Error(`Could not replace PiWebApp.${name}`);
  }
  const sessions: unknown = Reflect.get(app, "sessions");
  if (typeof sessions !== "object" || sessions === null || !Reflect.set(sessions, "refreshSelectedSession", result)) {
    throw new Error("Could not replace the selected-session refresh");
  }
}

function failBackgroundRefresh(app: PiWebApp, name: string, error: Error): void {
  if (!Reflect.set(app, name, () => Promise.reject(error))) throw new Error(`Could not fail PiWebApp.${name}`);
}

function replaceRefresh(app: PiWebApp, name: string) {
  const refresh = vi.fn<RefreshCallback>(() => Promise.resolve());
  if (!Reflect.set(app, name, refresh)) throw new Error(`Could not replace PiWebApp.${name}`);
  return refresh;
}

function spyOnTopologyRefresh(app: PiWebApp) {
  const controller: unknown = Reflect.get(app, "workspaces");
  if (!(controller instanceof WorkspaceController)) throw new Error("PiWebApp WorkspaceController was unavailable");
  return vi.spyOn(controller, "refreshSelectedProjectTopology").mockResolvedValue(undefined);
}

/** The exact callback `BrowserResumeController` invokes after a focus/visibility signal. */
function browserResumeRefresh(app: PiWebApp): RefreshCallback {
  const resume: unknown = Reflect.get(app, "browserResume");
  if (typeof resume !== "object" || resume === null) throw new Error("PiWebApp BrowserResumeController was unavailable");
  const callbacks: unknown = Reflect.get(resume, "callbacks");
  if (typeof callbacks !== "object" || callbacks === null) throw new Error("Browser resume callbacks were unavailable");
  const refresh: unknown = Reflect.get(callbacks, "refreshAfterResume");
  if (!isRefreshCallback(refresh)) throw new Error("The browser resume refresh callback was unavailable");
  return refresh;
}

async function refreshAppData(app: PiWebApp): Promise<void> {
  const refresh: unknown = Reflect.get(app, "refreshAppData");
  if (!isRefreshCallback(refresh)) throw new Error("PiWebApp.refreshAppData is not callable");
  await refresh.call(app);
}

function isRefreshCallback(value: unknown): value is RefreshCallback {
  return typeof value === "function";
}

function hasSelectedSessionRefresh(value: unknown): value is { refreshSelectedSession(): Promise<void> } {
  return typeof value === "object" && value !== null && "refreshSelectedSession" in value && typeof value.refreshSelectedSession === "function";
}
