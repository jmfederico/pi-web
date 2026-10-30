import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../api";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { InMemorySessionSelectionMemory } from "./sessionSelection";
import { emptyTranscriptApi as defaultApi, deferred, emptyPage, FakeSocket, oldSession, sessionLookupId, status, workspace, type AppState } from "./sessionController.testSupport";

describe("SessionController archive and cleanup", () => {
  it.each([false, true])("uses only visible workspace fallbacks when a remembered session is missing (visible: %s)", (hasVisible) => {
    const hidden = { ...oldSession, id: "hidden", path: "/tmp/hidden.jsonl" };
    const visible = { ...oldSession, id: "visible", path: "/tmp/visible.jsonl" };
    const sessions = [hidden, ...(hasVisible ? [visible] : [])];
    const memory = new InMemorySessionSelectionMemory();
    const state = { ...initialAppState(), selectedWorkspace: workspace, sessions };
    const controller = new SessionController(
      () => state,
      () => undefined,
      () => undefined,
      memory,
      { socket: new FakeSocket(), automaticSessionCandidates: (candidates) => candidates.filter((session) => session.id === visible.id) },
    );

    // No remembered destination and a stale remembered destination share the
    // visibility-aware fallback, including the no-visible-sessions case.
    expect(controller.preferredSession(workspace.path, sessions, undefined)?.id).toBe(hasVisible ? visible.id : undefined);
    memory.rememberSession({ ...oldSession, id: "missing", cwd: `local:${workspace.path}` });
    expect(controller.preferredSession(workspace.path, sessions, undefined)?.id).toBe(hasVisible ? visible.id : undefined);

    expect(controller.preferredSession(workspace.path, sessions, hidden.id)).toBe(hidden);
    expect(controller.preferredSession(workspace.path, sessions, "missing")).toBeUndefined();
    memory.rememberSession({ ...hidden, cwd: `local:${workspace.path}` });
    expect(controller.preferredSession(workspace.path, sessions, undefined)).toBe(hidden);
    controller.dispose();
  });

  describe.each([false, true])("visible replacement available: %s", (hasVisibleReplacement) => {
    it.each(["archive", "archive-tree", "archive-many", "delete", "refresh"] as const)("%s skips hidden fallback sessions", async (action) => {
      const selected = { ...oldSession, persisted: true, ...(action === "delete" ? { archived: true } : {}) };
      const hidden = { ...oldSession, id: "hidden", path: "/tmp/hidden.jsonl" };
      const visible = { ...oldSession, id: "visible", path: "/tmp/visible.jsonl" };
      const remaining = [hidden, ...(hasVisibleReplacement ? [visible] : [])];
      let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: selected, sessions: [selected, ...remaining] };
      const controller = new SessionController(
        () => state,
        (patch) => { state = { ...state, ...patch }; },
        () => undefined,
        undefined,
        {
          socket: new FakeSocket(),
          automaticSessionCandidates: (sessions) => sessions.filter((session) => session.id === visible.id),
          api: {
            ...defaultApi,
            archive: () => Promise.resolve({ archived: true }),
            archiveWithDescendants: () => Promise.resolve({ archived: true, sessionIds: [selected.id], archivedCount: 1, skippedAlreadyArchivedCount: 0 }),
            archiveMany: () => Promise.resolve({ archived: true, archivedSessionIds: [selected.id], failures: [], generatedAt: "now" }),
            deleteArchivedMany: () => Promise.resolve({ deleted: true, deletedSessionIds: [selected.id], failures: [], generatedAt: "now" }),
            sessions: () => Promise.resolve(remaining),
            status: (session) => Promise.resolve(status(sessionLookupId(session))),
          },
        },
      );

      if (action === "archive") await controller.archiveSession();
      else if (action === "archive-tree") await controller.archiveSessionWithDescendants();
      else if (action === "archive-many") await controller.archiveSessions([selected]);
      else if (action === "delete") await controller.deleteArchivedSessions([selected]);
      else await controller.refreshCurrentWorkspaceSessions();

      expect(state.selectedSession?.id).toBe(hasVisibleReplacement ? visible.id : undefined);
      // Explicit URL/plugin targets may still select a hidden row.
      expect(controller.preferredSession(workspace.path, remaining, hidden.id)).toBe(hidden);
      controller.dispose();
    });
  });

  it.each([false, true])("retires the live binding after externally archiving the selected session (replacement: %s)", async (hasReplacement) => {
    const selected = { ...oldSession, persisted: true };
    const archived = { ...selected, archived: true };
    const replacement = { ...oldSession, id: "replacement", path: "/tmp/replacement.jsonl", persisted: true };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [selected] };
    const socket = new FakeSocket();
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, {
      socket, api: { ...defaultApi,
        sessions: () => Promise.resolve([archived, ...(hasReplacement ? [replacement] : [])]),
        status: (session) => Promise.resolve(status(sessionLookupId(session))),
      },
    });
    await controller.selectSession(selected, { updateUrl: false });
    const close = vi.spyOn(socket, "close");
    await controller.refreshCurrentWorkspaceSessions();
    expect(close).toHaveBeenCalled();
    expect(state.selectedSession?.id).toBe(hasReplacement ? replacement.id : undefined);
    expect(state.sessions[0]?.archived).toBe(true);
    controller.dispose();
  });

  it("rejoins the live binding after an externally restored selected archive", async () => {
    const restored = { ...oldSession, persisted: true };
    const archived = { ...restored, archived: true };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [archived] };
    const socket = new FakeSocket();
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, {
      socket, api: { ...defaultApi,
        sessions: () => Promise.resolve([restored]),
        status: (session) => Promise.resolve(status(sessionLookupId(session))),
      },
    });
    await controller.selectSession(archived, { updateUrl: false });
    expect(socket.connectedSessionIds).toEqual([]);
    await controller.refreshCurrentWorkspaceSessions();
    expect(state.selectedSession).toEqual(restored);
    expect(socket.connectedSessionIds).toEqual([restored.id]);
    controller.dispose();
  });

  it("clears agent subsession classification when detaching from its parent", async () => {
    const child = { ...oldSession, parentSessionPath: "/tmp/parent.jsonl", agentSubsession: true };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: child, sessions: [child] };
    const api: typeof defaultApi = {
      ...defaultApi,
      detachParent: () => Promise.resolve({ detached: true }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.detachParent();

    expect(state.sessions[0]).not.toHaveProperty("parentSessionPath");
    expect(state.sessions[0]).not.toHaveProperty("agentSubsession");
    expect(state.selectedSession).not.toHaveProperty("agentSubsession");
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

  it("publishes an archive fallback before route reconciliation selects it", async () => {
    const persistedSession = { ...oldSession, persisted: true };
    const nextSession = { ...oldSession, id: "next-session", path: "/tmp/next-session.jsonl", persisted: true };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: persistedSession, sessions: [persistedSession, nextSession] };
    let selectedAtNavigation: string | undefined;
    let navigatedSession: string | undefined;
    const navigateToSession = (session: SessionInfo | undefined): Promise<boolean> => {
      selectedAtNavigation = state.selectedSession?.id;
      navigatedSession = session?.id;
      state = { ...state, selectedSession: session };
      return Promise.resolve(true);
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      archive: () => Promise.resolve({ archived: true }),
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket(), navigateToSession },
    );

    await controller.archiveSession();

    expect(selectedAtNavigation).toBe(persistedSession.id);
    expect(navigatedSession).toBe(nextSession.id);
    expect(state.selectedSession?.id).toBe(nextSession.id);
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
    const archiveCalls: { ids: string[]; machineId: string }[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [persistedSession, secondSession, nextSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      archiveMany: (sessions, machineId) => {
        archiveCalls.push({ ids: sessions.map(sessionLookupId), machineId: machineId ?? "local" });
        return Promise.resolve({ archived: true, archivedSessionIds: sessions.map(sessionLookupId), failures: [], generatedAt: "now" });
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
    await controller.archiveSessions([persistedSession, secondSession]);

    expect(archiveCalls).toEqual([{ ids: [oldSession.id, secondSession.id], machineId: "local" }]);
    expect(state.sessions.find((session) => session.id === oldSession.id)).toMatchObject({ archived: true });
    expect(state.sessions.find((session) => session.id === secondSession.id)).toMatchObject({ archived: true });
    expect(state.selectedSession?.id).toBe(nextSession.id);
  });

  it("applies partial failures from bulk archive", async () => {
    const persistedSession = { ...oldSession, persisted: true };
    const failedSession = { ...oldSession, id: "failed-session", path: "/tmp/failed-session.jsonl", persisted: true };
    const archiveCalls: { ids: string[]; machineId: string }[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      sessions: [persistedSession, failedSession],
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
    expect(Object.values(state.browserErrors).map((error) => error.message)).toContain("Archive failed for 1 session: failed-session: busy");
  });

  it("deletes selected archived sessions in bulk and selects the next current session", async () => {
    const archivedSession = { ...oldSession, archived: true, archivedAt: "later" };
    const nextSession = { ...oldSession, id: "next-session", path: "/tmp/next-session.jsonl" };
    const deleteCalls: { ids: string[]; machineId: string }[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: archivedSession, sessions: [archivedSession, nextSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      deleteArchivedMany: (sessions, machineId) => {
        deleteCalls.push({ ids: sessions.map(sessionLookupId), machineId: machineId ?? "local" });
        return Promise.resolve({ deleted: true, deletedSessionIds: sessions.map(sessionLookupId), failures: [], generatedAt: "now" });
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

    expect(deleteCalls).toEqual([{ ids: [archivedSession.id], machineId: "local" }]);
    expect(state.sessions.map((session) => session.id)).toEqual([nextSession.id]);
    expect(state.selectedSession?.id).toBe(nextSession.id);
  });

  it("follows archived-session deletion when the user selects it before the request settles", async () => {
    const deletedSession = { ...oldSession, id: "deleted-archived", path: "/tmp/deleted-archived.jsonl", archived: true, archivedAt: "later" };
    const nextSession = { ...oldSession, id: "next-session", path: "/tmp/next-session.jsonl" };
    const deleteRequest = deferred<{ deleted: true; deletedSessionIds: string[]; failures: []; generatedAt: string }>();
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession, deletedSession, nextSession],
    };
    const navigationExpected: string[] = [];
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      {
        api: {
          ...defaultApi,
          deleteArchivedMany: () => deleteRequest.promise,
        },
        socket: new FakeSocket(),
        navigateToSession: (session, options) => {
          navigationExpected.push(`${state.selectedSession?.id ?? "none"}:${options?.expected?.sessionId ?? "none"}`);
          state = { ...state, selectedSession: session };
          return Promise.resolve(true);
        },
      },
    );

    const deletion = controller.deleteArchivedSessions([deletedSession]);
    state = { ...state, selectedSession: deletedSession };
    deleteRequest.resolve({ deleted: true, deletedSessionIds: [deletedSession.id], failures: [], generatedAt: "now" });
    await deletion;

    expect(navigationExpected).toEqual([`${deletedSession.id}:${deletedSession.id}`]);
    expect(state.sessions.map((session) => session.id)).toEqual([oldSession.id, nextSession.id]);
    expect(state.selectedSession?.id).toBe(oldSession.id);
  });

  it("keeps partial failures visible from bulk delete", async () => {
    const deletedSession = { ...oldSession, archived: true, archivedAt: "later" };
    const failedSession = { ...oldSession, id: "failed-archived", path: "/tmp/failed-archived.jsonl", archived: true, archivedAt: "later" };
    const deleteCalls: { ids: string[]; machineId: string }[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: deletedSession,
      sessions: [deletedSession, failedSession],
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      deleteArchivedMany: (sessions, machineId) => {
        deleteCalls.push({ ids: sessions.map(sessionLookupId), machineId: machineId ?? "local" });
        return Promise.resolve({ deleted: true, deletedSessionIds: [deletedSession.id], failures: [{ sessionId: failedSession.id, error: "busy" }], generatedAt: "now" });
      },
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
    expect(Object.values(state.browserErrors).map((error) => error.message)).toContain("Delete failed for 1 session: failed-archived: busy");
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
});
