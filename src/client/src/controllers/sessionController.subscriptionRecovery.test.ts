import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { SessionSocket, type SessionUiEvent } from "../sessionSocket";
import { SessionController } from "./sessionController";
import type { NavigationFreshness } from "./types";
import { defaultApi, deferred, emptyPage, oldSession, replacementSession, runPendingAnimationFrames, sessionLookupId, status, workspace, type AppState, type SessionTranscriptSnapshot } from "./sessionController.testSupport";

// Only the browser transport is fake: terminal close, reconnect ownership,
// callback retirement, and event parsing all run through the real SessionSocket.
class BrowserSocket {
  static readonly CONNECTING = 0;
  static readonly instances: BrowserSocket[] = [];
  readyState = BrowserSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) { BrowserSocket.instances.push(this); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  emit(event: SessionUiEvent): void { this.onmessage?.({ data: JSON.stringify(event) }); }
}

function connection(): BrowserSocket {
  const socket = BrowserSocket.instances.at(-1);
  if (socket === undefined) throw new Error("Expected a session subscription");
  return socket;
}

function snapshot(sessionId = oldSession.id): SessionTranscriptSnapshot {
  return { page: emptyPage, status: status(sessionId), seq: 0, partial: null };
}

function harness() {
  let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession, replacementSession] };
  let generation = 0;
  let visible = true;
  const navigation = (): NavigationFreshness => {
    const captured = generation;
    return { generation: captured, scope: ["machine", "project", "workspace", "session"], isCurrent: () => captured === generation };
  };
  const beginNavigationOperation = vi.fn(navigation);
  const canRejoinSelectedSession = vi.fn(() => true);
  const updateUrl = vi.fn();
  const ready = vi.fn();
  const readSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>((session) => Promise.resolve(snapshot(sessionLookupId(session))));
  const socket = new SessionSocket();
  const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, updateUrl, undefined, {
    socket, beginNavigationOperation, canRejoinSelectedSession, onSelectedSessionReady: ready, isChatVisible: () => visible,
    api: { ...defaultApi, transcriptSnapshot: readSnapshot, messages: () => Promise.resolve(emptyPage), thinkingLevels: () => Promise.resolve({ levels: [] }) },
  });
  return {
    controller, socket, readSnapshot, updateUrl, ready, navigation, beginNavigationOperation, canRejoinSelectedSession,
    state: () => state, retire: () => { generation += 1; }, hide: () => { visible = false; },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  BrowserSocket.instances.length = 0;
  vi.stubGlobal("WebSocket", BrowserSocket);
  vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function abandonJoin(h: ReturnType<typeof harness>): Promise<BrowserSocket> {
  // Reproduce a route publication retiring the token after a coherent snapshot
  // has applied, but before selectSession's finally releases its subscription.
  h.updateUrl.mockImplementationOnce(h.retire);
  const selecting = h.controller.selectSession(oldSession, { navigation: h.navigation() });
  const previous = connection();
  previous.open();
  await selecting;
  await vi.advanceTimersByTimeAsync(0);
  expect(previous.readyState).toBe(3);
  expect(h.controller.canReuseSelectedSession()).toBe(false);
  return previous;
}

describe("selected-session subscription recovery", () => {
  it.each([true, false])("rejoins an abandoned subscription on resume (reconnect: %s)", async (reconnect) => {
    const h = harness();
    const previous = await abandonJoin(h);
    expect(h.state().conversationSync).toBe("stale");
    // An HTTP success alone must not advertise the abandoned transport as open.
    await h.controller.refreshSelectedSession();
    expect(h.state().conversationSync).toBe("stale");
    h.socket.reconnect();
    expect(BrowserSocket.instances).toHaveLength(1);

    await h.controller.resumeSelectedSession({ reconnect });
    expect(BrowserSocket.instances).toHaveLength(2);
    expect(h.beginNavigationOperation).toHaveBeenCalledWith(["machine", "project", "workspace", "session"]);
    expect(h.updateUrl).toHaveBeenCalledOnce();
    expect(h.state().conversationSync).toBe("stale");
    expect(h.controller.canReuseSelectedSession()).toBe(true);
    connection().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state().conversationSync).toBe("checked");
    previous.emit({ type: "assistant.start", message: { role: "assistant", content: "retired output" }, seq: 1 });
    connection().emit({ type: "assistant.start", message: { role: "assistant", content: [] }, seq: 2 });
    connection().emit({ type: "assistant.delta", text: "live output", seq: 3 });
    await vi.advanceTimersByTimeAsync(0);
    runPendingAnimationFrames();
    expect(JSON.stringify(h.state().messages)).toContain("live output");
    expect(JSON.stringify(h.state().messages)).not.toContain("retired output");
    h.controller.dispose();
  });

  it("waits for route authorization before capturing freshness or rejoining an abandoned selection", async () => {
    const h = harness();
    await abandonJoin(h);
    h.canRejoinSelectedSession.mockReturnValue(false);
    h.readSnapshot.mockClear();
    await h.controller.resumeSelectedSession({ reconnect: true });
    await h.controller.resumeSelectedSession({ reconnect: false });
    expect(BrowserSocket.instances).toHaveLength(1);
    expect(h.beginNavigationOperation).not.toHaveBeenCalled();
    expect(h.readSnapshot).not.toHaveBeenCalled();
    expect(h.controller.canReuseSelectedSession()).toBe(false);

    h.canRejoinSelectedSession.mockReturnValue(true);
    await h.controller.resumeSelectedSession({ reconnect: true });
    expect(BrowserSocket.instances).toHaveLength(2);
    expect(h.beginNavigationOperation).toHaveBeenCalledOnce();
    expect(h.readSnapshot).toHaveBeenCalledOnce();
    connection().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state().conversationSync).toBe("checked");
    h.controller.dispose();
  });

  it("keeps ordinary reconnect catch-up owned by the replacement transport's open callback", async () => {
    const h = harness();
    await h.controller.selectSession(oldSession);
    connection().open();
    await vi.advanceTimersByTimeAsync(0);
    h.readSnapshot.mockClear();
    h.canRejoinSelectedSession.mockReturnValue(false);
    await h.controller.resumeSelectedSession({ reconnect: true });
    expect(BrowserSocket.instances).toHaveLength(2);
    expect(h.canRejoinSelectedSession).not.toHaveBeenCalled();
    expect(h.state().conversationSync).toBe("stale");
    expect(h.readSnapshot).not.toHaveBeenCalled();
    expect(h.ready).toHaveBeenCalledOnce();
    expect(h.beginNavigationOperation).not.toHaveBeenCalled();
    connection().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.readSnapshot).toHaveBeenCalledOnce();
    expect(h.state().conversationSync).toBe("checked");
    h.controller.dispose();
  });

  it("does not mistake transport backoff for an abandoned controller subscription", async () => {
    const h = harness();
    await h.controller.selectSession(oldSession);
    connection().open();
    await vi.advanceTimersByTimeAsync(0);
    connection().close();
    h.readSnapshot.mockClear();
    await h.controller.resumeSelectedSession({ reconnect: false });
    expect(BrowserSocket.instances).toHaveLength(1);
    expect(h.readSnapshot).toHaveBeenCalledOnce();
    expect(h.beginNavigationOperation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(BrowserSocket.instances).toHaveLength(2);
    connection().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state().conversationSync).toBe("checked");
    h.controller.dispose();
  });

  it.each([oldSession, replacementSession])("does not let a retired join close a newer selection of $id", async (nextSession) => {
    const h = harness();
    const pending = deferred<SessionTranscriptSnapshot>();
    h.readSnapshot.mockImplementationOnce(() => pending.promise);
    const oldJoin = h.controller.selectSession(oldSession, { navigation: h.navigation() });
    connection().open();
    await vi.advanceTimersByTimeAsync(0);
    h.retire();
    const newJoin = h.controller.selectSession(nextSession, { navigation: h.navigation() });
    connection().open();
    pending.resolve(snapshot());
    await Promise.all([oldJoin, newJoin]);
    await vi.advanceTimersByTimeAsync(0);
    expect(BrowserSocket.instances).toHaveLength(2);
    expect(connection().readyState).toBe(1);
    expect(h.state().selectedSession?.id).toBe(nextSession.id);
    expect(h.state().conversationSync).toBe("checked");
    expect(h.ready).toHaveBeenCalledExactlyOnceWith({ machineId: "local", session: nextSession });
    h.controller.dispose();
  });

  it("guards a recovery join with fresh navigation and never resurrects its row after reselection", async () => {
    const h = harness();
    await abandonJoin(h);
    const pending = deferred<SessionTranscriptSnapshot>();
    h.readSnapshot.mockImplementationOnce(() => pending.promise);
    const recovering = h.controller.resumeSelectedSession({ reconnect: true });
    connection().open();
    await vi.advanceTimersByTimeAsync(0);
    h.retire();
    await h.controller.selectSession(replacementSession, { navigation: h.navigation() });
    connection().open();
    pending.resolve({ ...snapshot(), page: { messages: [{ role: "assistant", content: "stale snapshot" }], start: 0, total: 1 } });
    await recovering;
    await vi.advanceTimersByTimeAsync(0);
    expect(BrowserSocket.instances).toHaveLength(3);
    expect(connection().readyState).toBe(1);
    expect(h.state().selectedSession).toBe(replacementSession);
    expect(JSON.stringify(h.state().messages)).not.toContain("stale snapshot");
    expect(h.state().conversationSync).toBe("checked");
    h.controller.dispose();
  });

  it("does not join when the newly captured recovery operation is already retired", async () => {
    const h = harness();
    await abandonJoin(h);
    const retired = h.navigation();
    h.retire();
    h.beginNavigationOperation.mockReturnValueOnce(retired);
    await h.controller.resumeSelectedSession({ reconnect: true });
    expect(BrowserSocket.instances).toHaveLength(1);
    await h.controller.resumeSelectedSession({ reconnect: true });
    expect(BrowserSocket.instances).toHaveLength(2);
    h.controller.dispose();
  });

  it.each(["archived", "pending", "deferred", "hidden", "cleared", "disposed"] as const)("does not rejoin an ineligible selection (%s)", async (kind) => {
    const h = harness();
    await abandonJoin(h);
    if (kind === "archived") await h.controller.selectSession({ ...oldSession, archived: true });
    if (kind === "pending") {
      const pending = { ...oldSession, id: "creating:pending", clientPendingStart: true as const, machineId: "local" };
      await h.controller.selectSession(pending);
    }
    if (kind === "deferred") await h.controller.selectSession(oldSession, { deferChatLoading: true });
    if (kind === "hidden") h.hide();
    if (kind === "cleared") h.controller.clearActiveSession();
    if (kind === "disposed") h.controller.dispose();
    h.readSnapshot.mockClear();
    await h.controller.resumeSelectedSession({ reconnect: true });
    await h.controller.resumeSelectedSession({ reconnect: false });
    expect(BrowserSocket.instances).toHaveLength(1);
    expect(h.readSnapshot).not.toHaveBeenCalled();
    h.controller.dispose();
  });
});
