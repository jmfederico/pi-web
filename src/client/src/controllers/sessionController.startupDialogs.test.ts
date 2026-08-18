import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import type { ExtensionDialogCloseResponse, ExtensionDialogKind, PendingExtensionDialog } from "../api";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, EmitSocket, emptyPage, oldSession, runPendingAnimationFrames, sessionLookupId, status, workspace, type AppState, type SessionActivity, type SessionInfo, type SessionStatus } from "./sessionController.testSupport";

const BACKEND_SESSION_ID = "backend-session";

function startupActivity(patch: Partial<SessionActivity> = {}): SessionActivity {
  return {
    sessionId: BACKEND_SESSION_ID,
    phase: "active",
    label: "Creating session",
    detail: "Loading session extensions",
    at: "2026-07-20T00:00:01.000Z",
    startup: true,
    ...patch,
  };
}

function dialog(dialogId: string, kind: ExtensionDialogKind = "confirm"): PendingExtensionDialog {
  return {
    dialogId,
    kind,
    title: `Dialog ${dialogId}`,
    ...(kind === "confirm" ? { message: "Are you sure?" } : {}),
    askedAt: "2026-07-20T00:00:00.000Z",
    runScoped: false,
  };
}

function statusWithDialogs(sessionId: string, pendingDialogs: PendingExtensionDialog[]): SessionStatus {
  return { ...status(sessionId), pendingDialogs };
}

function closeResponse(sessionStatus: SessionStatus, dialogId = "dialog-1"): ExtensionDialogCloseResponse {
  return {
    result: "closed",
    outcome: {
      dialogId,
      reason: "answered",
      answer: true,
      askedAt: "2026-07-20T00:00:00.000Z",
      closedAt: "2026-07-20T00:01:00.000Z",
    },
    sessionStatus,
  };
}

interface PendingStartHarness {
  controller: SessionController;
  socket: EmitSocket;
  startRequest: ReturnType<typeof deferred<SessionInfo>>;
  state: { current: AppState };
}

/**
 * A controller with one in-flight create whose start request stays open until
 * the test resolves it — the browser side of a `session_start` dialog parking
 * session readiness.
 */
function pendingStartController(state: { current: AppState }, api: Partial<typeof defaultApi> = {}): PendingStartHarness {
  const startRequest = deferred<SessionInfo>();
  const socket = new EmitSocket();
  const controller = new SessionController(
    () => state.current,
    (patch) => { state.current = { ...state.current, ...patch }; },
    () => undefined,
    undefined,
    {
      api: {
        ...defaultApi,
        startSession: () => startRequest.promise,
        messages: () => Promise.resolve(emptyPage),
        status: (session) => Promise.resolve(status(sessionLookupId(session))),
        streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
        thinkingLevels: () => Promise.resolve({ levels: [] }),
        ...api,
      },
      socket,
    },
  );
  return { controller, socket, startRequest, state };
}

function beginPendingStart(harness: PendingStartHarness): { start: Promise<void>; tempId: string } {
  const start = harness.controller.startSession();
  const tempId = harness.state.current.selectedSession?.id;
  if (tempId === undefined) throw new Error("Expected a pending-start row to be selected");
  if (!tempId.startsWith("pending-session-")) throw new Error("Expected a pending-start row to be selected");
  return { start, tempId };
}

function reportBackendSessionId(harness: PendingStartHarness, tempId: string): void {
  harness.controller.applyGlobalEvent({ type: "session.startup", startupToken: tempId, activity: startupActivity() });
  runPendingAnimationFrames();
}

function resolveBackendSession(harness: PendingStartHarness): void {
  harness.startRequest.resolve({ ...oldSession, id: BACKEND_SESSION_ID, path: "/tmp/backend-session.jsonl" });
}

