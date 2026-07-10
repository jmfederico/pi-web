import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api as defaultApi, type MessagePage, type PromptAttachment, type SessionActivity, type SessionInfo, type SessionRef, type SessionStatus, type Workspace } from "../api";
import type { SessionUiEvent } from "../sessionSocket";
import { isCachedNewSessionInfo, loadCachedNewSessions, markCachedNewSessionInfo, rememberCachedNewSession } from "../cachedNewSessions";
import { initialAppState, type AppState } from "../appState";
import { ChatTranscriptStore } from "../chatTranscriptStore";
import { machineSessionKey } from "../machineKeys";
import { PI_WEB_CAPABILITIES } from "../../../shared/capabilities";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import { SessionController, type SessionEventSocket } from "./sessionController";
import { InMemorySessionSelectionMemory } from "./sessionSelection";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class FakeSocket implements SessionEventSocket {
  readonly connectedSessionIds: string[] = [];

  connect(session: SessionRef): void {
    this.connectedSessionIds.push(session.id);
  }

  setHandler(): void {
    // Test socket does not emit events.
  }

  close(): void {
    // No-op.
  }
}

class EmitSocket implements SessionEventSocket {
  readonly connectedSessionIds: string[] = [];
  private handler: ((event: SessionUiEvent) => void) | undefined;

  connect(session: SessionRef, onEvent: (event: SessionUiEvent) => void): void {
    this.connectedSessionIds.push(session.id);
    this.handler = onEvent;
  }

  setHandler(onEvent: (event: SessionUiEvent) => void): void {
    this.handler = onEvent;
  }

  emit(event: SessionUiEvent): void {
    this.handler?.(event);
  }

  close(): void {
    this.handler = undefined;
  }
}

const workspace: Workspace = {
  id: "workspace-1",
  projectId: "project-1",
  path: "/repo",
  label: "repo",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: false,
};

const oldSession: SessionInfo = {
  id: "old-session",
  path: "/tmp/old-session.jsonl",
  cwd: "/repo",
  created: "2026-05-15T00:00:00.000Z",
  modified: "2026-05-15T00:00:00.000Z",
  messageCount: 0,
  firstMessage: "",
};

const replacementSession: SessionInfo = {
  ...oldSession,
  id: "new-session",
  path: "/tmp/new-session.jsonl",
};

