import { describe, expect, it } from "vitest";
import { PI_WEB_CAPABILITIES } from "../../../shared/capabilities";
import { initialAppState } from "../appState";
import { ChatTranscriptStore } from "../chatTranscriptStore";
import { SessionController } from "./sessionController";
import { InMemorySessionSelectionMemory } from "./sessionSelection";
import { defaultApi, emptyPage, FakeSocket, oldSession, sessionKey, sessionLookupId, status, workspace, type AppState, type MessagePage } from "./sessionController.testSupport";

describe("SessionController reload and selection", () => {
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
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
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
