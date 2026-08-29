import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { ChatTranscriptStore } from "../chatTranscriptStore";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, FakeSocket, oldSession, replacementSession, sessionLookupId, status, workspace, type AppState, type MessagePage, type SessionStatus, type SessionStreamSnapshot } from "./sessionController.testSupport";

function page(text: string, total: number): MessagePage {
  return { messages: [{ role: "assistant", content: text }], start: 0, total };
}

describe("SessionController selected-session refresh", () => {
  it("signals selection readiness only after the initial transcript join succeeds", async () => {
    const messages = deferred<MessagePage>();
    const selectedStatus = deferred<SessionStatus>();
    const ready: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => messages.promise,
      status: () => selectedStatus.promise,
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      {
        api,
        socket: new FakeSocket(),
        onSelectedSessionReady: ({ machineId, session }) => { ready.push(`${machineId}:${session.id}`); },
      },
    );

    const selecting = controller.selectSession(oldSession, { updateUrl: false });
    await Promise.resolve();
    expect(ready).toEqual([]);

    messages.resolve(page("ready", 1));
    selectedStatus.resolve(status(oldSession.id));
    await selecting;

    expect(ready).toEqual([`local:${oldSession.id}`]);
  });

  it("shares same-turn requests and runs one trailing refresh requested during the active fetch", async () => {
    const firstPage = deferred<MessagePage>();
    const firstStatus = deferred<SessionStatus>();
    const trailingPage = deferred<MessagePage>();
    const trailingStatus = deferred<SessionStatus>();
    const trailingStarted = deferred<undefined>();
    let messageCalls = 0;
    let statusCalls = 0;
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => {
        messageCalls += 1;
        if (messageCalls === 2) trailingStarted.resolve(undefined);
        return messageCalls === 1 ? firstPage.promise : trailingPage.promise;
      },
      status: () => {
        statusCalls += 1;
        return statusCalls === 1 ? firstStatus.promise : trailingStatus.promise;
      },
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const first = controller.refreshSelectedSession();
    const duplicate = controller.refreshSelectedSession();
    await Promise.resolve();

    expect(messageCalls).toBe(1);
    expect(statusCalls).toBe(1);

    const later = controller.refreshSelectedSession();
    const laterDuplicate = controller.refreshSelectedSession();
    firstPage.resolve(page("stale", 1));
    firstStatus.resolve({ ...status(oldSession.id), messageCount: 1 });
    await trailingStarted.promise;

    expect(messageCalls).toBe(2);
    expect(statusCalls).toBe(2);

    trailingPage.resolve(page("fresh", 2));
    trailingStatus.resolve({ ...status(oldSession.id), messageCount: 2 });
    await Promise.all([first, duplicate, later, laterDuplicate]);

    expect(messageCalls).toBe(2);
    expect(statusCalls).toBe(2);
    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "fresh" }] }]);
    expect(state.status?.messageCount).toBe(2);
  });

  it("does not apply an older refresh after the user selects another session", async () => {
    const stalePage = deferred<MessagePage>();
    const staleStatus = deferred<SessionStatus>();
    const replacementPage = page("replacement", 1);
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession, replacementSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: (session) => sessionLookupId(session) === oldSession.id ? stalePage.promise : Promise.resolve(replacementPage),
      status: (session) => sessionLookupId(session) === oldSession.id ? staleStatus.promise : Promise.resolve(status(replacementSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const staleRefresh = controller.refreshSelectedSession();
    await Promise.resolve();
    await controller.selectSession(replacementSession, { updateUrl: false });
    stalePage.resolve(page("old response", 1));
    staleStatus.resolve({ ...status(oldSession.id), messageCount: 1 });
    await staleRefresh;

    expect(state.selectedSession?.id).toBe(replacementSession.id);
    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "replacement" }] }]);
    expect(state.status?.sessionId).toBe(replacementSession.id);
  });

  it("fetches the join-time stream snapshot alongside messages and status on refresh", async () => {
    // Leg 3 contract: the snapshot is fetched for the selected session on the join
    // refresh path. Seeding/watermark application is deliberately NOT asserted here
    // (that is Leg 4); this only guards that the data is fetched.
    const snapshotLookups: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve(page("live", 1)),
      status: () => Promise.resolve({ ...status(oldSession.id), isStreaming: true }),
      streamSnapshot: (session) => {
        snapshotLookups.push(sessionLookupId(session));
        return Promise.resolve({ seq: 5, partial: { role: "assistant", content: [{ type: "text", text: "partial" }] } });
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.refreshSelectedSession();

    expect(snapshotLookups).toEqual([oldSession.id]);
  });
});

describe("SessionController selected-session refresh errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function failingRefreshSetup() {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.reject(new Error("poll boom")),
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );
    return { controller, getState: () => state };
  }

  it("logs a silent background refresh failure without touching the global error state", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = failingRefreshSetup();

    await harness.controller.refreshSelectedSession(oldSession.id, { silent: true });

    expect(harness.getState().error).toBe("");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("still surfaces a user-triggered refresh failure in the global error state", async () => {
    const harness = failingRefreshSetup();

    await harness.controller.refreshSelectedSession();

    expect(harness.getState().error).toContain("poll boom");
  });
});

