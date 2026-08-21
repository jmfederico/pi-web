import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { isCachedNewSessionInfo, loadCachedNewSessions, markCachedNewSessionInfo, rememberCachedNewSession } from "../cachedNewSessions";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import { clearStagedAttachments, loadStagedAttachments, saveStagedAttachments, type PendingAttachment } from "../promptAttachmentStaging";
import { SessionController } from "./sessionController";
import { defaultApi, emptyPage, FakeSocket, MemoryStorage, oldSession, replacementSession, sessionKey, sessionLookupId, status, workspace, type AppState } from "./sessionController.testSupport";

describe("SessionController cached-new sessions", () => {
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
    const discardedAttachment: PendingAttachment = { id: "attachment-1", kind: "file", name: "notes.txt", mimeType: "text/plain", data: "aGVsbG8=", size: 5 };
    saveStagedAttachments(sessionKey(transientSession.id), [discardedAttachment]);

    await controller.deleteCachedNewSession(transientSession);

    expect(stoppedIds).toEqual([transientSession.id]);
    expect(state.sessions.map((session) => session.id)).toEqual([nextSession.id]);
    expect(state.sessionStatuses[transientSession.id]).toBeUndefined();
    expect(state.sessionActivities[transientSession.id]).toBeUndefined();
    expect(state.sendingPrompts[transientSession.id]).toBeUndefined();
    expect(loadDraft(sessionKey(transientSession.id))).toBe("");
    expect(loadStagedAttachments(sessionKey(transientSession.id))).toEqual([]);
    expect(state.selectedSession?.id).toBe(nextSession.id);
  });

  it("recreates missing browser-cached new sessions and moves their draft", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    rememberCachedNewSession(oldSession);
    saveDraft(sessionKey(oldSession.id), "draft text");
    const carriedAttachment: PendingAttachment = { id: "attachment-1", kind: "file", name: "notes.txt", mimeType: "text/plain", data: "aGVsbG8=", size: 5 };
    saveStagedAttachments(sessionKey(oldSession.id), [carriedAttachment]);

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
    expect(loadStagedAttachments(sessionKey(oldSession.id))).toEqual([]);
    expect(loadStagedAttachments(sessionKey(replacementSession.id))).toEqual([carriedAttachment]);
    expect(loadCachedNewSessions().map((session) => session.id)).toEqual([replacementSession.id]);
    expect(urlUpdates).toEqual([{ replace: true }]);

    // `oldSession`/`replacementSession` are shared fixture ids reused by other
    // tests in this file; the staged-attachment store is an in-memory module
    // singleton (unlike localStorage-backed drafts, which each test resets by
    // swapping in a fresh MemoryStorage), so clear explicitly to avoid leaking
    // this attachment into a later test that reuses the same id.
    clearStagedAttachments(sessionKey(replacementSession.id));
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
});
