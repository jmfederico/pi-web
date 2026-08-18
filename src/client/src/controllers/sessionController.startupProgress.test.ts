import { describe, expect, it } from "vitest";
import { isSessionActive } from "../../../shared/activity";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, emptyPage, FakeSocket, oldSession, runPendingAnimationFrames, sessionLookupId, status, workspace, type AppState, type SessionActivity, type SessionInfo } from "./sessionController.testSupport";

function startupActivity(patch: Partial<SessionActivity> = {}): SessionActivity {
  return {
    sessionId: "backend-session",
    phase: "active",
    label: "Creating session",
    detail: "Starting the Pi session",
    at: "2026-07-20T00:00:01.000Z",
    startup: true,
    ...patch,
  };
}

/** The end-of-window report: no phase left to name, so no detail either. */
function idleStartupActivity(): SessionActivity {
  return { sessionId: "backend-session", phase: "idle", label: "idle", at: "2026-07-20T00:00:02.000Z" };
}

interface StartCall {
  cwd: string;
  machineId: string | undefined;
  startupToken: string | undefined;
}

function pendingStartController(state: { current: AppState }, api: Partial<typeof defaultApi> = {}) {
  const startRequest = deferred<SessionInfo>();
  const startCalls: StartCall[] = [];
  const controller = new SessionController(
    () => state.current,
    (patch) => { state.current = { ...state.current, ...patch }; },
    () => undefined,
    undefined,
    {
      api: {
        ...defaultApi,
        startSession: (cwd: string, machineId?: string, startupToken?: string) => {
          startCalls.push({ cwd, machineId, startupToken });
          return startRequest.promise;
        },
        messages: () => Promise.resolve(emptyPage),
        status: (session) => Promise.resolve(status(sessionLookupId(session))),
        ...api,
      },
      socket: new FakeSocket(),
    },
  );
  return { controller, startRequest, startCalls };
}