describe("SessionController unchanged selected-session refresh", () => {
  interface RefreshPoll {
    page: MessagePage;
    sessionStatus: SessionStatus;
    snapshot: SessionStreamSnapshot;
  }

  function idlePoll(): RefreshPoll {
    return { page: page("idle", 1), sessionStatus: { ...status(oldSession.id), messageCount: 1 }, snapshot: { seq: 4, partial: null } };
  }

  // The refresh invokes messages/status/streamSnapshot in order per poll, so the
  // poll index advances on the last of the three.
  function controllerWithPolls(polls: RefreshPoll[]) {
    const cacheWrites: string[] = [];
    let pollCalls = 0;
    let setStateCalls = 0;
    const poll = (): RefreshPoll => {
      const current = polls[Math.min(pollCalls, polls.length - 1)];
      if (current === undefined) throw new Error("controllerWithPolls requires at least one poll");
      return current;
    };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve(poll().page),
      status: () => Promise.resolve(poll().sessionStatus),
      streamSnapshot: () => {
        const snapshot = poll().snapshot;
        pollCalls += 1;
        return Promise.resolve(snapshot);
      },
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { setStateCalls += 1; state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      {
        api,
        socket: new FakeSocket(),
        transcripts: new ChatTranscriptStore({
          read: () => undefined,
          write: (sessionId) => { cacheWrites.push(sessionId); },
        }),
      },
    );
    return {
      controller,
      getState: () => state,
      setStateCalls: () => setStateCalls,
      appliedRefreshes: () => cacheWrites.length,
    };
  }

  it("skips the merge, cache rewrite, and state update when a poll changes nothing", async () => {
    const harness = controllerWithPolls([idlePoll()]);

    await harness.controller.refreshSelectedSession();
    expect(harness.appliedRefreshes()).toBe(1);
    const setStateCallsAfterFirst = harness.setStateCalls();
    const messagesAfterFirst = harness.getState().messages;
    expect(setStateCallsAfterFirst).toBeGreaterThan(0);

    await harness.controller.refreshSelectedSession();

    expect(harness.appliedRefreshes()).toBe(1);
    expect(harness.setStateCalls()).toBe(setStateCallsAfterFirst);
    expect(harness.getState().messages).toBe(messagesAfterFirst);
  });

  it("applies a poll whose page grew", async () => {
    const grown: RefreshPoll = {
      page: { messages: [{ role: "assistant", content: "idle" }, { role: "assistant", content: "new" }], start: 0, total: 2 },
      sessionStatus: { ...status(oldSession.id), messageCount: 2 },
      snapshot: { seq: 5, partial: null },
    };
    const harness = controllerWithPolls([idlePoll(), grown]);

    await harness.controller.refreshSelectedSession();
    await harness.controller.refreshSelectedSession();

    expect(harness.appliedRefreshes()).toBe(2);
    expect(harness.getState().messages).toHaveLength(2);
    expect(harness.getState().status?.messageCount).toBe(2);
  });

  it("applies a poll whose only change is the status", async () => {
    const busier: RefreshPoll = { ...idlePoll(), sessionStatus: { ...status(oldSession.id), messageCount: 1, cost: 7 } };
    const harness = controllerWithPolls([idlePoll(), busier]);

    await harness.controller.refreshSelectedSession();
    await harness.controller.refreshSelectedSession();

    expect(harness.appliedRefreshes()).toBe(2);
    expect(harness.getState().status?.cost).toBe(7);
  });

  it("applies a poll whose in-flight partial changed", async () => {
    const streaming: RefreshPoll = {
      ...idlePoll(),
      snapshot: { seq: 5, partial: { role: "assistant", content: [{ type: "text", text: "partial" }] } },
    };
    const harness = controllerWithPolls([idlePoll(), streaming]);

    await harness.controller.refreshSelectedSession();
    await harness.controller.refreshSelectedSession();

    expect(harness.appliedRefreshes()).toBe(2);
    expect(harness.getState().messages).toHaveLength(2);
    expect(harness.getState().messages[1]).toEqual({ role: "assistant", parts: [{ type: "text", text: "partial" }] });
  });

  it("re-applies fully after reselection even when the poll data is unchanged", async () => {
    const harness = controllerWithPolls([idlePoll()]);

    await harness.controller.selectSession(oldSession, { updateUrl: false });
    expect(harness.appliedRefreshes()).toBe(1);

    await harness.controller.refreshSelectedSession();
    expect(harness.appliedRefreshes()).toBe(1);

    // Reselection resets the state baseline, so the join refresh must run the
    // full path (re-seed partial and watermark) rather than skip as unchanged.
    await harness.controller.selectSession(oldSession, { updateUrl: false });
    expect(harness.appliedRefreshes()).toBe(2);

    await harness.controller.refreshSelectedSession();
    expect(harness.appliedRefreshes()).toBe(2);
  });
});
