import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import type { SessionUiEvent } from "../sessionSocket";
import type { MessagePage, SessionTranscriptSnapshot } from "../api";
import { taskProgressFromMessages } from "../taskProgress";
import { SessionController, type SessionEventSocket } from "./sessionController";
import { deferred, emptyTranscriptApi, oldSession, replacementSession, runPendingAnimationFrames, status, workspace, type AppState, type SessionRef, type SessionStatus } from "./sessionController.testSupport";

class ObservableSocket implements SessionEventSocket {
  handler: ((event: SessionUiEvent) => void) | undefined;
  connection: ((connected: boolean) => void) | undefined;
  connect(_session: SessionRef, handler: (event: SessionUiEvent) => void, _reconnect?: () => void, _machine?: string, _open?: () => void, connection?: (connected: boolean) => void): void {
    this.handler = handler;
    this.connection = connection;
  }
  setHandler(handler: (event: SessionUiEvent) => void): void { this.handler = handler; }
  close(): void {
    this.connection?.(false);
    this.handler = undefined;
    this.connection = undefined;
  }
}

function setup() {
  let state: AppState = { ...initialAppState(), selectedWorkspace: workspace };
  const socket = new ObservableSocket();
  const fetchStatus = vi.fn<typeof emptyTranscriptApi.status>();
  const transcriptSnapshot = vi.fn(emptyTranscriptApi.transcriptSnapshot);
  const messages = vi.fn<typeof emptyTranscriptApi.messages>();
  const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, {
    socket, api: { ...emptyTranscriptApi, transcriptSnapshot, messages, status: fetchStatus, thinkingLevels: () => Promise.resolve({ levels: [] }) },
  });
  return { controller, socket, fetchStatus, transcriptSnapshot, messages, state: () => state, patch: (patch: Partial<AppState>) => { state = { ...state, ...patch }; } };
}

function snapshot(sessionId = oldSession.id, hint = "current"): SessionStatus {
  return { ...status(sessionId), extensionUi: { statuses: { demo: hint }, widgets: { "subagent-async": ["snapshot"] }, workingMessage: hint } };
}

