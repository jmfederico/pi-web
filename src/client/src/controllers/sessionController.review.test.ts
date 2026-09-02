import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, emptyPage, FakeSocket, oldSession, sessionLookupId, status, workspace, type AppState, type SessionInfo } from "./sessionController.testSupport";

describe("SessionController send() return-value contract", () => {
  it("resolves true on successful delivery", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = { ...defaultApi, prompt: () => Promise.resolve({ accepted: true }) };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await expect(controller.send("hello")).resolves.toBe(true);
  });

  it("resolves false when delivery fails", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = { ...defaultApi, prompt: () => Promise.reject(new Error("boom")) };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await expect(controller.send("hello")).resolves.toBe(false);
    expect(state.error).toBe("Error: boom");
  });

  it("resolves true when enqueuing for a pending-start session", async () => {
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

    void controller.startSession();
    await expect(controller.send("queued while starting")).resolves.toBe(true);
  });

  it("resolves false without sending when there is no selected session", async () => {
    let state: AppState = { ...initialAppState() };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api: defaultApi, socket: new FakeSocket() },
    );

    await expect(controller.send("hello")).resolves.toBe(false);
  });
});

describe("SessionController hasReviewContent bypass", () => {
  it("does not run slash-command-looking text as a command when hasReviewContent is true", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    let runCommandCalled = false;
    let promptText: string | undefined;
    const api: typeof defaultApi = {
      ...defaultApi,
      runCommand: () => { runCommandCalled = true; return Promise.resolve({ type: "done" }); },
      prompt: (_session, text) => { promptText = text; return Promise.resolve({ accepted: true }); },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const result = await controller.send("/foo", undefined, undefined, "inline", undefined, true);

    expect(runCommandCalled).toBe(false);
    expect(promptText).toBe("/foo");
    expect(result).toBe(true);
  });

  it("does not run shell-looking text as shell input when hasReviewContent is true", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    let shellCalled = false;
    let promptText: string | undefined;
    const api: typeof defaultApi = {
      ...defaultApi,
      shell: () => { shellCalled = true; return Promise.resolve({ accepted: true }); },
      prompt: (_session, text) => { promptText = text; return Promise.resolve({ accepted: true }); },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const result = await controller.send("!pwd", undefined, undefined, "inline", undefined, true);

    expect(shellCalled).toBe(false);
    expect(promptText).toBe("!pwd");
    expect(result).toBe(true);
  });

  it("still enqueues comment-bearing sends as plain prompts for a pending-start session", async () => {
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    const calls: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
      runCommand: (session, text) => { calls.push(`command:${sessionLookupId(session)}:${text}`); return Promise.resolve({ type: "done" }); },
      prompt: (session, text) => { calls.push(`prompt:${sessionLookupId(session)}:${text}`); return Promise.resolve({ accepted: true }); },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const start = controller.startSession();
    await controller.send("/help", undefined, undefined, "inline", undefined, true);
    startRequest.resolve(started);
    await start;

    expect(calls).toEqual([`prompt:${started.id}:/help`]);
  });
});
