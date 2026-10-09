import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkRequestError, HttpRequestError } from "../api/http";
import { initialAppState } from "../appState";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import { BrowserErrorReporter, sessionBrowserErrorScope, workspaceBrowserErrorScope } from "../browserErrors";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, EmitSocket, emptyPage, FakeSocket, MemoryStorage, oldSession, replacementSession, sessionKey, status, transcriptSnapshotFixture, workspace, type AppState, type SessionInfo } from "./sessionController.testSupport";

const sessionScope = sessionBrowserErrorScope("local", oldSession.id, { cwd: oldSession.cwd, projectId: workspace.projectId, workspaceId: workspace.id });
const workspaceScope = workspaceBrowserErrorScope("local", workspace.projectId, workspace.id);
const networkFailure = () => new NetworkRequestError("Load failed", { cause: new TypeError("Load failed") });

function setup(overrides: Partial<typeof defaultApi> = {}) {
  let state: AppState = {
    ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession],
    messages: [{ role: "assistant", parts: [{ type: "text", text: "cached conversation" }] }],
  };
  const snapshot = vi.fn<typeof defaultApi.transcriptSnapshot>(() => transcriptSnapshotFixture(emptyPage, status(oldSession.id)));
  const sessions = vi.fn<typeof defaultApi.sessions>(() => Promise.resolve([oldSession]));
  const api = { ...defaultApi, transcriptSnapshot: snapshot, sessions, thinkingLevels: () => Promise.resolve({ levels: [] }), ...overrides };
  const setState = (patch: Partial<AppState>) => { state = { ...state, ...patch }; };
  const socket = new FakeSocket();
  const controller = new SessionController(() => state, setState, () => undefined, undefined, { api, socket });
  return { controller, snapshot, sessions, socket, getState: () => state, setState, errors: new BrowserErrorReporter(() => state, setState) };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("silent session read recovery", () => {
  it("retains the current conversation without a banner while a resume fetch recovers", async () => {
    const h = setup();
    h.snapshot.mockRejectedValueOnce(networkFailure());
    const messages = h.getState().messages;
    const refresh = h.controller.refreshSelectedSession(undefined, { recoverNetwork: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(h.snapshot).toHaveBeenCalledOnce();
    expect(h.getState().browserErrors).toEqual({});
    expect(h.getState().messages).toBe(messages);
    expect(h.getState().selectedSession).toBe(oldSession);

    await vi.advanceTimersByTimeAsync(500);
    await refresh;
    expect(h.snapshot).toHaveBeenCalledTimes(2);
    expect(h.getState().browserErrors).toEqual({});
  });

  it("offers an actionable error only after bounded recovery, and clears it on a successful poll", async () => {
    const h = setup();
    h.snapshot.mockRejectedValue(networkFailure());
    const refresh = h.controller.refreshSelectedSession(undefined, { recoverNetwork: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.getState().browserErrors).toEqual({});
    await vi.advanceTimersByTimeAsync(3000);
    await refresh;

    expect(h.snapshot).toHaveBeenCalledTimes(4);
    expect(Object.values(h.getState().browserErrors)).toEqual([{
      scope: sessionScope,
      message: "The conversation could not be refreshed. Check your connection and retry.",
      recovery: "session-refresh",
    }]);
    h.snapshot.mockImplementation(() => transcriptSnapshotFixture(emptyPage, status(oldSession.id)));
    await h.controller.refreshSelectedSession(undefined, { silent: true });
    expect(h.getState().browserErrors).toEqual({});
  });

  it("does not retry or hide HTTP failures", async () => {
    const h = setup();
    h.snapshot.mockRejectedValue(new HttpRequestError("Session not found", 404));
    await h.controller.refreshSelectedSession(undefined, { recoverNetwork: true });
    expect(h.snapshot).toHaveBeenCalledOnce();
    expect(Object.values(h.getState().browserErrors)).toEqual([{ scope: sessionScope, message: "HttpRequestError: Session not found" }]);
  });

  it("clears a confirmed missing selection without switching conversations or deleting its draft", async () => {
    const listed = vi.fn<typeof defaultApi.sessions>().mockResolvedValue([replacementSession]);
    const h = setup({ sessions: listed });
    const close = vi.spyOn(h.socket, "close");
    vi.stubGlobal("localStorage", new MemoryStorage());
    saveDraft(sessionKey(oldSession.id), "keep my unsent prompt");
    h.snapshot.mockRejectedValue(new HttpRequestError("Session not found", 404));
    await h.controller.refreshSelectedSession();
    expect(listed).toHaveBeenCalledExactlyOnceWith(workspace.path, "local");
    expect(h.getState().selectedSession).toBeUndefined();
    expect(h.getState().sessions).toEqual([replacementSession]);
    expect(Object.values(h.getState().browserErrors)).toEqual([{ scope: workspaceScope, message: "The selected session no longer exists. Choose another session from the list." }]);
    expect(close).toHaveBeenCalledOnce();
    expect(loadDraft(sessionKey(oldSession.id))).toBe("keep my unsent prompt");
  });

  it("does not clear a newer selection while confirming a missing session", async () => {
    const list = deferred<SessionInfo[]>();
    const h = setup({ sessions: () => list.promise });
    h.snapshot.mockRejectedValue(new HttpRequestError("Session not found", 404));
    const refresh = h.controller.refreshSelectedSession(undefined, { recoverNetwork: true });
    await vi.advanceTimersByTimeAsync(0);
    h.setState({ selectedSession: replacementSession });
    list.resolve([replacementSession]);
    await refresh;
    expect(h.getState().selectedSession).toBe(replacementSession);
    expect(h.getState().browserErrors).toEqual({});
  });

  it("keeps the original error and selection when the confirming list is unavailable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = setup({ sessions: () => Promise.reject(networkFailure()) });
    h.snapshot.mockRejectedValue(new HttpRequestError("Session not found", 404));
    await h.controller.refreshSelectedSession();
    expect(h.getState().selectedSession).toBe(oldSession);
    expect(Object.values(h.getState().browserErrors)).toEqual([{ scope: sessionScope, message: "HttpRequestError: Session not found" }]);
    expect(warning).toHaveBeenCalledOnce();
  });

  it("stops recovery when the selected session changes", async () => {
    const h = setup();
    h.snapshot.mockRejectedValue(networkFailure());
    const refresh = h.controller.refreshSelectedSession(undefined, { recoverNetwork: true });
    await vi.advanceTimersByTimeAsync(0);
    h.setState({ selectedSession: replacementSession });
    await vi.runAllTimersAsync();
    await refresh;
    expect(h.snapshot).toHaveBeenCalledOnce();
    expect(h.getState().selectedSession).toBe(replacementSession);
    expect(h.getState().browserErrors).toEqual({});
  });

  it("preserves an action failure reported while an older conversation read succeeds", async () => {
    const gate = deferred<Awaited<ReturnType<typeof defaultApi.transcriptSnapshot>>>();
    const h = setup({ transcriptSnapshot: () => gate.promise });
    h.errors.report(sessionScope, "old refresh failure", "session-refresh");
    const refresh = h.controller.refreshSelectedSession();
    await vi.advanceTimersByTimeAsync(0);
    h.errors.report(sessionScope, "Prompt delivery could not be confirmed");
    gate.resolve(await transcriptSnapshotFixture(emptyPage, status(oldSession.id)));
    await refresh;
    expect(Object.values(h.getState().browserErrors)).toEqual([{ scope: sessionScope, message: "Prompt delivery could not be confirmed" }]);
  });

  it("clears a retained conversation refresh error after an archived conversation loads", async () => {
    const h = setup({ messages: () => Promise.resolve(emptyPage) });
    h.errors.report(sessionScope, "Conversation refresh failed", "session-refresh");
    await h.controller.selectSession({ ...oldSession, archived: true }, { updateUrl: false });
    expect(h.getState().selectedSession?.archived).toBe(true);
    expect(h.getState().browserErrors).toEqual({});
  });

  it("never retries a failed prompt or clears its error when a background read succeeds", async () => {
    const failure = networkFailure();
    const prompt = vi.fn<typeof defaultApi.prompt>().mockRejectedValue(failure);
    const h = setup({ prompt });

    expect(await h.controller.send("hello")).toBe(false);
    await h.controller.refreshSelectedSession(undefined, { recoverNetwork: true });
    await vi.runAllTimersAsync();

    expect(prompt).toHaveBeenCalledOnce();
    expect(Object.values(h.getState().browserErrors)).toEqual([{ scope: sessionScope, message: String(failure) }]);
  });

  it("uses silent network recovery on a session socket reconnect", async () => {
    const h = setup();
    const socket = new EmitSocket();
    const controller = new SessionController(h.getState, h.setState, () => undefined, undefined, {
      api: { ...defaultApi, transcriptSnapshot: h.snapshot, thinkingLevels: () => Promise.resolve({ levels: [] }) }, socket,
    });
    await controller.selectSession(oldSession, { updateUrl: false });
    h.snapshot.mockRejectedValueOnce(networkFailure());
    socket.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.getState().browserErrors).toEqual({});
    await vi.advanceTimersByTimeAsync(500);
    expect(h.snapshot).toHaveBeenCalledTimes(3);
    expect(h.getState().browserErrors).toEqual({});
    controller.dispose();
  });
});

describe("workspace session-list recovery", () => {
  it("retries transient session-list failures without disturbing the selection", async () => {
    const h = setup();
    h.sessions.mockRejectedValueOnce(networkFailure());
    const refresh = h.controller.refreshCurrentWorkspaceSessions("local", { recoverNetwork: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.getState().browserErrors).toEqual({});
    expect(h.getState().selectedSession).toBe(oldSession);
    await vi.advanceTimersByTimeAsync(500);
    await refresh;
    expect(h.sessions).toHaveBeenCalledTimes(2);
    expect(h.getState().browserErrors).toEqual({});
  });

  it("clears only a recovered session-list error, not an unrelated workspace failure", async () => {
    const h = setup();
    h.sessions.mockRejectedValue(networkFailure());
    const refresh = h.controller.refreshCurrentWorkspaceSessions("local", { recoverNetwork: true });
    await vi.runAllTimersAsync();
    await refresh;
    expect(Object.values(h.getState().browserErrors)).toEqual([{
      scope: workspaceScope,
      message: "The session list could not be refreshed. Check your connection and retry.",
      recovery: "workspace-sessions-refresh",
    }]);
    h.sessions.mockResolvedValue([oldSession]);
    await h.controller.refreshCurrentWorkspaceSessions();
    expect(h.getState().browserErrors).toEqual({});
    h.errors.report(workspaceScope, "Workspace removal failed");
    await h.controller.refreshCurrentWorkspaceSessions();
    expect(Object.values(h.getState().browserErrors)).toEqual([{ scope: workspaceScope, message: "Workspace removal failed" }]);
  });

  it("coalesces overlapping list refreshes so a late failure cannot follow successful recovery", async () => {
    const first = deferred<SessionInfo[]>();
    const h = setup();
    h.sessions.mockImplementationOnce(() => first.promise);
    const refresh = h.controller.refreshCurrentWorkspaceSessions();
    const sameTurn = h.controller.refreshCurrentWorkspaceSessions();
    await vi.advanceTimersByTimeAsync(0);
    const trailing = h.controller.refreshCurrentWorkspaceSessions();
    expect(h.sessions).toHaveBeenCalledOnce();
    first.reject(networkFailure());
    await Promise.all([refresh, sameTurn, trailing]);
    expect(h.sessions).toHaveBeenCalledTimes(2);
    expect(h.getState().browserErrors).toEqual({});
  });

  it.each(["select", "deselect"])("continues workspace-list recovery when users %s a conversation in the same workspace", async (action) => {
    const h = setup();
    h.snapshot.mockImplementation((session) => transcriptSnapshotFixture(emptyPage, status(session.id)));
    h.sessions.mockRejectedValueOnce(networkFailure()).mockResolvedValue([oldSession, replacementSession]);
    const refresh = h.controller.refreshCurrentWorkspaceSessions("local", { recoverNetwork: true });
    await vi.advanceTimersByTimeAsync(0);
    if (action === "select") await h.controller.selectSession(replacementSession, { updateUrl: false });
    else h.controller.deselectSession({ updateUrl: false });

    await vi.advanceTimersByTimeAsync(500);
    await refresh;

    expect(h.sessions).toHaveBeenCalledTimes(2);
    expect(h.getState().sessions).toEqual([oldSession, replacementSession]);
    expect(h.getState().selectedSession?.id).toBe(action === "select" ? replacementSession.id : undefined);
    expect(h.getState().browserErrors).toEqual({});
  });

  it.each(["select", "deselect"])("applies an in-flight session list when users %s within the same workspace", async (action) => {
    const pending = deferred<SessionInfo[]>();
    const h = setup();
    h.snapshot.mockImplementation((session) => transcriptSnapshotFixture(emptyPage, status(session.id)));
    h.sessions.mockReturnValueOnce(pending.promise);
    const refresh = h.controller.refreshCurrentWorkspaceSessions();
    await vi.advanceTimersByTimeAsync(0);
    if (action === "select") await h.controller.selectSession(replacementSession, { updateUrl: false });
    else h.controller.deselectSession({ updateUrl: false });
    const refreshed = [{ ...oldSession, name: "Refreshed list" }, replacementSession];
    pending.resolve(refreshed);
    await refresh;

    expect(h.getState().sessions).toEqual(refreshed);
    expect(h.getState().selectedSession?.id).toBe(action === "select" ? replacementSession.id : undefined);
  });

  it("does not retry a retired workspace or emit its network banner", async () => {
    const h = setup();
    h.sessions.mockRejectedValue(networkFailure());
    const refresh = h.controller.refreshCurrentWorkspaceSessions("local", { recoverNetwork: true });
    await vi.advanceTimersByTimeAsync(0);
    h.setState({ selectedWorkspace: { ...workspace, id: "another-workspace" } });
    await vi.runAllTimersAsync();
    await refresh;
    expect(h.sessions).toHaveBeenCalledOnce();
    expect(h.getState().browserErrors).toEqual({});
  });

  it("stops session-list retries when the controller is disposed", async () => {
    const h = setup();
    h.sessions.mockRejectedValue(networkFailure());
    const refresh = h.controller.refreshCurrentWorkspaceSessions("local", { recoverNetwork: true });
    await vi.advanceTimersByTimeAsync(0);
    h.controller.dispose();
    await vi.runAllTimersAsync();
    await refresh;
    expect(h.sessions).toHaveBeenCalledOnce();
    expect(h.getState().browserErrors).toEqual({});
  });
});