describe("SessionController session startup progress", () => {
  it("shows the daemon's startup phase on a pending row while its start request is still open", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const { controller, startRequest } = pendingStartController(state);

    const start = controller.startSession();
    const temporaryId = state.current.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");

    controller.applyGlobalEvent({ type: "session.startup", startupToken: temporaryId, activity: startupActivity() });
    runPendingAnimationFrames();

    // The label changes while the user is waiting, before the start resolves,
    // and it is attributed to the row the user is actually looking at.
    expect(state.current.activity).toMatchObject({ sessionId: temporaryId, phase: "active", label: "Creating session", detail: "Starting the Pi session" });
    expect(state.current.sessionActivities[temporaryId]).toMatchObject({ detail: "Starting the Pi session" });

    controller.applyGlobalEvent({ type: "session.startup", startupToken: temporaryId, activity: startupActivity({ detail: "Loading session extensions" }) });
    runPendingAnimationFrames();

    expect(state.current.activity?.detail).toBe("Loading session extensions");

    startRequest.resolve({ ...oldSession, id: "backend-session", path: "/tmp/backend-session.jsonl" });
    await start;
  });

  it("keeps a pending create row's own appearance while it borrows the daemon's phase text", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const { controller, startRequest } = pendingStartController(state);

    const start = controller.startSession();
    const temporaryId = state.current.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");
    const beforeStartupProgress = isSessionActive(state.current.status, state.current.activity);

    controller.applyGlobalEvent({ type: "session.startup", startupToken: temporaryId, activity: startupActivity() });
    runPendingAnimationFrames();

    // This row is the browser's own pending create, not a session being opened.
    // Substituting the daemon's phase text into it must not silently change what
    // the row reports about itself, or its indicator would blink off mid-create.
    expect(state.current.activity?.phase).toBe("active");
    expect(isSessionActive(state.current.status, state.current.activity)).toBe(beforeStartupProgress);

    startRequest.resolve({ ...oldSession, id: "backend-session", path: "/tmp/backend-session.jsonl" });
    await start;
  });

  it("restores the generic wording when the daemon has nothing left to attribute", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const { controller, startRequest } = pendingStartController(state);

    const start = controller.startSession();
    const temporaryId = state.current.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");
    controller.applyGlobalEvent({ type: "session.startup", startupToken: temporaryId, activity: startupActivity() });
    runPendingAnimationFrames();

    controller.applyGlobalEvent({ type: "session.startup", startupToken: temporaryId, activity: idleStartupActivity() });
    runPendingAnimationFrames();

    expect(state.current.activity).toMatchObject({
      sessionId: temporaryId,
      phase: "active",
      label: "Creating session",
      detail: "Waiting for the backend session to be ready",
    });

    startRequest.resolve({ ...oldSession, id: "backend-session", path: "/tmp/backend-session.jsonl" });
    await start;
  });

  it("restores the queued-message wording when a pending row has sends waiting", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const { controller, startRequest } = pendingStartController(state);

    const start = controller.startSession();
    await controller.send("queued while starting");
    const temporaryId = state.current.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");
    controller.applyGlobalEvent({ type: "session.startup", startupToken: temporaryId, activity: idleStartupActivity() });
    runPendingAnimationFrames();

    expect(state.current.activity?.detail).toBe("1 queued message will send when the backend session is ready");

    startRequest.resolve({ ...oldSession, id: "backend-session", path: "/tmp/backend-session.jsonl" });
    await start;
  });

  it("applies startup progress for an existing session it already knows the id of", () => {
    let state: AppState = { ...initialAppState(), selectedSession: oldSession, sessions: [oldSession] };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket: new FakeSocket() },
    );

    controller.applyGlobalEvent({
      type: "session.startup",
      activity: startupActivity({ sessionId: oldSession.id, label: "Opening session" }),
    });
    runPendingAnimationFrames();

    expect(state.activity).toMatchObject({ sessionId: oldSession.id, label: "Opening session", detail: "Starting the Pi session" });
  });

  it("shows an archived session's opening progress without reporting it as active work", () => {
    const archived = { ...oldSession, id: "archived-session", archived: true, archivedAt: "2026-05-16T00:00:00.000Z" };
    let state: AppState = { ...initialAppState(), selectedSession: archived, sessions: [archived] };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket: new FakeSocket() },
    );

    controller.applyGlobalEvent({
      type: "session.startup",
      activity: startupActivity({ sessionId: archived.id, label: "Opening session" }),
    });
    runPendingAnimationFrames();

    // A read-only session cannot be worked on, so opening one must not make it
    // look busy — while the text a waiting user reads still arrives.
    expect(state.activity).toMatchObject({ sessionId: archived.id, label: "Opening session", detail: "Starting the Pi session" });
    expect(isSessionActive(state.status, state.activity)).toBe(false);
  });

  it("gives an existing session's startup its own row rather than a pending start in the same workspace", async () => {
    const existing = { ...oldSession, id: "existing-session", cwd: workspace.path };
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [existing] } };
    const { controller, startRequest } = pendingStartController(state);

    const start = controller.startSession();
    const temporaryId = state.current.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");

    // Opening an existing session in the same workspace carries no create token,
    // so the known id is the only proof of which row it belongs to and the pending
    // row must keep its own wording instead of the other row's phase.
    controller.applyGlobalEvent({
      type: "session.startup",
      activity: startupActivity({ sessionId: existing.id, label: "Opening session" }),
    });
    runPendingAnimationFrames();

    expect(state.current.sessionActivities[existing.id]).toMatchObject({ label: "Opening session", detail: "Starting the Pi session" });
    expect(state.current.sessionActivities[temporaryId]?.detail).toBe("Waiting for the backend session to be ready");

    startRequest.resolve({ ...oldSession, id: "backend-session", path: "/tmp/backend-session.jsonl" });
    await start;
  });

  it("keeps the generic wording when no pending row's token matches the startup progress", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const { controller, startRequest } = pendingStartController(state);

    const start = controller.startSession();
    const temporaryId = state.current.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");

    // Another browser tab's create, or another workspace's: its token is one this
    // browser never minted, so there is no row here that it belongs to.
    controller.applyGlobalEvent({ type: "session.startup", startupToken: "pending-session-9-other-tab", activity: startupActivity() });
    // A session this browser has not been told about — an agent's spawned
    // subsession, say, whose `session.created` a pending create suppresses — is
    // opened rather than created, so it carries no token at all.
    controller.applyGlobalEvent({ type: "session.startup", activity: startupActivity({ sessionId: "foreign-session", label: "Opening session", detail: "Loading session extensions" }) });
    runPendingAnimationFrames();

    expect(state.current.activity?.detail).toBe("Waiting for the backend session to be ready");
    expect(state.current.activity?.label).toBe("Creating session");

    startRequest.resolve({ ...oldSession, id: "backend-session", path: "/tmp/backend-session.jsonl" });
    await start;
  });

  it("gives each of two concurrent creates only the progress its own token carries", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const { controller, startRequest } = pendingStartController(state);

    const start = controller.startSession();
    const firstId = state.current.selectedSession?.id;
    const secondStart = controller.startSession();
    const secondId = state.current.selectedSession?.id;
    if (firstId === undefined || secondId === undefined || firstId === secondId) throw new Error("Expected two distinct temporary session ids");

    // Two creates in the same workspace are indistinguishable by workspace path;
    // the token each request carried is what tells them apart.
    controller.applyGlobalEvent({ type: "session.startup", startupToken: secondId, activity: startupActivity({ detail: "Loading session extensions" }) });
    runPendingAnimationFrames();

    expect(state.current.sessionActivities[secondId]).toMatchObject({ sessionId: secondId, detail: "Loading session extensions" });
    expect(state.current.sessionActivities[firstId]?.detail).toBe("Waiting for the backend session to be ready");

    startRequest.resolve({ ...oldSession, id: "backend-session", path: "/tmp/backend-session.jsonl" });
    await Promise.all([start, secondStart]);
  });

  it("sends the pending row's own id as the create request's correlation token", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const { controller, startRequest, startCalls } = pendingStartController(state);

    const start = controller.startSession();
    const temporaryId = state.current.selectedSession?.id;

    expect(startCalls).toEqual([{ cwd: workspace.path, machineId: "local", startupToken: temporaryId }]);

    startRequest.resolve({ ...oldSession, id: "backend-session", path: "/tmp/backend-session.jsonl" });
    await start;
  });
});
