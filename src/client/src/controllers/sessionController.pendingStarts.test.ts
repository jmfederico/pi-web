import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { browserErrorScopeKey, visibleBrowserErrors, workspaceBrowserErrorScope } from "../browserErrors";
import { isCachedNewSessionInfo, loadCachedNewSessions } from "../cachedNewSessions";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import { loadStagedAttachments, saveStagedAttachments, type PendingAttachment } from "../promptAttachmentStaging";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, emptyPage, FakeSocket, MemoryStorage, oldSession, sessionKey, sessionLookupId, status, workspace, type AppState, type SessionInfo } from "./sessionController.testSupport";

describe("SessionController pending starts", () => {
  it("creates and selects a temporary editable session before backend start resolves", async () => {
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    const messageCalls: string[] = [];
    const statusCalls: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      messages: (session) => { messageCalls.push(sessionLookupId(session)); return Promise.resolve(emptyPage); },
      status: (session) => { statusCalls.push(sessionLookupId(session)); return Promise.resolve(status(sessionLookupId(session))); },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const start = controller.startSession();
    const temporarySession = state.selectedSession;

    expect(temporarySession?.id).toMatch(/^pending-session-/);
    expect(temporarySession?.persisted).toBe(false);
    expect(state.sessions.map((session) => session.id)).toEqual([temporarySession?.id]);
    expect(state.activity).toMatchObject({ sessionId: temporarySession?.id, phase: "active", label: "Creating session" });
    expect(messageCalls).toEqual([]);
    expect(statusCalls).toEqual([]);

    startRequest.resolve(started);
    await start;

    expect(state.sessions.map((session) => session.id)).toEqual(["started-session"]);
    expect(state.selectedSession?.id).toBe("started-session");
    expect(messageCalls).toEqual(["started-session"]);
    expect(statusCalls).toEqual(["started-session"]);
  });

  it("does not duplicate a started session when its session.created broadcast races the HTTP response", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const socket = new FakeSocket();
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => {
        // Simulate the broadcast arriving before the HTTP response resolves.
        controller.applyGlobalEvent({ type: "session.created", session: started });
        return startRequest.promise;
      },
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );

    const start = controller.startSession();
    const temporaryId = state.selectedSession?.id;

    expect(state.sessions.map((session) => session.id)).toEqual([temporaryId]);

    startRequest.resolve(started);
    await start;

    expect(state.sessions.map((session) => session.id)).toEqual(["started-session"]);
    expect(isCachedNewSessionInfo(state.sessions[0])).toBe(true);
  });

  it("releases unrelated created-session broadcasts after pending starts settle", async () => {
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const otherClientSession: SessionInfo = { ...oldSession, id: "other-client-session", path: "/tmp/other-client-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const start = controller.startSession();
    const temporaryId = state.selectedSession?.id;
    controller.applyGlobalEvent({ type: "session.created", session: started });
    controller.applyGlobalEvent({ type: "session.created", session: otherClientSession });

    expect(state.sessions.map((session) => session.id)).toEqual([temporaryId]);

    startRequest.resolve(started);
    await start;

    const sessionIds = state.sessions.map((session) => session.id);
    expect(sessionIds).not.toContain(temporaryId);
    expect(sessionIds.filter((id) => id === started.id)).toHaveLength(1);
    expect(sessionIds.filter((id) => id === otherClientSession.id)).toHaveLength(1);
  });

  it("preserves temporary start rows across session-list refreshes before backend resolution", async () => {
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      sessions: () => Promise.resolve([oldSession]),
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const start = controller.startSession();
    const temporaryId = state.selectedSession?.id;
    await controller.refreshCurrentWorkspaceSessions();

    expect(state.sessions.map((session) => session.id)).toEqual([temporaryId, oldSession.id]);
    expect(state.selectedSession?.id).toBe(temporaryId);

    startRequest.resolve(started);
    await start;

    expect(state.sessions.map((session) => session.id)).toEqual([started.id, oldSession.id]);
    expect(state.selectedSession?.id).toBe(started.id);
  });

  it("tracks multiple pending session starts without blocking another start", async () => {
    const firstStarted: SessionInfo = { ...oldSession, id: "started-session-1", path: "/tmp/started-session-1.jsonl" };
    const secondStarted: SessionInfo = { ...oldSession, id: "started-session-2", path: "/tmp/started-session-2.jsonl" };
    const startResolvers: ((session: SessionInfo) => void)[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => new Promise<SessionInfo>((resolve) => { startResolvers.push(resolve); }),
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const firstStart = controller.startSession();
    const firstTemporaryId = state.selectedSession?.id;
    const secondStart = controller.startSession();
    const secondTemporaryId = state.selectedSession?.id;

    expect(startResolvers).toHaveLength(2);
    expect(state.startingSessionCount).toBe(0);
    expect(state.sessions.map((session) => session.id)).toEqual([secondTemporaryId, firstTemporaryId]);
    expect(state.selectedSession?.id).toBe(secondTemporaryId);
    expect(state.sessions.every((session) => session.persisted === false)).toBe(true);

    startResolvers[0]?.(firstStarted);
    await firstStart;

    expect(state.sessions.map((session) => session.id)).toEqual([secondTemporaryId, "started-session-1"]);
    expect(state.selectedSession?.id).toBe(secondTemporaryId);

    startResolvers[1]?.(secondStarted);
    await secondStart;

    expect(state.startingSessionCount).toBe(0);
    expect(state.sessions.map((session) => session.id)).toEqual(["started-session-2", "started-session-1"]);
    expect(state.selectedSession?.id).toBe("started-session-2");
  });

  it("moves a temporary session draft and cached-new marker to the resolved session", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const start = controller.startSession();
    const temporaryId = state.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");
    saveDraft(sessionKey(temporaryId), "draft text");
    const attachment: PendingAttachment = { id: "attachment-1", kind: "file", name: "notes.txt", mimeType: "text/plain", data: "aGVsbG8=", size: 5 };
    saveStagedAttachments(sessionKey(temporaryId), [attachment]);

    startRequest.resolve(started);
    await start;

    expect(loadDraft(sessionKey(temporaryId))).toBe("");
    expect(loadDraft(sessionKey(started.id))).toBe("draft text");
    expect(loadStagedAttachments(sessionKey(temporaryId))).toEqual([]);
    expect(loadStagedAttachments(sessionKey(started.id))).toEqual([attachment]);
    expect(loadCachedNewSessions().map((session) => session.id)).toEqual([started.id]);
    expect(isCachedNewSessionInfo(state.sessions[0])).toBe(true);
  });

  it("keeps a failed temporary start selected with a discardable transient row", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => Promise.reject(new Error("backend unavailable")),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.startSession();
    const temporaryId = state.selectedSession?.id;

    expect(temporaryId).toMatch(/^pending-session-/);
    expect(state.sessions.map((session) => session.id)).toEqual([temporaryId]);
    expect(state.sessions[0]?.persisted).toBe(false);
    expect(state.activity).toMatchObject({ sessionId: temporaryId, phase: "error", label: "Session creation failed" });
    expect(Object.values(state.browserErrors).map((error) => error.message).join("\n")).toContain("backend unavailable");

    await controller.deleteCachedNewSession(state.sessions[0]);

    expect(state.sessions).toEqual([]);
    expect(state.selectedSession).toBeUndefined();
  });

  it("retains a late pending-start failure under its originating workspace", async () => {
    const otherWorkspace = { ...workspace, id: "workspace-2", projectId: "project-2", path: "/other-repo", label: "other-repo" };
    const startRequest = deferred<SessionInfo>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const start = controller.startSession();
    const temporaryId = state.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected a temporary session id");

    // Workspace navigation resets the visible session list while the create is
    // still pending. The rejection must remain attributable to workspace-1.
    state = { ...state, selectedWorkspace: otherWorkspace, sessions: [], selectedSession: undefined };
    startRequest.reject(new Error("late backend failure"));
    await start;

    const originScope = workspaceBrowserErrorScope("local", workspace.projectId, workspace.id);
    expect(state.browserErrors[browserErrorScopeKey(originScope)]?.message).toBe("Failed to start session: late backend failure");
    expect(visibleBrowserErrors(state.browserErrors, {
      machineId: "local",
      projectId: otherWorkspace.projectId,
      workspaceId: otherWorkspace.id,
    })).toEqual([]);
    expect(visibleBrowserErrors(state.browserErrors, {
      machineId: "local",
      projectId: workspace.projectId,
      workspaceId: workspace.id,
    })).toEqual([{ scope: originScope, message: "Failed to start session: late backend failure" }]);
    expect(state.sessions).toEqual([]);
    expect(temporaryId).toMatch(/^pending-session-/);
  });

  it("stops the backend session if a discarded pending start resolves later", async () => {
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    const stoppedIds: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      stop: (session) => { stoppedIds.push(sessionLookupId(session)); return Promise.resolve({ stopped: true }); },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const start = controller.startSession();
    const temporaryId = state.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");
    await controller.send("queued before discard");
    expect(state.clientQueuedSessionMessages[temporaryId]).toEqual([{ kind: "followUp", text: "queued before discard" }]);

    await controller.deleteCachedNewSession(state.selectedSession);
    expect(state.sessions).toEqual([]);
    expect(state.selectedSession).toBeUndefined();
    expect(state.clientQueuedSessionMessages[temporaryId]).toBeUndefined();

    startRequest.resolve(started);
    await start;

    expect(stoppedIds).toEqual([started.id]);
    expect(state.sessions).toEqual([]);
    expect(state.selectedSession).toBeUndefined();
  });
});
