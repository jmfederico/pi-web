import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api as defaultApi, type MessagePage, type PromptAttachment, type SessionActivity, type SessionInfo, type SessionRef, type SessionStatus, type Workspace } from "../api";
import type { SessionUiEvent } from "../sessionSocket";
import { isCachedNewSessionInfo, loadCachedNewSessions, markCachedNewSessionInfo, rememberCachedNewSession } from "../cachedNewSessions";
import { initialAppState, type AppState } from "../appState";
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

  it("does not duplicate a started session when its session.created broadcast races the HTTP response", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const socket = new FakeSocket();
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => {
        // Simulate the broadcast arriving before the HTTP response resolves.
        controller.applyGlobalEvent({ type: "session.created", session: started });
        return Promise.resolve(started);
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

    await controller.startSession();

    expect(state.sessions.map((session) => session.id)).toEqual(["started-session"]);
    expect(isCachedNewSessionInfo(state.sessions[0])).toBe(true);
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
    const secondStart = controller.startSession();

    expect(startResolvers).toHaveLength(2);
    expect(state.startingSessionCount).toBe(2);
    expect(state.sessions).toEqual([]);

    startResolvers[0]?.(firstStarted);
    await firstStart;

    expect(state.startingSessionCount).toBe(1);
    expect(state.sessions.map((session) => session.id)).toEqual(["started-session-1"]);

    startResolvers[1]?.(secondStarted);
    await secondStart;

    expect(state.startingSessionCount).toBe(0);
    expect(state.sessions.map((session) => session.id)).toEqual(["started-session-2", "started-session-1"]);
    expect(state.selectedSession?.id).toBe("started-session-2");
  });

  it("removes a resolved session start from the pending count when inserting its row", async () => {
    const firstStarted: SessionInfo = { ...oldSession, id: "started-session-1", path: "/tmp/started-session-1.jsonl" };
    const secondStarted: SessionInfo = { ...oldSession, id: "started-session-2", path: "/tmp/started-session-2.jsonl" };
    const startResolvers: ((session: SessionInfo) => void)[] = [];
    const messageRequests = new Map<string, Deferred<MessagePage>>();
    const statusRequests = new Map<string, Deferred<SessionStatus>>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => new Promise<SessionInfo>((resolve) => { startResolvers.push(resolve); }),
      messages: (session) => {
        const request = deferred<MessagePage>();
        messageRequests.set(sessionLookupId(session), request);
        return request.promise;
      },
      status: (session) => {
        const request = deferred<SessionStatus>();
        statusRequests.set(sessionLookupId(session), request);
        return request.promise;
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
    const secondStart = controller.startSession();
    expect(startResolvers).toHaveLength(2);
    expect(state.startingSessionCount).toBe(2);

    startResolvers[0]?.(firstStarted);
    await Promise.resolve();
    await Promise.resolve();

    expect(state.sessions.map((session) => session.id)).toEqual(["started-session-1"]);
    expect(state.startingSessionCount).toBe(1);

    messageRequests.get(firstStarted.id)?.resolve(emptyPage);
    statusRequests.get(firstStarted.id)?.resolve(status(firstStarted.id));
    await firstStart;

    startResolvers[1]?.(secondStarted);
    await Promise.resolve();
    await Promise.resolve();

    expect(state.sessions.map((session) => session.id)).toEqual(["started-session-2", "started-session-1"]);
    expect(state.startingSessionCount).toBe(0);

    messageRequests.get(secondStarted.id)?.resolve(emptyPage);
    statusRequests.get(secondStarted.id)?.resolve(status(secondStarted.id));
    await secondStart;
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
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
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

    await controller.selectSession(oldSession, { updateUrl: false });
    await controller.archiveSession();

    expect(state.selectedSession).toBeUndefined();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({ ...oldSession, archived: true });
    expect(typeof state.sessions[0]?.archivedAt).toBe("string");
    expect(controller.preferredSession(workspace.path, state.sessions, undefined)).toBeUndefined();
    expect(urlUpdates).toEqual([undefined]);
  });

  it("archives selected session descendants and selects the next active session", async () => {
    const childSession = { ...oldSession, id: "child-session", path: "/tmp/child-session.jsonl", parentSessionPath: oldSession.path };
    const nextSession = { ...oldSession, id: "next-session", path: "/tmp/next-session.jsonl" };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession, childSession, nextSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      archiveWithDescendants: () => Promise.resolve({ archived: true, sessionIds: [oldSession.id, childSession.id], archivedCount: 2, skippedAlreadyArchivedCount: 0 }),
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

    await controller.selectSession(oldSession, { updateUrl: false });
    await controller.archiveSessionWithDescendants(oldSession);

    expect(state.sessions.find((session) => session.id === oldSession.id)).toMatchObject({ archived: true });
    expect(state.sessions.find((session) => session.id === childSession.id)).toMatchObject({ archived: true });
    expect(state.selectedSession?.id).toBe(nextSession.id);
  });

  it("archives selected sessions in bulk", async () => {
    const secondSession = { ...oldSession, id: "second-session", path: "/tmp/second-session.jsonl" };
    const nextSession = { ...oldSession, id: "next-session", path: "/tmp/next-session.jsonl" };
    const archivedIds: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession, secondSession, nextSession] };
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

    await controller.selectSession(oldSession, { updateUrl: false });
    await controller.archiveSessions([oldSession, secondSession]);

    expect(archivedIds).toEqual([oldSession.id, secondSession.id]);
    expect(state.sessions.find((session) => session.id === oldSession.id)).toMatchObject({ archived: true });
    expect(state.sessions.find((session) => session.id === secondSession.id)).toMatchObject({ archived: true });
    expect(state.selectedSession?.id).toBe(nextSession.id);
  });

  it("uses true bulk archive when the selected runtime supports it and applies partial failures", async () => {
    const failedSession = { ...oldSession, id: "failed-session", path: "/tmp/failed-session.jsonl" };
    const archiveCalls: { ids: string[]; machineId: string }[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      sessions: [oldSession, failedSession],
      machineRuntimes: { local: { machineId: "local", ok: true, checkedAt: "now", capabilities: [PI_WEB_CAPABILITIES.sessionsBulkMutations] } },
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      archiveMany: (sessions, machineId) => {
        archiveCalls.push({ ids: sessions.map(sessionLookupId), machineId: machineId ?? "local" });
        return Promise.resolve({ archived: true, archivedSessionIds: [oldSession.id], failures: [{ sessionId: failedSession.id, error: "busy" }], generatedAt: "now" });
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

    await controller.selectSession(oldSession, { updateUrl: false });
    await controller.archiveSessions([oldSession, failedSession]);

    expect(archiveCalls).toEqual([{ ids: [oldSession.id, failedSession.id], machineId: "local" }]);
    expect(state.sessions.find((session) => session.id === oldSession.id)).toMatchObject({ archived: true });
    expect(state.sessions.find((session) => session.id === failedSession.id)?.archived).toBeUndefined();
    expect(state.selectedSession?.id).toBe(failedSession.id);
    expect(state.error).toBe("Archive failed for 1 session: failed-session: busy");
  });

  it("throttles per-session archive fallback when bulk mutations are unsupported", async () => {
    const sessions = Array.from({ length: 6 }, (_value, index) => ({ ...oldSession, id: `session-${String(index)}`, path: `/tmp/session-${String(index)}.jsonl` }));
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

  it("does not delete archived sessions when the selected machine runtime does not support it", async () => {
    const archivedSession = { ...oldSession, archived: true, archivedAt: "later" };
    const deletedIds: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [archivedSession] };
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

  it("reloads the selected session from disk, discards the cached transcript, and re-fetches history", async () => {
    Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
    const reloadCalls: string[] = [];
    const messageCalls: string[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
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
        return Promise.resolve(emptyPage);
      },
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.reloadSession(oldSession);

    expect(reloadCalls).toEqual([oldSession.id]);
    expect(messageCalls).toContain(oldSession.id);
    expect(state.error).toBe("");
  });

  it("does not reload sessions from disk when the selected machine runtime does not support it", async () => {
    const reloadCalls: string[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
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

    expect(reloadCalls).toEqual([]);
    expect(state.error).toContain("Reloading sessions from disk requires an updated Pi-Web runtime");
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