describe("selected extension snapshot freshness", () => {
  it.each([
    { buffered: false, removed: false, offlineDispatch: false }, { buffered: true, removed: false, offlineDispatch: false },
    { buffered: false, removed: true, offlineDispatch: false }, { buffered: true, removed: true, offlineDispatch: false },
    { buffered: false, removed: false, offlineDispatch: true }, { buffered: false, removed: true, offlineDispatch: true },
  ])("rejects retired-connection transcript and buffered observations: %j", async ({ buffered, removed, offlineDispatch }) => {
    const h = setup();
    const oldResponse = deferred<SessionTranscriptSnapshot>();
    const newResponse = deferred<SessionTranscriptSnapshot>();
    const newStarted = deferred<undefined>();
    const page = { messages: [], start: 0, total: 0 };
    const fresh = removed ? status(oldSession.id) : snapshot(oldSession.id, "reconnected");
    h.transcriptSnapshot.mockResolvedValueOnce({ page, status: snapshot(), seq: 1, partial: null })
      .mockReturnValueOnce(oldResponse.promise)
      .mockImplementationOnce(() => { newStarted.resolve(undefined); return newResponse.promise; });
    h.fetchStatus.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(fresh);
    await h.controller.selectSession(oldSession);
    h.socket.connection?.(true); await Promise.resolve();
    if (offlineDispatch) h.socket.connection?.(false);
    const pending = h.controller.refreshSelectedSession(); await Promise.resolve();
    if (buffered) h.socket.handler?.({ type: "status.update", status: snapshot(oldSession.id, "old buffered"), seq: 11 });
    if (!offlineDispatch) h.socket.connection?.(false);
    h.socket.connection?.(true); await Promise.resolve();
    const followUp = h.controller.refreshSelectedSession();
    oldResponse.resolve({ page, status: snapshot(oldSession.id, "old response"), seq: 10, partial: null });
    await newStarted.promise; runPendingAnimationFrames();
    const observed = h.state().selectedExtensionUi?.snapshot;
    newResponse.resolve({ page, status: snapshot(oldSession.id, "new follow-up"), seq: 20, partial: null });
    await Promise.all([pending, followUp]); runPendingAnimationFrames();
    expect(observed).toEqual(fresh.extensionUi);
    expect(h.state().selectedExtensionUi?.snapshot.statuses).toEqual({ demo: "new follow-up" });
    h.controller.dispose();
  });

  it.each([false, true])("drops below-watermark extension writes without invalidating a fresh request (removed=%s)", async (removed) => {
    const h = setup();
    const current = removed ? status(oldSession.id) : snapshot();
    const pending = deferred<SessionStatus>();
    h.fetchStatus.mockReturnValue(pending.promise);
    h.transcriptSnapshot.mockResolvedValue({ page: { messages: [], start: 0, total: 0 }, status: current, seq: 20, partial: null });
    await h.controller.selectSession(oldSession);
    h.socket.connection?.(true);
    h.socket.handler?.({ type: "status.update", status: snapshot(oldSession.id, "obsolete"), seq: 10 });
    h.controller.applyGlobalEvent({ type: "status.update", status: current });
    runPendingAnimationFrames();
    pending.resolve(current); await pending.promise;
    expect(h.state().selectedExtensionUi?.snapshot).toEqual(current.extensionUi);
    h.controller.dispose();
  });

  it.each([false, true])("lets the transcript boundary supersede buffered extension writes (removed=%s)", async (removed) => {
    const h = setup();
    const response = deferred<SessionTranscriptSnapshot>();
    const current = removed ? status(oldSession.id) : snapshot();
    h.fetchStatus.mockResolvedValue(snapshot(oldSession.id, "previous"));
    await h.controller.selectSession(oldSession);
    h.socket.connection?.(true); await Promise.resolve();
    h.transcriptSnapshot.mockReturnValue(response.promise);
    const refreshing = h.controller.refreshSelectedSession();
    h.socket.handler?.({ type: "status.update", status: snapshot(oldSession.id, "obsolete"), seq: 10 });
    response.resolve({ page: { messages: [], start: 0, total: 0 }, status: current, seq: 20, partial: null });
    await refreshing; runPendingAnimationFrames();
    expect(h.state().selectedExtensionUi?.snapshot).toEqual(current.extensionUi);
    h.socket.handler?.({ type: "status.update", status: snapshot(oldSession.id, "newer"), seq: 21 });
    runPendingAnimationFrames();
    expect(h.state().selectedExtensionUi?.snapshot.statuses).toEqual({ demo: "newer" });
    h.controller.dispose();
  });

  it("clears on disconnect, ignores late replies, and fetches a replacement on reconnect", async () => {
    const h = setup();
    const first = deferred<SessionStatus>();
    const second = deferred<SessionStatus>();
    h.fetchStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await h.controller.selectSession(oldSession);
    expect(h.state().selectedExtensionUi).toBeUndefined();
    h.socket.connection?.(true);
    h.socket.connection?.(false);
    first.resolve(snapshot());
    await first.promise;
    expect(h.state().selectedExtensionUi).toBeUndefined();
    h.socket.connection?.(true);
    second.resolve(snapshot(oldSession.id, "reconnected"));
    await second.promise;
    expect(h.state().selectedExtensionUi?.snapshot.statuses).toEqual({ demo: "reconnected" });
    h.socket.connection?.(false);
    expect(h.state().selectedExtensionUi).toBeUndefined();
    h.controller.dispose();
  });

  it("keeps a newer stream snapshot over an older HTTP reply and removes cleared widgets", async () => {
    const h = setup();
    const pending = deferred<SessionStatus>();
    h.fetchStatus.mockReturnValue(pending.promise);
    await h.controller.selectSession(oldSession);
    h.socket.connection?.(true);
    h.socket.handler?.({ type: "status.update", status: snapshot(oldSession.id, "stream") });
    runPendingAnimationFrames();
    pending.resolve(snapshot(oldSession.id, "older"));
    await pending.promise;
    expect(h.state().selectedExtensionUi?.snapshot.statuses).toEqual({ demo: "stream" });
    h.socket.handler?.({ type: "status.update", status: { ...status(oldSession.id), extensionUi: { statuses: {}, widgets: {} } } });
    runPendingAnimationFrames();
    expect(h.state().selectedExtensionUi?.snapshot).toEqual({ statuses: {}, widgets: {} });
    h.socket.handler?.({ type: "status.update", status: status(oldSession.id) });
    runPendingAnimationFrames();
    expect(h.state().selectedExtensionUi).toBeUndefined();
    h.controller.dispose();
  });

  it("rejects old callbacks and HTTP replies across session and same-id machine changes", async () => {
    const h = setup();
    const pending = deferred<SessionStatus>();
    h.fetchStatus.mockReturnValue(pending.promise);
    await h.controller.selectSession(oldSession);
    const oldHandler = h.socket.handler;
    const oldConnection = h.socket.connection;
    oldConnection?.(true);
    await h.controller.selectSession(replacementSession);
    oldHandler?.({ type: "status.update", status: snapshot() });
    oldConnection?.(true);
    pending.resolve(snapshot());
    await pending.promise;
    runPendingAnimationFrames();
    expect(h.state().selectedExtensionUi).toBeUndefined();
    h.patch({ selectedMachine: { id: "remote", name: "Remote", kind: "remote", baseUrl: "https://example.test", createdAt: "now", updatedAt: "now" } });
    await h.controller.selectSession(oldSession);
    oldHandler?.({ type: "status.update", status: snapshot() });
    runPendingAnimationFrames();
    expect(h.state().selectedExtensionUi).toBeUndefined();
    h.controller.dispose();
  });

  it("does not reuse task history for the same session ID in a different cwd", async () => {
    const h = setup();
    h.transcriptSnapshot.mockResolvedValueOnce({ page: taskPage(), status: status(oldSession.id), seq: 1, partial: null });
    await h.controller.selectSession(oldSession);
    expect(taskProgressFromMessages(h.state().messages).state).toBe("current");
    const pending = deferred<SessionTranscriptSnapshot>(); h.transcriptSnapshot.mockReturnValueOnce(pending.promise);
    const selecting = h.controller.selectSession({ ...oldSession, cwd: "/other-repo" });
    expect(taskProgressFromMessages(h.state().messages).state).toBe("unavailable");
    pending.resolve({ page: { messages: [], start: 0, total: 0 }, status: status(oldSession.id), seq: 0, partial: null });
    await selecting; h.controller.dispose();
  });

  it("ignores old-machine pagination without replacing new history or clearing its loading state", async () => {
    const h = setup();
    const tail = { messages: [{ role: "assistant", content: "tail" }], start: 1, total: 2 };
    h.transcriptSnapshot.mockResolvedValue({ page: tail, status: status(oldSession.id), seq: 1, partial: null });
    const oldPage = deferred<MessagePage>(); const newPage = deferred<MessagePage>();
    h.messages.mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(newPage.promise);
    await h.controller.selectSession(oldSession);
    const first = h.controller.loadEarlierMessages();
    h.controller.clearActiveSession();
    h.patch({ selectedMachine: { id: "remote", name: "Remote", kind: "remote", baseUrl: "https://example.test", createdAt: "now", updatedAt: "now" } });
    await h.controller.selectSession(oldSession);
    const second = h.controller.loadEarlierMessages();
    oldPage.resolve(taskPage()); await first;
    expect(taskProgressFromMessages(h.state().messages).state).toBe("unavailable");
    expect(h.state().isLoadingEarlierMessages).toBe(true);
    newPage.resolve({ messages: [{ role: "user", content: "remote history" }], start: 0, total: 2 });
    await second;
    expect(h.state().isLoadingEarlierMessages).toBe(false);
    h.controller.dispose();
  });
});

function taskPage(): MessagePage {
  return { messages: [{ role: "toolResult", toolName: "todo", toolCallId: "task-1", content: [{ type: "text", text: "Origin task" }], details: {
    action: "create", params: {}, nextId: 2, tasks: [{ id: 1, subject: "Origin only", status: "completed" }],
  } }], start: 0, total: 1 };
}