const emptyPage: MessagePage = { messages: [], start: 0, total: 0 };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolveDeferred: ((value: T) => void) | undefined;
  let rejectDeferred: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  if (resolveDeferred === undefined || rejectDeferred === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

function status(sessionId: string): SessionStatus {
  return {
    sessionId,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

const framesById = new Map<number, () => void>();
let nextFrameId = 1;

// The controller coalesces status/activity/transcript updates behind
// requestAnimationFrame. The node test environment has no rAF, so install a
// controllable one: callbacks are queued and only run when a test drives a
// frame, mirroring how the browser defers them until paint.
beforeEach(() => {
  framesById.clear();
  nextFrameId = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    const id = nextFrameId++;
    framesById.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { framesById.delete(id); });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function runPendingAnimationFrames(): void {
  const frames = Array.from(framesById.values());
  framesById.clear();
  for (const frame of frames) frame();
}

describe("SessionController", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
  });

  it("coalesces rapid status updates into a single state write per frame", () => {
    const setStateCalls: Partial<AppState>[] = [];
    let state: AppState = { ...initialAppState(), selectedSession: oldSession, sessions: [oldSession] };
    const controller = new SessionController(
      () => state,
      (patch) => { setStateCalls.push(patch); state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket: new FakeSocket() },
    );

    controller.applyGlobalEvent({ type: "status.update", status: { ...status(oldSession.id), isStreaming: true, messageCount: 1 } });
    controller.applyGlobalEvent({ type: "status.update", status: { ...status(oldSession.id), isStreaming: true, messageCount: 2 } });
    controller.applyGlobalEvent({ type: "status.update", status: { ...status(oldSession.id), isStreaming: true, messageCount: 3 } });

    // Nothing applies until the frame is flushed; last-write-wins per session.
    expect(setStateCalls).toHaveLength(0);
    expect(state.sessionStatuses[oldSession.id]).toBeUndefined();

    runPendingAnimationFrames();

    expect(setStateCalls).toHaveLength(1);
    expect(state.sessionStatuses[oldSession.id]).toMatchObject({ sessionId: oldSession.id, messageCount: 3 });
    expect(state.status?.messageCount).toBe(3);
  });

  it("applies the latest activity per session on flush", () => {
    const setStateCalls: Partial<AppState>[] = [];
    let state: AppState = { ...initialAppState(), selectedSession: oldSession, sessions: [oldSession] };
    const controller = new SessionController(
      () => state,
      (patch) => { setStateCalls.push(patch); state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket: new FakeSocket() },
    );

    controller.applyGlobalEvent({ type: "activity.update", activity: { sessionId: oldSession.id, phase: "active", label: "running tool", at: "t1" } });
    controller.applyGlobalEvent({ type: "activity.update", activity: { sessionId: oldSession.id, phase: "idle", label: "idle", at: "t2" } });

    expect(setStateCalls).toHaveLength(0);

    controller.flushPendingUpdates();

    expect(state.sessionActivities[oldSession.id]).toMatchObject({ phase: "idle", label: "idle" });
    expect(state.activity?.phase).toBe("idle");
  });

  it("coalesces status updates delivered over the per-session socket until the frame is flushed", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve(emptyPage),
      status: () => Promise.resolve(status(oldSession.id)),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );
    await controller.selectSession(oldSession, { updateUrl: false });

    socket.emit({ type: "status.update", status: { ...status(oldSession.id), isStreaming: true, messageCount: 7 } });
    socket.emit({ type: "status.update", status: { ...status(oldSession.id), isStreaming: true, messageCount: 8 } });

    // Buffered, not applied synchronously.
    expect(state.sessionStatuses[oldSession.id]?.messageCount).toBeUndefined();

    controller.flushPendingUpdates();

    expect(state.sessionStatuses[oldSession.id]?.messageCount).toBe(8);
    expect(state.status?.messageCount).toBe(8);
  });

  it("clears stale active activity when an idle status arrives", () => {
    const activeActivity: SessionActivity = { sessionId: oldSession.id, phase: "active", label: "running tool", at: "2026-05-15T00:00:00.000Z" };
    let state: AppState = {
      ...initialAppState(),
      selectedSession: oldSession,
      sessions: [oldSession],
      activity: activeActivity,
      sessionActivities: { [oldSession.id]: activeActivity },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket: new FakeSocket() },
    );

    controller.applyGlobalEvent({ type: "status.update", status: status(oldSession.id) });
    controller.flushPendingUpdates();

    expect(state.activity).toBeUndefined();
    expect(state.sessionActivities[oldSession.id]).toBeUndefined();
    expect(state.sessionStatuses[oldSession.id]).toMatchObject({ sessionId: oldSession.id, isStreaming: false });
  });

  it("updates visible session message counts from live status events", () => {
    let state: AppState = {
      ...initialAppState(),
      selectedSession: oldSession,
      sessions: [oldSession],
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket: new FakeSocket() },
    );

    controller.applyGlobalEvent({ type: "status.update", status: { ...status(oldSession.id), messageCount: 3 } });
    controller.flushPendingUpdates();

    expect(state.sessions[0]?.messageCount).toBe(3);
    expect(state.selectedSession?.messageCount).toBe(3);
  });

  it("adds a newly created session to the list when it belongs to the selected workspace", () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket: new FakeSocket() },
    );
    const spawned: SessionInfo = { ...oldSession, id: "spawned-session", path: "/tmp/spawned-session.jsonl" };

    controller.applyGlobalEvent({ type: "session.created", session: spawned });

    expect(state.sessions.map((session) => session.id)).toEqual(["spawned-session", "old-session"]);
  });

  it("ignores a created session for a different workspace or a duplicate id", () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket: new FakeSocket() },
    );

    controller.applyGlobalEvent({ type: "session.created", session: { ...oldSession, id: "other", cwd: "/other-repo" } });
    controller.applyGlobalEvent({ type: "session.created", session: { ...oldSession } });

    expect(state.sessions.map((session) => session.id)).toEqual(["old-session"]);
  });

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

    startRequest.resolve(started);
    await start;

    expect(loadDraft(sessionKey(temporaryId))).toBe("");
    expect(loadDraft(sessionKey(started.id))).toBe("draft text");
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
    expect(state.error).toContain("backend unavailable");

    await controller.deleteCachedNewSession(state.sessions[0]);

    expect(state.sessions).toEqual([]);
    expect(state.selectedSession).toBeUndefined();
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

  it("toggles the per-session sending state around an inline attachment send and forwards attachments", async () => {
    let resolvePrompt: (() => void) | undefined;
    let promptArgs: { attachments?: PromptAttachment[] } | undefined;
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const attachments: PromptAttachment[] = [{ kind: "image", mimeType: "image/png", data: "QUJD", name: "shot.png" }];
    const api: typeof defaultApi = {
      ...defaultApi,
      prompt: (_session, _text, _behavior, _machineId, sentAttachments) => new Promise<{ accepted: true }>((resolve) => {
        promptArgs = { ...(sentAttachments === undefined ? {} : { attachments: sentAttachments }) };
        resolvePrompt = () => { resolve({ accepted: true }); };
      }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const send = controller.send("look", undefined, attachments, "inline");
    const sendingDuringPrompt = state.sendingPrompts;
    resolvePrompt?.();
    await send;

    expect(sendingDuringPrompt).toEqual({ [oldSession.id]: true });
    expect(state.sendingPrompts).toEqual({});
    expect(promptArgs).toEqual({ attachments });
  });

  it("keeps the sending state scoped to the originating session when the user switches away", async () => {
    let resolvePrompt: (() => void) | undefined;
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession, replacementSession] };
    const attachments: PromptAttachment[] = [{ kind: "image", mimeType: "image/png", data: "QUJD", name: "shot.png" }];
    const api: typeof defaultApi = {
      ...defaultApi,
      prompt: () => new Promise<{ accepted: true }>((resolve) => { resolvePrompt = () => { resolve({ accepted: true }); }; }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const send = controller.send("look", undefined, attachments, "inline");
    // While the upload is in flight, deselecting must not clear the originating
    // session's sending entry, and it must stay keyed to that session only.
    controller.deselectSession();
    expect(state.sendingPrompts).toEqual({ [oldSession.id]: true });
    expect(state.sendingPrompts[replacementSession.id]).toBeUndefined();
    resolvePrompt?.();
    await send;
    expect(state.sendingPrompts).toEqual({});
  });

  it("uploads to the workspace folder and rewrites the prompt for folder delivery", async () => {
    let savedCalledWith: PromptAttachment[] | undefined;
    let promptText: string | undefined;
    let promptAttachments: PromptAttachment[] | undefined;
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const attachments: PromptAttachment[] = [{ kind: "image", mimeType: "image/png", data: "QUJD", name: "shot.png" }];
    const api: typeof defaultApi = {
      ...defaultApi,
      saveAttachments: (_session, sent) => { savedCalledWith = sent; return Promise.resolve([{ path: ".pi-web/attachments/shot.png", mimeType: "image/png", size: 3 }]); },
      prompt: (_session, text, _behavior, _machineId, sentAttachments) => { promptText = text; promptAttachments = sentAttachments; return Promise.resolve({ accepted: true }); },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.send("check this", undefined, attachments, "folder");

    expect(savedCalledWith).toEqual(attachments);
    expect(promptText).toBe("check this\n\n@.pi-web/attachments/shot.png");
    expect(promptAttachments).toBeUndefined();
    expect(state.sendingPrompts).toEqual({});
  });

  it("does not set the sending state for plain text messages", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const seen: Record<string, true>[] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      prompt: () => { seen.push({ ...state.sendingPrompts }); return Promise.resolve({ accepted: true }); },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.send("hello");
    expect(seen).toEqual([{}]);
    expect(state.sendingPrompts).toEqual({});
  });

  it("sends slash commands without inserting an optimistic transcript line and toggles the sending state", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    let resolveCommand: (() => void) | undefined;
    const seenDuringCommand: Record<string, true>[] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      runCommand: (_session, text) => new Promise((resolve) => {
        seenDuringCommand.push({ ...state.sendingPrompts });
        resolveCommand = () => { resolve(text.startsWith("/skill") ? { type: "done" } : { type: "done", message: "stats" }); };
      }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const run = controller.send("/skill:skill-creator");
    expect(seenDuringCommand).toEqual([{ [oldSession.id]: true }]);
    // No raw command text is added to the transcript; the agent streams the
    // canonical expanded message back instead.
    expect(state.messages).toEqual([]);
    resolveCommand?.();
    await run;
    expect(state.messages).toEqual([]);
    expect(state.sendingPrompts).toEqual({});
  });

  it("queues prompt sends for a pending session start and flushes them after resolution", async () => {
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    const promptCalls: { sessionId: string; text: string; behavior?: "steer" | "followUp" }[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
      prompt: (session, text, behavior) => {
        promptCalls.push({ sessionId: sessionLookupId(session), text, ...(behavior === undefined ? {} : { behavior }) });
        return Promise.resolve({ accepted: true });
      },
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

    await controller.send("first");
    await controller.send("second", "steer");

    expect(promptCalls).toEqual([]);
    expect(state.clientQueuedSessionMessages[temporaryId]).toEqual([
      { kind: "followUp", text: "first" },
      { kind: "steer", text: "second" },
    ]);
    expect(state.activity?.detail).toContain("2 queued messages");

    startRequest.resolve(started);
    await start;

    expect(promptCalls).toEqual([
      { sessionId: started.id, text: "first" },
      { sessionId: started.id, text: "second", behavior: "steer" },
    ]);
    expect(state.clientQueuedSessionMessages[temporaryId]).toBeUndefined();
    expect(state.clientQueuedSessionMessages[started.id]).toBeUndefined();
    expect(state.sendingPrompts).toEqual({});
    expect(state.selectedSession?.id).toBe(started.id);
  });

  it("queues slash commands, shell input, and attachments for a pending session start", async () => {
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    const calls: string[] = [];
    const promptCalls: { text: string; attachments?: PromptAttachment[] }[] = [];
    const attachments: PromptAttachment[] = [{ kind: "image", mimeType: "image/png", data: "QUJD", name: "shot.png" }];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
      runCommand: (session, text) => {
        calls.push(`command:${sessionLookupId(session)}:${text}`);
        return Promise.resolve({ type: "done" });
      },
      shell: (session, text) => {
        calls.push(`shell:${sessionLookupId(session)}:${text}`);
        return Promise.resolve({ accepted: true });
      },
      saveAttachments: (session, sentAttachments) => {
        calls.push(`save:${sessionLookupId(session)}:${sentAttachments[0]?.name ?? ""}`);
        return Promise.resolve([{ path: ".pi-web/attachments/shot.png", mimeType: "image/png", size: 3 }]);
      },
      prompt: (session, text, _behavior, _machineId, sentAttachments) => {
        calls.push(`prompt:${sessionLookupId(session)}:${text}`);
        promptCalls.push({ text, ...(sentAttachments === undefined ? {} : { attachments: sentAttachments }) });
        return Promise.resolve({ accepted: true });
      },
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

    await controller.send("/help");
    await controller.send("!pwd");
    await controller.send("look", undefined, attachments, "inline");
    await controller.send("save", undefined, attachments, "folder");

    expect(calls).toEqual([]);
    expect(state.clientQueuedSessionMessages[temporaryId]).toEqual([
      { kind: "followUp", text: "/help" },
      { kind: "followUp", text: "!pwd" },
      { kind: "followUp", text: "look\n\n[1 attachment queued: shot.png]" },
      { kind: "followUp", text: "save\n\n[1 attachment queued: shot.png]" },
    ]);

    startRequest.resolve(started);
    await start;

    expect(calls).toEqual([
      `command:${started.id}:/help`,
      `shell:${started.id}:!pwd`,
      `prompt:${started.id}:look`,
      `save:${started.id}:shot.png`,
      `prompt:${started.id}:save\n\n@.pi-web/attachments/shot.png`,
    ]);
    expect(promptCalls).toEqual([
      { text: "look", attachments },
      { text: "save\n\n@.pi-web/attachments/shot.png" },
    ]);
    expect(state.clientQueuedSessionMessages[started.id]).toBeUndefined();
  });

  it("keeps queued sends visible when backend session creation fails", async () => {
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
    if (temporaryId === undefined) throw new Error("Expected temporary session id");
    await controller.send("recover me");

    startRequest.reject(new Error("backend unavailable"));
    await start;

    expect(state.selectedSession?.id).toBe(temporaryId);
    expect(state.clientQueuedSessionMessages[temporaryId]).toEqual([{ kind: "followUp", text: "recover me" }]);
    expect(state.activity).toMatchObject({ sessionId: temporaryId, phase: "error", label: "Session creation failed" });
    expect(state.activity?.detail).toContain("1 queued message kept below");

    await controller.deleteCachedNewSession(state.selectedSession);

    expect(state.clientQueuedSessionMessages[temporaryId]).toBeUndefined();
    expect(state.selectedSession).toBeUndefined();
  });

  it("keeps queued sends scoped to their originating pending start", async () => {
    const firstStarted: SessionInfo = { ...oldSession, id: "started-session-1", path: "/tmp/started-session-1.jsonl" };
    const secondStarted: SessionInfo = { ...oldSession, id: "started-session-2", path: "/tmp/started-session-2.jsonl" };
    const startRequests: Deferred<SessionInfo>[] = [];
    const promptCalls: { sessionId: string; text: string }[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => {
        const request = deferred<SessionInfo>();
        startRequests.push(request);
        return request.promise;
      },
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
      prompt: (session, text) => {
        promptCalls.push({ sessionId: sessionLookupId(session), text });
        return Promise.resolve({ accepted: true });
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const firstStart = controller.startSession();
    const firstTemporary = state.selectedSession;
    if (firstTemporary === undefined) throw new Error("Expected first temporary session");
    const secondStart = controller.startSession();
    const secondTemporary = state.selectedSession;
    if (secondTemporary === undefined) throw new Error("Expected second temporary session");

    await controller.send("second prompt");
    await controller.selectSession(firstTemporary, { updateUrl: false });
    await controller.send("first prompt");

    startRequests[1]?.resolve(secondStarted);
    await secondStart;

    expect(promptCalls).toEqual([{ sessionId: secondStarted.id, text: "second prompt" }]);
    expect(state.selectedSession?.id).toBe(firstTemporary.id);
    expect(state.clientQueuedSessionMessages[secondStarted.id]).toBeUndefined();
    expect(state.clientQueuedSessionMessages[firstTemporary.id]).toEqual([{ kind: "followUp", text: "first prompt" }]);

    startRequests[0]?.resolve(firstStarted);
    await firstStart;

    expect(promptCalls).toEqual([
      { sessionId: secondStarted.id, text: "second prompt" },
      { sessionId: firstStarted.id, text: "first prompt" },
    ]);
    expect(state.selectedSession?.id).toBe(firstStarted.id);
    expect(state.clientQueuedSessionMessages[firstStarted.id]).toBeUndefined();
  });

  it("keeps live message count updates when a cached new session becomes persisted", async () => {
    const cachedSession = markCachedNewSessionInfo(oldSession);
    let resolvePrompt: (() => void) | undefined;
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: cachedSession, sessions: [cachedSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      prompt: () => new Promise<{ accepted: true }>((resolve) => { resolvePrompt = () => { resolve({ accepted: true }); }; }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const send = controller.send("hello");
    controller.applyGlobalEvent({ type: "status.update", status: { ...status(oldSession.id), messageCount: 1 } });
    controller.flushPendingUpdates();
    resolvePrompt?.();
    await send;

    expect(state.sessions[0]?.messageCount).toBe(1);
    expect(isCachedNewSessionInfo(state.sessions[0])).toBe(false);
    expect(state.selectedSession?.messageCount).toBe(1);
  });

  it("deletes transient server-reported new sessions and clears local state", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    const transientSession = { ...oldSession, persisted: false };
    const nextSession = { ...oldSession, id: "next-session", path: "/tmp/next-session.jsonl", persisted: true };
    const stoppedIds: string[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: transientSession,
      sessions: [transientSession, nextSession],
      sessionStatuses: { [transientSession.id]: { ...status(transientSession.id), persisted: false } },
      sessionActivities: { [transientSession.id]: { sessionId: transientSession.id, phase: "active", label: "Starting", at: "2026-05-20T00:00:00.000Z" } },
      sendingPrompts: { [transientSession.id]: true },
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      stop: (session) => { stoppedIds.push(sessionLookupId(session)); return Promise.resolve({ stopped: true }); },
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
    saveDraft(sessionKey(transientSession.id), "discard me");

    await controller.deleteCachedNewSession(transientSession);

    expect(stoppedIds).toEqual([transientSession.id]);
    expect(state.sessions.map((session) => session.id)).toEqual([nextSession.id]);
    expect(state.sessionStatuses[transientSession.id]).toBeUndefined();
    expect(state.sessionActivities[transientSession.id]).toBeUndefined();
    expect(state.sendingPrompts[transientSession.id]).toBeUndefined();
    expect(loadDraft(sessionKey(transientSession.id))).toBe("");
    expect(state.selectedSession?.id).toBe(nextSession.id);
  });

  it("recreates missing browser-cached new sessions and moves their draft", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    rememberCachedNewSession(oldSession);
    saveDraft(sessionKey(oldSession.id), "draft text");

    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [markCachedNewSessionInfo(oldSession)] };
    const urlUpdates: ({ replace?: boolean | undefined } | undefined)[] = [];
    const socket = new FakeSocket();
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => Promise.resolve(replacementSession),
      messages: (session) => {
        if (sessionLookupId(session) === oldSession.id) return Promise.reject(new Error("Session not found"));
        return Promise.resolve(emptyPage);
      },
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      (options) => { urlUpdates.push(options); },
      undefined,
      { api, socket },
    );

    await controller.selectSession(markCachedNewSessionInfo(oldSession), { updateUrl: false });

    expect(state.selectedSession?.id).toBe(replacementSession.id);
    expect(state.sessions.map((session) => session.id)).toEqual([replacementSession.id]);
    expect(socket.connectedSessionIds).toEqual([oldSession.id, replacementSession.id]);
    expect(loadDraft(sessionKey(oldSession.id))).toBe("");
    expect(loadDraft(sessionKey(replacementSession.id))).toBe("draft text");
    expect(loadCachedNewSessions().map((session) => session.id)).toEqual([replacementSession.id]);
    expect(urlUpdates).toEqual([{ replace: true }]);
  });

  it("stores command prompt drafts for replacement sessions before selecting them", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
      commandDialog: { type: "select", requestId: "r1", title: "Fork from message", options: [{ value: "m1", label: "fork me" }] },
    };
    const urlUpdates: unknown[] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      respondToCommand: () => Promise.resolve({ type: "done", message: "Session forked", session: replacementSession, promptDraft: "fork me" }),
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      (options) => { urlUpdates.push(options); },
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.respondToCommand("r1", "m1");

    expect(state.commandDialog).toBeUndefined();
    expect(loadDraft(sessionKey(replacementSession.id))).toBe("fork me");
  });

  it("forgets the selected active session when archiving leaves only archived sessions", async () => {
    const persistedSession = { ...oldSession, persisted: true };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [persistedSession] };
    const urlUpdates: ({ replace?: boolean | undefined } | undefined)[] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      archive: () => Promise.resolve({ archived: true }),
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      (options) => { urlUpdates.push(options); },
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.selectSession(persistedSession, { updateUrl: false });
    await controller.archiveSession();

    expect(state.selectedSession).toBeUndefined();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({ ...oldSession, archived: true });
    expect(typeof state.sessions[0]?.archivedAt).toBe("string");
    expect(controller.preferredSession(workspace.path, state.sessions, undefined)).toBeUndefined();
    expect(urlUpdates).toEqual([undefined]);
  });

  it("archives legacy sessions when persistence support is not advertised", async () => {
    const legacySession = { ...oldSession };
    const archivedIds: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: legacySession, sessions: [legacySession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      archive: (session) => {
        archivedIds.push(sessionLookupId(session));
        return Promise.resolve({ archived: true });
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.archiveSession(legacySession);

    expect(archivedIds).toEqual([legacySession.id]);
    expect(state.sessions[0]).toMatchObject({ id: legacySession.id, archived: true });
  });

  it("archives selected session descendants and selects the next active session", async () => {
    const persistedSession = { ...oldSession, persisted: true };
    const childSession = { ...oldSession, id: "child-session", path: "/tmp/child-session.jsonl", parentSessionPath: persistedSession.path, persisted: true };
    const nextSession = { ...oldSession, id: "next-session", path: "/tmp/next-session.jsonl", persisted: true };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [persistedSession, childSession, nextSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      archiveWithDescendants: () => Promise.resolve({ archived: true, sessionIds: [persistedSession.id, childSession.id], archivedCount: 2, skippedAlreadyArchivedCount: 0 }),
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.selectSession(persistedSession, { updateUrl: false });
    await controller.archiveSessionWithDescendants(persistedSession);

    expect(state.sessions.find((session) => session.id === oldSession.id)).toMatchObject({ archived: true });
    expect(state.sessions.find((session) => session.id === childSession.id)).toMatchObject({ archived: true });
    expect(state.selectedSession?.id).toBe(nextSession.id);
  });

  it("archives selected sessions in bulk", async () => {
    const persistedSession = { ...oldSession, persisted: true };
    const secondSession = { ...oldSession, id: "second-session", path: "/tmp/second-session.jsonl", persisted: true };
    const nextSession = { ...oldSession, id: "next-session", path: "/tmp/next-session.jsonl", persisted: true };
    const archivedIds: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [persistedSession, secondSession, nextSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      archive: (session) => {
        archivedIds.push(sessionLookupId(session));
        return Promise.resolve({ archived: true });
      },
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.selectSession(persistedSession, { updateUrl: false });
    await controller.archiveSessions([persistedSession, secondSession]);

    expect(archivedIds).toEqual([oldSession.id, secondSession.id]);
    expect(state.sessions.find((session) => session.id === oldSession.id)).toMatchObject({ archived: true });
    expect(state.sessions.find((session) => session.id === secondSession.id)).toMatchObject({ archived: true });
    expect(state.selectedSession?.id).toBe(nextSession.id);
  });

  it("uses true bulk archive when the selected runtime supports it and applies partial failures", async () => {
    const persistedSession = { ...oldSession, persisted: true };
    const failedSession = { ...oldSession, id: "failed-session", path: "/tmp/failed-session.jsonl", persisted: true };
    const archiveCalls: { ids: string[]; machineId: string }[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      sessions: [persistedSession, failedSession],
      machineRuntimes: { local: { machineId: "local", ok: true, checkedAt: "now", capabilities: [PI_WEB_CAPABILITIES.sessionsBulkMutations] } },
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      archiveMany: (sessions, machineId) => {
        archiveCalls.push({ ids: sessions.map(sessionLookupId), machineId: machineId ?? "local" });
        return Promise.resolve({ archived: true, archivedSessionIds: [persistedSession.id], failures: [{ sessionId: failedSession.id, error: "busy" }], generatedAt: "now" });
      },
      archive: () => { throw new Error("single archive should not be used"); },
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.selectSession(persistedSession, { updateUrl: false });
    await controller.archiveSessions([persistedSession, failedSession]);

    expect(archiveCalls).toEqual([{ ids: [oldSession.id, failedSession.id], machineId: "local" }]);
    expect(state.sessions.find((session) => session.id === oldSession.id)).toMatchObject({ archived: true });
    expect(state.sessions.find((session) => session.id === failedSession.id)?.archived).toBeUndefined();
    expect(state.selectedSession?.id).toBe(failedSession.id);
    expect(state.error).toBe("Archive failed for 1 session: failed-session: busy");
  });

  it("throttles per-session archive fallback when bulk mutations are unsupported", async () => {
    const sessions = Array.from({ length: 6 }, (_value, index) => ({ ...oldSession, id: `session-${String(index)}`, path: `/tmp/session-${String(index)}.jsonl`, persisted: true }));
    const resolvers: (() => void)[] = [];
    const startedIds: string[] = [];
    let activeCount = 0;
    let maxActiveCount = 0;
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions };
    const api: typeof defaultApi = {
      ...defaultApi,
      archive: (session) => new Promise((resolve) => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        startedIds.push(sessionLookupId(session));
        resolvers.push(() => {
          activeCount -= 1;
          resolve({ archived: true });
        });
      }),
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    const archive = controller.archiveSessions(sessions);
    await Promise.resolve();

    expect(startedIds).toHaveLength(4);
    resolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(startedIds).toHaveLength(5);
    for (const resolve of resolvers.splice(0)) resolve();
    await Promise.resolve();
    await Promise.resolve();
    for (const resolve of resolvers.splice(0)) resolve();
    await archive;

    expect(maxActiveCount).toBe(4);
    expect(state.sessions.every((session) => session.archived === true)).toBe(true);
  });

  it("deletes selected archived sessions in bulk and selects the next current session", async () => {
    const archivedSession = { ...oldSession, archived: true, archivedAt: "later" };
    const nextSession = { ...oldSession, id: "next-session", path: "/tmp/next-session.jsonl" };
    const deletedIds: string[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: archivedSession,
      sessions: [archivedSession, nextSession],
      machineRuntimes: { local: { machineId: "local", ok: true, checkedAt: "now", capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived] } },
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      deleteArchived: (session) => {
        deletedIds.push(sessionLookupId(session));
        return Promise.resolve({ deleted: true });
      },
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.deleteArchivedSessions([archivedSession]);

    expect(deletedIds).toEqual([archivedSession.id]);
    expect(state.sessions.map((session) => session.id)).toEqual([nextSession.id]);
    expect(state.selectedSession?.id).toBe(nextSession.id);
  });

  it("uses true bulk delete when supported and keeps partial failures visible", async () => {
    const deletedSession = { ...oldSession, archived: true, archivedAt: "later" };
    const failedSession = { ...oldSession, id: "failed-archived", path: "/tmp/failed-archived.jsonl", archived: true, archivedAt: "later" };
    const deleteCalls: { ids: string[]; machineId: string }[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: deletedSession,
      sessions: [deletedSession, failedSession],
      machineRuntimes: { local: { machineId: "local", ok: true, checkedAt: "now", capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived, PI_WEB_CAPABILITIES.sessionsBulkMutations] } },
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      deleteArchivedMany: (sessions, machineId) => {
        deleteCalls.push({ ids: sessions.map(sessionLookupId), machineId: machineId ?? "local" });
        return Promise.resolve({ deleted: true, deletedSessionIds: [deletedSession.id], failures: [{ sessionId: failedSession.id, error: "busy" }], generatedAt: "now" });
      },
      deleteArchived: () => { throw new Error("single delete should not be used"); },
      messages: () => Promise.resolve(emptyPage),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.deleteArchivedSessions([deletedSession, failedSession]);

    expect(deleteCalls).toEqual([{ ids: [deletedSession.id, failedSession.id], machineId: "local" }]);
    expect(state.sessions.map((session) => session.id)).toEqual([failedSession.id]);
    expect(state.selectedSession?.id).toBe(failedSession.id);
    expect(state.error).toBe("Delete failed for 1 session: failed-archived: busy");
  });

  it("applies cleanup execution results and refreshes the current workspace sessions", async () => {
    const archivedAt = "2026-06-25T12:00:00.000Z";
    const deletedArchived = { ...oldSession, id: "deleted-archived", path: "/tmp/deleted-archived.jsonl", archived: true, archivedAt: "2026-05-01T00:00:00.000Z" };
    const nextSession = { ...oldSession, id: "next-session", path: "/tmp/next-session.jsonl" };
    const refreshedArchived = { ...oldSession, archived: true, archivedAt };
    const sessionsCalls: { cwd: string; machineId: string }[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession, deletedArchived, nextSession],
      sessionStatuses: { [oldSession.id]: status(oldSession.id), [deletedArchived.id]: status(deletedArchived.id), [nextSession.id]: status(nextSession.id) },
      sessionActivities: { [oldSession.id]: { sessionId: oldSession.id, phase: "idle", label: "idle", at: archivedAt } },
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      sessions: (cwd, machineId) => {
        sessionsCalls.push({ cwd, machineId: machineId ?? "local" });
        return Promise.resolve([refreshedArchived, nextSession]);
      },
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.applySessionCleanupResult({
      generatedAt: archivedAt,
      thresholds: { archiveIdleDays: 30, deleteArchivedDays: 60 },
      projects: [{ cwd: workspace.path, archiveCount: 1, deleteCount: 1 }],
      totals: { archiveCount: 1, deleteCount: 1 },
      archivedSessionIds: [oldSession.id],
      deletedSessionIds: [deletedArchived.id],
    });

    expect(sessionsCalls).toEqual([{ cwd: workspace.path, machineId: "local" }]);
    expect(state.sessions.map((session) => session.id)).toEqual([oldSession.id, nextSession.id]);
    expect(state.sessions[0]).toMatchObject({ id: oldSession.id, archived: true, archivedAt });
    expect(state.selectedSession?.id).toBe(nextSession.id);
    expect(state.sessionStatuses[oldSession.id]).toBeUndefined();
    expect(state.sessionStatuses[deletedArchived.id]).toBeUndefined();
    expect(state.sessionActivities[oldSession.id]).toBeUndefined();
  });

  it("does not delete archived sessions when the selected machine runtime reports no support", async () => {
    const archivedSession = { ...oldSession, archived: true, archivedAt: "later" };
    const deletedIds: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [archivedSession], machineRuntimes: { local: { machineId: "local", ok: true, checkedAt: "now", capabilities: [] } } };
    const api: typeof defaultApi = {
      ...defaultApi,
      deleteArchived: (session) => {
        deletedIds.push(sessionLookupId(session));
        return Promise.resolve({ deleted: true });
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.deleteArchivedSessions([archivedSession]);

    expect(deletedIds).toEqual([]);
    expect(state.sessions).toEqual([archivedSession]);
    expect(state.error).toContain("requires an updated Pi-Web runtime");
  });

  it("allows legacy archived-session deletion when runtime support is unknown", async () => {
    const archivedSession = { ...oldSession, archived: true, archivedAt: "later" };
    const deletedIds: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: archivedSession, sessions: [archivedSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      deleteArchived: (session) => {
        deletedIds.push(sessionLookupId(session));
        return Promise.resolve({ deleted: true });
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.deleteArchivedSessions([archivedSession]);

    expect(deletedIds).toEqual([archivedSession.id]);
    expect(state.sessions).toEqual([]);
    expect(state.error).toBe("");
  });

  it("reloads the selected session from disk, discards the cached transcript, and re-fetches history", async () => {
    const persistedSession = { ...oldSession, persisted: true };
    const cacheKey = sessionKey(oldSession.id);
    const freshPage: MessagePage = { messages: [{ role: "assistant", content: "fresh from disk" }], start: 1, total: 2 };
    const cachedPages = new Map<string, MessagePage>([[cacheKey, { messages: [{ role: "user", content: "stale cached transcript" }], start: 0, total: 2 }]]);
    const reloadCalls: string[] = [];
    const messageCalls: string[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: persistedSession,
      sessions: [persistedSession],
      machineRuntimes: { local: { machineId: "local", ok: true, checkedAt: "now", capabilities: [PI_WEB_CAPABILITIES.sessionsReload] } },
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      reloadSession: (session) => {
        reloadCalls.push(sessionLookupId(session));
        return Promise.resolve({ reloaded: true });
      },
      messages: (session) => {
        messageCalls.push(sessionLookupId(session));
        return Promise.resolve(freshPage);
      },
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      {
        api,
        socket: new FakeSocket(),
        transcripts: new ChatTranscriptStore({
          read: (sessionId) => cachedPages.get(sessionId),
          write: (sessionId, page) => { cachedPages.set(sessionId, page); },
          remove: (sessionId) => { cachedPages.delete(sessionId); },
        }),
      },
    );

    await controller.reloadSession(persistedSession);

    expect(reloadCalls).toEqual([oldSession.id]);
    expect(messageCalls).toEqual([oldSession.id]);
    expect(cachedPages.get(cacheKey)).toEqual(freshPage);
    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "fresh from disk" }] }]);
    expect(state.messagePageStart).toBe(1);
    expect(state.error).toBe("");
  });

  it("does not reload sessions from disk when the selected machine runtime does not support it", async () => {
    const persistedSession = { ...oldSession, persisted: true };
    const reloadCalls: string[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: persistedSession,
      sessions: [persistedSession],
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      reloadSession: (session) => {
        reloadCalls.push(sessionLookupId(session));
        return Promise.resolve({ reloaded: true });
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.reloadSession(persistedSession);

    expect(reloadCalls).toEqual([]);
    expect(state.error).toContain("Reloading sessions from disk requires an updated Pi-Web runtime");
  });

  it("does not reload sessions from disk without a persisted server signal when persistence is authoritative", async () => {
    const reloadCalls: string[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
      machineRuntimes: { local: { machineId: "local", ok: true, checkedAt: "now", capabilities: [PI_WEB_CAPABILITIES.sessionsReload, PI_WEB_CAPABILITIES.sessionsPersistedState] } },
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      reloadSession: (session) => {
        reloadCalls.push(sessionLookupId(session));
        return Promise.resolve({ reloaded: true });
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.reloadSession(oldSession);
    await controller.reloadSession({ ...oldSession, persisted: false });

    expect(reloadCalls).toEqual([]);
    expect(state.error).toBe("");
  });

  it("forgets archived selections when the archived section collapse clears selection", async () => {
    const archivedSession = { ...oldSession, archived: true, archivedAt: "later" };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [archivedSession] };
    const urlUpdates: ({ replace?: boolean | undefined } | undefined)[] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve(emptyPage),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      (options) => { urlUpdates.push(options); },
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.selectSession(archivedSession, { updateUrl: false });
    expect(controller.preferredSession(workspace.path, state.sessions, undefined)).toBe(archivedSession);

    controller.clearSelectionAfterArchivedCollapse();

    expect(state.selectedSession).toBeUndefined();
    expect(controller.preferredSession(workspace.path, state.sessions, undefined)).toBeUndefined();
    expect(urlUpdates).toEqual([undefined]);
  });
});

function sessionKey(sessionId: string): string {
  return machineSessionKey("local", sessionId);
}

function sessionLookupId(session: string | SessionRef): string {
  return typeof session === "string" ? session : session.id;
}
