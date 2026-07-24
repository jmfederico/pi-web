import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, FakeSocket, oldSession, replacementSession, workspace, type AppState, type MessagePage } from "./sessionController.testSupport";

function earlierPage(): MessagePage {
  return { messages: [{ role: "user", content: "earlier" }], start: 0, total: 10 };
}

function historyState(): AppState {
  return {
    ...initialAppState(),
    selectedWorkspace: workspace,
    selectedSession: oldSession,
    sessions: [oldSession],
    messagePageStart: 5,
    messagePageEnd: 10,
    messagePageTotal: 10,
  };
}

describe("SessionController loadEarlierMessages", () => {
  it("holds the fetched page until the chat scroll goes idle", async () => {
    const fetched = deferred<MessagePage>();
    const scrollIdle = deferred<undefined>();
    let state = historyState();
    const api: typeof defaultApi = { ...defaultApi, messages: () => fetched.promise };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const loading = controller.loadEarlierMessages({ waitForScrollIdle: () => scrollIdle.promise });
    expect(state.isLoadingEarlierMessages).toBe(true);

    fetched.resolve(earlierPage());
    await Promise.resolve();
    await Promise.resolve();
    expect(state.messagePageStart).toBe(5);

    scrollIdle.resolve(undefined);
    await loading;
    expect(state.messagePageStart).toBe(0);
    expect(state.messages.map((message) => message.role)).toEqual(["user"]);
    expect(state.isLoadingEarlierMessages).toBe(false);
  });

  it("discards the fetched page when the session changes during the idle wait", async () => {
    const fetched = deferred<MessagePage>();
    const scrollIdle = deferred<undefined>();
    let state = historyState();
    const api: typeof defaultApi = { ...defaultApi, messages: () => fetched.promise };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const loading = controller.loadEarlierMessages({ waitForScrollIdle: () => scrollIdle.promise });
    fetched.resolve(earlierPage());
    await Promise.resolve();
    state = { ...state, selectedSession: replacementSession, sessions: [replacementSession] };

    scrollIdle.resolve(undefined);
    await loading;
    expect(state.messagePageStart).toBe(5);
    expect(state.messages).toEqual([]);
  });
});
