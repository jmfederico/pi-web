import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import type { SessionNotificationInboxEvent } from "../../../shared/apiTypes";
import { SessionController, type SessionNotificationSessionBridge } from "./sessionController";
import { defaultApi, EmitSocket, emptyPage, oldSession, status, workspace, type AppState } from "./sessionController.testSupport";

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
  it("refetches the bounded notification snapshot when the selected socket first opens", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const refreshSelectedSession = vi.fn(() => Promise.resolve());
    const bridge: SessionNotificationSessionBridge = {
      prepareSelectedSession: vi.fn(),
      clearSelectedSession: vi.fn(),
      refreshSelectedSession,
      applyInboxEvent: vi.fn(),
      shouldFilterLegacyNotification: vi.fn(() => true),
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
          messages: vi.fn(() => Promise.resolve(emptyPage)),
          status: vi.fn(() => Promise.resolve(status(oldSession.id))),
          streamSnapshot: vi.fn(() => Promise.resolve({ seq: 0, partial: null })),
        },
      },
    );

    await controller.selectSession(oldSession, { updateUrl: false });
    expect(refreshSelectedSession).toHaveBeenCalledOnce();

    socket.open();
    expect(refreshSelectedSession).toHaveBeenCalledTimes(2);
    expect(refreshSelectedSession).toHaveBeenLastCalledWith(oldSession, "local");
  });

  it("handles inbox events before transcript watermarking and filters only marked legacy output with support", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const applyInboxEvent = vi.fn();
    const bridge: SessionNotificationSessionBridge = {
      prepareSelectedSession: vi.fn(),
      clearSelectedSession: vi.fn(),
      refreshSelectedSession: vi.fn(() => Promise.resolve()),
      applyInboxEvent,
      shouldFilterLegacyNotification: vi.fn((_machineId, notificationId) => notificationId !== undefined),
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: vi.fn(() => Promise.resolve(emptyPage)),
      status: vi.fn(() => Promise.resolve(status(oldSession.id))),
      streamSnapshot: vi.fn(() => Promise.resolve({ seq: 100, partial: null })),
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
    socket.emit({ type: "command.output", level: "info", message: "legacy duplicate", notificationId: "daemon-a:1", seq: 101 });

    expect(applyInboxEvent).toHaveBeenCalledExactlyOnceWith("local", expect.objectContaining({ type: "notifications.inbox" }));
    expect(state.messages).toEqual([]);

    socket.emit({ type: "command.output", level: "info", message: "ordinary extension output", seq: 102 });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.parts).toEqual([{ type: "text", text: "ordinary extension output" }]);
  });

  it("preserves marked legacy notification output when capability support is absent", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const bridge: SessionNotificationSessionBridge = {
      prepareSelectedSession: vi.fn(),
      clearSelectedSession: vi.fn(),
      refreshSelectedSession: vi.fn(() => Promise.resolve()),
      applyInboxEvent: vi.fn(),
      shouldFilterLegacyNotification: vi.fn(() => false),
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
          messages: vi.fn(() => Promise.resolve(emptyPage)),
          status: vi.fn(() => Promise.resolve(status(oldSession.id))),
          streamSnapshot: vi.fn(() => Promise.resolve({ seq: 0, partial: null })),
        },
      },
    );
    await controller.selectSession(oldSession, { updateUrl: false });

    socket.emit({ type: "command.output", level: "info", message: "legacy notification", notificationId: "new-daemon:1", seq: 1 });

    expect(state.messages[0]?.parts).toEqual([{ type: "text", text: "legacy notification" }]);
  });
});
