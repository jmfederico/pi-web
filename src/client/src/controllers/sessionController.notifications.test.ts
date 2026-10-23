import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import type { SessionNotificationInboxEvent } from "../../../shared/apiTypes";
import { SessionController, type SessionNotificationSessionBridge } from "./sessionController";
import { defaultApi, deferred, EmitSocket, emptyPage, oldSession, runPendingAnimationFrames, status, workspace, type AppState } from "./sessionController.testSupport";

function inboxEvent(): SessionNotificationInboxEvent {
  return {
    type: "notifications.inbox",
    daemonInstanceId: "daemon-a",
    catalogRevision: 1,
    summary: {
      sessionId: oldSession.id,
      cwd: oldSession.cwd,
      inboxRevision: 1,
      retainedCount: 1,
      discardedCount: 0,
      highestSeverity: "warning",
    },
    dismissThrough: { order: 1, overflowWatermark: 0 },
    delta: {
      kind: "added",
      notification: {
        id: "daemon-a:1",
        message: "background extension needs attention",
        truncated: false,
        severity: "warning",
        receivedAt: "2026-07-18T00:00:00.000Z",
        order: 1,
      },
    },
  };
}

describe("SessionController notification event boundary", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it("refetches the bounded notification snapshot when the selected socket first opens", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const refreshSelectedSession = vi.fn(() => Promise.resolve());
    const bridge: SessionNotificationSessionBridge = {
      prepareSelectedSession: vi.fn(),
      clearSelectedSession: vi.fn(),
      refreshSelectedSession,
      applyInboxEvent: vi.fn(),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      {
        socket,
        notifications: bridge,
        api: {
          ...defaultApi,
          transcriptSnapshot: vi.fn(() => Promise.resolve({ page: emptyPage, status: status(oldSession.id), seq: 0, partial: null })),
        },
      },
    );

    await controller.selectSession(oldSession, { updateUrl: false });
    expect(refreshSelectedSession).toHaveBeenCalledOnce();

    socket.open();
    expect(refreshSelectedSession).toHaveBeenCalledTimes(2);
    expect(refreshSelectedSession).toHaveBeenLastCalledWith(oldSession, "local");
  });

  it("completes selection and signals readiness before a slow notification refresh settles", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    let finishNotifications: (() => void) | undefined;
    const bridge: SessionNotificationSessionBridge = {
      prepareSelectedSession: vi.fn(),
      clearSelectedSession: vi.fn(),
      refreshSelectedSession: vi.fn(() => new Promise<void>((resolve) => { finishNotifications = resolve; })),
      applyInboxEvent: vi.fn(),
    };
    const ready = vi.fn();
    const updateUrl = vi.fn();
    const page = { messages: [{ role: "user", content: [{ type: "text", text: "hello from history" }] }], start: 0, total: 1 };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      updateUrl,
      undefined,
      {
        socket,
        notifications: bridge,
        onSelectedSessionReady: ready,
        api: {
          ...defaultApi,
          transcriptSnapshot: vi.fn(() => Promise.resolve({ page, status: status(oldSession.id), seq: 0, partial: null })),
          thinkingLevels: () => Promise.resolve({ levels: [] }),
        },
      },
    );

    let selected = false;
    const selecting = controller.selectSession(oldSession).then(() => { selected = true; });
    await vi.waitFor(() => { expect(selected).toBe(true); });
    expect(ready).toHaveBeenCalledExactlyOnceWith({ machineId: "local", session: oldSession });
    expect(state.messages[0]?.parts).toEqual([{ type: "text", text: "hello from history" }]);
    expect(updateUrl).toHaveBeenCalledOnce();
    socket.emit({ type: "assistant.delta", text: "live response", seq: 1 });
    runPendingAnimationFrames();
    expect(state.messages[1]?.parts).toEqual([{ type: "text", text: "live response" }]);

    finishNotifications?.();
    await selecting;
    expect(selected).toBe(true);
  });

  it.each(["resolve", "reject"] as const)("keeps refreshes and live output flowing while notifications are pending (%s)", async (outcome) => {
    const socket = new EmitSocket();
    const notifications = deferred<undefined>();
    const snapshot = {
      page: { messages: [{ role: "user", content: "hello" }], start: 0, total: 1 },
      status: { ...status(oldSession.id), isStreaming: true },
      seq: 1,
      partial: { role: "assistant", content: [{ type: "text", text: "first" }] },
    };
    const nextSnapshot = deferred<typeof snapshot>();
    const transcriptSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>()
      .mockResolvedValueOnce(snapshot)
      .mockReturnValueOnce(nextSnapshot.promise);
    const bridge: SessionNotificationSessionBridge = {
      prepareSelectedSession: vi.fn(),
      clearSelectedSession: vi.fn(),
      refreshSelectedSession: vi.fn(() => notifications.promise),
      applyInboxEvent: vi.fn(),
    };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket, notifications: bridge, api: { ...defaultApi, transcriptSnapshot, thinkingLevels: () => Promise.resolve({ levels: [] }) } },
    );
    const selecting = controller.selectSession(oldSession, { updateUrl: false });
    let refreshing: Promise<void> | undefined;
    try {
      await vi.waitFor(() => { expect(state.messages[1]?.parts).toEqual([{ type: "text", text: "first" }]); });
      refreshing = controller.refreshSelectedSession();
      socket.emit({ type: "assistant.delta", text: " new", seq: 2 });
      // A pending notification join must not occupy the transcript coordinator.
      await vi.waitFor(() => { expect(transcriptSnapshot).toHaveBeenCalledTimes(2); });
      nextSnapshot.resolve(snapshot);
      await vi.waitFor(() => {
        runPendingAnimationFrames();
        expect(state.messages[1]?.parts).toEqual([{ type: "text", text: "first new" }]);
      });
      socket.emit({ type: "assistant.delta", text: " output", seq: 3 });
      runPendingAnimationFrames();
      expect(state.messages[1]?.parts).toEqual([{ type: "text", text: "first new output" }]);
      expect(Object.values(state.browserErrors)).toEqual([]);

      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      if (outcome === "reject") notifications.reject(new Error("notifications unavailable"));
      else notifications.resolve(undefined);
      await Promise.all([selecting, refreshing]);
      if (outcome === "reject") {
        await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith("Selected session notification refresh failed", expect.any(Error)); });
        expect(Object.values(state.browserErrors)).toEqual([]);
      }
    } finally {
      notifications.resolve(undefined);
      nextSnapshot.resolve(snapshot);
      await Promise.all([selecting, refreshing]);
      controller.dispose();
    }
  });

  it("handles inbox events before transcript watermarking while ordinary extension output still flows", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const applyInboxEvent = vi.fn();
    const bridge: SessionNotificationSessionBridge = {
      prepareSelectedSession: vi.fn(),
      clearSelectedSession: vi.fn(),
      refreshSelectedSession: vi.fn(() => Promise.resolve()),
      applyInboxEvent,
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      transcriptSnapshot: vi.fn(() => Promise.resolve({ page: emptyPage, status: status(oldSession.id), seq: 100, partial: null })),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket, notifications: bridge },
    );
    await controller.selectSession(oldSession, { updateUrl: false });

    socket.emit({ ...inboxEvent(), seq: 50 });

    expect(applyInboxEvent).toHaveBeenCalledExactlyOnceWith("local", expect.objectContaining({ type: "notifications.inbox" }));

    socket.emit({ type: "command.output", level: "info", message: "ordinary extension output", seq: 102 });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.parts).toEqual([{ type: "text", text: "ordinary extension output" }]);
  });
});
