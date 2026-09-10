import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, emptyPage, FakeSocket, oldSession, sessionLookupId, status, workspace, type AppState, type SessionInfo } from "./sessionController.testSupport";

describe("SessionController backend selection", () => {
  it("forwards the chosen backend to the create request and keeps it on the resulting session", async () => {
    const started: SessionInfo = { ...oldSession, id: "started-omp-session", path: "/tmp/started-omp-session.jsonl", backend: "omp" };
    const startRequest = deferred<SessionInfo>();
    const startCalls: unknown[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: (cwd, machineId, startupToken, backend) => {
        startCalls.push({ cwd, machineId, startupToken, backend });
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
      { api, socket: new FakeSocket() },
    );

    const start = controller.startSession("omp");
    const tempId = state.selectedSession?.id;
    if (tempId === undefined) throw new Error("Expected a temporary session id");

    expect(startCalls).toEqual([{ cwd: workspace.path, machineId: "local", startupToken: tempId, backend: "omp" }]);

    startRequest.resolve(started);
    await start;

    expect(state.selectedSession?.id).toBe("started-omp-session");
    expect(state.selectedSession?.backend).toBe("omp");
  });

  it("keeps the OMP pending session failed when an older server silently creates a Pi session", async () => {
    const incompatibleResponses: SessionInfo[] = [
      { ...oldSession, id: "legacy-pi-session", path: "/tmp/legacy-pi-session.jsonl" },
      { ...oldSession, id: "explicit-pi-session", path: "/tmp/explicit-pi-session.jsonl", backend: "pi" },
    ];

    for (const response of incompatibleResponses) {
      let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
      const stopped: unknown[] = [];
      const api: typeof defaultApi = {
        ...defaultApi,
        startSession: () => Promise.resolve(response),
        stop: (session, machineId) => {
          stopped.push({ session, machineId });
          return Promise.resolve({ stopped: true });
        },
      };
      const controller = new SessionController(
        () => state,
        (patch) => { state = { ...state, ...patch }; },
        () => undefined,
        undefined,
        { api, socket: new FakeSocket() },
      );

      await controller.startSession("omp");

      const pending = state.sessions.find((session) => session.id.startsWith("pending-session-"));
      expect(pending).toMatchObject({ backend: "omp", persisted: false });
      expect(state.sessions.some((session) => session.id === response.id)).toBe(false);
      expect(state.selectedSession?.id).toBe(pending?.id);
      expect(state.activity).toMatchObject({ sessionId: pending?.id, phase: "error", label: "Session creation failed" });
      const errorMessage = Object.values(state.browserErrors).map((error) => error.message).join("\n");
      expect(errorMessage).toMatch(/incompatible.*backend/i);
      expect(errorMessage).toMatch(/\bomp\b/i);
      expect(stopped).toEqual([{ session: response, machineId: "local" }]);
    }
  });

  it("defaults to Pi's exact legacy create call when no backend is chosen", async () => {
    const startCalls: unknown[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: (cwd, machineId, startupToken, backend) => {
        startCalls.push({ cwd, machineId, startupToken, backend });
        return Promise.resolve({ ...oldSession, id: "started-pi-session", path: "/tmp/started-pi-session.jsonl" });
      },
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

    await controller.startSession();

    expect(startCalls).toHaveLength(1);
    // No caller-supplied backend must reach the API as `undefined`, matching
    // the pre-selector call shape byte-for-byte rather than sending a literal
    // "pi" the server has never had to understand.
    expect(startCalls[0]).toMatchObject({ backend: undefined });
    expect(state.selectedSession?.backend).toBeUndefined();
  });
});