describe("SessionController session_start dialog startup reachability", () => {
  it("subscribes to the backend session as soon as startup progress names it", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const statusCalls: string[] = [];
    const harness = pendingStartController(state, {
      status: (session) => {
        statusCalls.push(sessionLookupId(session));
        return Promise.resolve(status(sessionLookupId(session)));
      },
    });
    const { start, tempId } = beginPendingStart(harness);
    expect(harness.socket.connectedSessionIds).toEqual([]);

    reportBackendSessionId(harness, tempId);

    expect(harness.socket.connectedSessionIds).toEqual([BACKEND_SESSION_ID]);
    await vi.waitFor(() => { expect(statusCalls).toEqual([BACKEND_SESSION_ID]); });
    resolveBackendSession(harness);
    await start;
  });

  it("shows a dialog that opens mid-startup on the pending row, answerable before readiness", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const harness = pendingStartController(state);
    const { start, tempId } = beginPendingStart(harness);
    reportBackendSessionId(harness, tempId);

    harness.socket.emit({ type: "dialog.opened", dialog: dialog("dialog-1") });

    expect(harness.state.current.selectedSession?.id).toBe(tempId);
    expect(harness.state.current.pendingDialogs).toEqual([dialog("dialog-1")]);
    resolveBackendSession(harness);
    await start;
  });

  it("recovers a dialog that opened before the subscription from the mid-startup status", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const harness = pendingStartController(state, {
      status: (session) => Promise.resolve(sessionLookupId(session) === BACKEND_SESSION_ID ? statusWithDialogs(BACKEND_SESSION_ID, [dialog("dialog-1")]) : status(sessionLookupId(session))),
    });
    const { start, tempId } = beginPendingStart(harness);

    reportBackendSessionId(harness, tempId);

    await vi.waitFor(() => { expect(harness.state.current.pendingDialogs).toEqual([dialog("dialog-1")]); });
    // The per-session map holds the backend session's status for the readiness
    // swap, while the row keeps its own temporary identity.
    expect(harness.state.current.sessionStatuses[BACKEND_SESSION_ID]?.pendingDialogs).toEqual([dialog("dialog-1")]);
    expect(harness.state.current.selectedSession?.id).toBe(tempId);
    resolveBackendSession(harness);
    await start;
  });

  it("tolerates a daemon that cannot serve status mid-startup", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    // Older daemons 404 the status route until the session is ready; the
    // rejection must not disturb the event-driven dialog flow.
    let createResolved = false;
    const harness = pendingStartController(state, {
      status: (session) => sessionLookupId(session) === BACKEND_SESSION_ID && !createResolved
        ? Promise.reject(new Error("Session not found"))
        : Promise.resolve(status(sessionLookupId(session))),
    });
    const { start, tempId } = beginPendingStart(harness);
    reportBackendSessionId(harness, tempId);

    harness.socket.emit({ type: "dialog.opened", dialog: dialog("dialog-1") });
    await vi.waitFor(() => { expect(harness.state.current.pendingDialogs).toEqual([dialog("dialog-1")]); });

    expect(harness.state.current.error).toBe("");
    createResolved = true;
    resolveBackendSession(harness);
    await start;
  });

  it("answers a startup dialog through the real session id and proceeds to the chat view at readiness", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const answerCalls: { sessionId: string; dialogId: string; value: unknown; machineId: string }[] = [];
    const harness = pendingStartController(state, {
      answerDialog: (session, dialogId, value, machineId) => {
        answerCalls.push({ sessionId: sessionLookupId(session), dialogId, value, machineId: machineId ?? "local" });
        return Promise.resolve(closeResponse(status(BACKEND_SESSION_ID)));
      },
    });
    const { start, tempId } = beginPendingStart(harness);
    reportBackendSessionId(harness, tempId);
    harness.socket.emit({ type: "dialog.opened", dialog: dialog("dialog-1") });

    await harness.controller.answerDialog("dialog-1", true);

    expect(answerCalls).toEqual([{ sessionId: BACKEND_SESSION_ID, dialogId: "dialog-1", value: true, machineId: "local" }]);
    expect(harness.state.current.pendingDialogs).toEqual([]);
    expect(harness.state.current.closedDialogs).toEqual([{ dialog: dialog("dialog-1"), reason: "answered", answer: true }]);
    expect(harness.state.current.error).toBe("");

    // The answer settled the hook daemon-side, so the create resolves and the
    // normal selection flow takes over the now-real session.
    resolveBackendSession(harness);
    await start;
    await vi.waitFor(() => { expect(harness.state.current.selectedSession?.id).toBe(BACKEND_SESSION_ID); });
    expect(harness.state.current.sessions.some((session) => session.id === tempId)).toBe(false);
    expect(harness.state.current.sessions.some((session) => session.id === BACKEND_SESSION_ID)).toBe(true);
  });

  it("cancels a startup dialog through the cancel route under the real session id", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const cancelCalls: { sessionId: string; dialogId: string }[] = [];
    const harness = pendingStartController(state, {
      cancelDialog: (session, dialogId) => {
        cancelCalls.push({ sessionId: sessionLookupId(session), dialogId });
        return Promise.resolve({
          result: "closed" as const,
          outcome: { dialogId, reason: "cancelled" as const, askedAt: "2026-07-20T00:00:00.000Z", closedAt: "2026-07-20T00:01:00.000Z" },
          sessionStatus: status(BACKEND_SESSION_ID),
        });
      },
    });
    const { start, tempId } = beginPendingStart(harness);
    reportBackendSessionId(harness, tempId);
    harness.socket.emit({ type: "dialog.opened", dialog: dialog("dialog-1") });

    await harness.controller.cancelDialog("dialog-1");

    expect(cancelCalls).toEqual([{ sessionId: BACKEND_SESSION_ID, dialogId: "dialog-1" }]);
    expect(harness.state.current.pendingDialogs).toEqual([]);
    expect(harness.state.current.closedDialogs).toEqual([{ dialog: dialog("dialog-1"), reason: "cancelled" }]);
    resolveBackendSession(harness);
    await start;
  });

  it("trusts the returned status when the answer loses the race", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const harness = pendingStartController(state, {
      answerDialog: () => Promise.resolve({ result: "stale", sessionStatus: statusWithDialogs(BACKEND_SESSION_ID, [dialog("dialog-2")]) }),
    });
    const { start, tempId } = beginPendingStart(harness);
    reportBackendSessionId(harness, tempId);
    harness.socket.emit({ type: "dialog.opened", dialog: dialog("dialog-1") });

    await harness.controller.answerDialog("dialog-1", true);

    expect(harness.state.current.error).toBe("");
    expect(harness.state.current.closedDialogs).toEqual([]);
    expect(harness.state.current.pendingDialogs.map((pending) => pending.dialogId)).toEqual(["dialog-2"]);
    resolveBackendSession(harness);
    await start;
  });

  it("cannot answer before startup progress names the backend session", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    let answered = false;
    const harness = pendingStartController(state, {
      answerDialog: () => {
        answered = true;
        return Promise.resolve(closeResponse(status(BACKEND_SESSION_ID)));
      },
    });
    const { start } = beginPendingStart(harness);

    await harness.controller.answerDialog("dialog-1", true);

    expect(answered).toBe(false);
    resolveBackendSession(harness);
    await start;
  });

  it("re-subscribes when the pending row is re-selected mid-startup", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] } };
    const harness = pendingStartController(state);
    const { start, tempId } = beginPendingStart(harness);
    reportBackendSessionId(harness, tempId);
    expect(harness.socket.connectedSessionIds).toEqual([BACKEND_SESSION_ID]);

    await harness.controller.selectSession(oldSession, { updateUrl: false });
    const pendingRow = harness.state.current.sessions.find((session) => session.id === tempId);
    if (pendingRow === undefined) throw new Error("Expected the pending row to stay in the session list");
    await harness.controller.selectSession(pendingRow, { updateUrl: false });

    expect(harness.socket.connectedSessionIds).toEqual([BACKEND_SESSION_ID, oldSession.id, BACKEND_SESSION_ID]);
    // Dialog state keeps flowing after the detour.
    harness.socket.emit({ type: "dialog.opened", dialog: dialog("dialog-1") });
    expect(harness.state.current.pendingDialogs).toEqual([dialog("dialog-1")]);
    resolveBackendSession(harness);
    await start;
  });

  it("does not subscribe for another browser's create", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const harness = pendingStartController(state);
    const { start } = beginPendingStart(harness);

    harness.controller.applyGlobalEvent({ type: "session.startup", startupToken: "pending-session-9-other-tab", activity: startupActivity() });
    runPendingAnimationFrames();

    expect(harness.socket.connectedSessionIds).toEqual([]);
    resolveBackendSession(harness);
    await start;
  });

  it("drops a mid-startup status snapshot that lands after the readiness swap", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const resyncRequest = deferred<SessionStatus>();
    let resyncIssued = false;
    const harness = pendingStartController(state, {
      status: (session) => {
        // The first backend status call is the subscribe-time resync; hold it
        // until after the swap. Later calls (the readiness join) answer fresh.
        if (sessionLookupId(session) === BACKEND_SESSION_ID && !resyncIssued) {
          resyncIssued = true;
          return resyncRequest.promise;
        }
        return Promise.resolve(status(sessionLookupId(session)));
      },
    });
    const { start, tempId } = beginPendingStart(harness);
    reportBackendSessionId(harness, tempId);
    harness.socket.emit({ type: "dialog.opened", dialog: dialog("dialog-1") });
    expect(harness.state.current.pendingDialogs).toEqual([dialog("dialog-1")]);

    resolveBackendSession(harness);
    await start;
    await vi.waitFor(() => { expect(harness.state.current.selectedSession?.id).toBe(BACKEND_SESSION_ID); });

    // The stale snapshot — issued before the swap and claiming dialog-1 is
    // still open — must not clobber the real session's fresher state.
    resyncRequest.resolve(statusWithDialogs(BACKEND_SESSION_ID, [dialog("dialog-1")]));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.state.current.pendingDialogs).toEqual([]);
    expect(harness.state.current.sessionStatuses[BACKEND_SESSION_ID]?.pendingDialogs ?? []).toEqual([]);
  });

  it("drops the dead card, closes the socket, and ignores late frames when the create fails mid-startup", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    let answerCalled = false;
    const harness = pendingStartController(state, {
      answerDialog: () => {
        answerCalled = true;
        return Promise.resolve(closeResponse(status(BACKEND_SESSION_ID)));
      },
    });
    const closeSpy = vi.spyOn(harness.socket, "close");
    const { start, tempId } = beginPendingStart(harness);
    reportBackendSessionId(harness, tempId);
    harness.socket.emit({ type: "dialog.opened", dialog: dialog("dialog-1") });
    expect(harness.state.current.pendingDialogs).toEqual([dialog("dialog-1")]);

    closeSpy.mockClear();
    harness.startRequest.reject(new Error("create exploded"));
    await start;

    expect(harness.state.current.error).toBe("Failed to start session: create exploded");
    expect(harness.state.current.pendingDialogs).toEqual([]);
    expect(closeSpy).toHaveBeenCalled();

    // Late frames from the dead session are dropped, and no answer can leave.
    harness.socket.emit({ type: "dialog.opened", dialog: dialog("dialog-2") });
    expect(harness.state.current.pendingDialogs).toEqual([]);
    await harness.controller.answerDialog("dialog-2", true);
    expect(answerCalled).toBe(false);
  });
});
