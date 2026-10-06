import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { NetworkRequestError } from "../api/http";
import type { PendingExtensionDialog, SessionTranscriptSnapshot } from "../api";
import type { SessionUiEvent } from "../sessionSocket";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, EmitSocket, oldSession, replacementSession, runPendingAnimationFrames, status, workspace, type AppState } from "./sessionController.testSupport";

const oldPage = {
  messages: [
    { role: "user", content: "first question" },
    { role: "assistant", content: [{ type: "text", text: "previous answer" }] },
  ],
  start: 0,
  total: 2,
};

function snapshot(overrides: Partial<SessionTranscriptSnapshot> = {}): SessionTranscriptSnapshot {
  return { page: oldPage, status: status(oldSession.id), seq: 10, partial: null, ...overrides };
}

function harness() {
  const socket = new EmitSocket();
  let nextSnapshot = Promise.resolve(snapshot());
  let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession, replacementSession] };
  const transcriptSnapshot = vi.fn(() => nextSnapshot);
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    { socket, api: { ...defaultApi, transcriptSnapshot, thinkingLevels: () => Promise.resolve({ levels: [] }) } },
  );
  return {
    socket, controller, transcriptSnapshot,
    state: () => state,
    nextSnapshot: (next: Promise<SessionTranscriptSnapshot>) => { nextSnapshot = next; },
  };
}

function secondUserEvent(seq = 12): SessionUiEvent {
  return { type: "message.append", message: { role: "user", content: "second question" }, seq };
}

const twoTurns = [
  { role: "user", parts: [{ type: "text", text: "first question" }] },
  { role: "assistant", parts: [{ type: "text", text: "previous answer" }] },
  { role: "user", parts: [{ type: "text", text: "second question" }] },
  { role: "assistant", parts: [{ type: "text", text: "new answer" }] },
];

const secondQuestionPage = {
  ...oldPage,
  messages: [...oldPage.messages, { role: "user", content: "second question" }],
  total: 3,
};

const streamingStatus = { ...status(oldSession.id), isStreaming: true };

function partial(text: string): unknown {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("SessionController snapshot reconciliation", () => {
  it.each(["queued", "fetching"] as const)("preserves a new turn while a refresh is %s", async (phase) => {
    const h = harness();
    try {
      await h.controller.selectSession(oldSession, { updateUrl: false });
      const response = deferred<SessionTranscriptSnapshot>();
      h.nextSnapshot(response.promise);
      const refresh = h.controller.refreshSelectedSession();
      if (phase === "fetching") await Promise.resolve();
      h.socket.emit(secondUserEvent());
      h.socket.emit({ type: "assistant.delta", text: "new answer", seq: 13 });
      runPendingAnimationFrames();
      // Events stay buffered even if a paint occurs before the HTTP response.
      expect(h.state().messages).toHaveLength(2);
      response.resolve(snapshot());
      await refresh;
      runPendingAnimationFrames();
      expect(h.state().messages).toEqual(twoTurns);
    } finally {
      h.controller.dispose();
    }
  });

  it("reconciles events around both responses when a refresh requests a trailing pass", async () => {
    const h = harness();
    try {
      await h.controller.selectSession(oldSession, { updateUrl: false });
      const first = deferred<SessionTranscriptSnapshot>();
      const trailing = deferred<SessionTranscriptSnapshot>();
      const trailingStarted = deferred<undefined>();
      h.transcriptSnapshot.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => {
        trailingStarted.resolve(undefined);
        return trailing.promise;
      });
      const firstRefresh = h.controller.refreshSelectedSession();
      await Promise.resolve();
      h.socket.emit(secondUserEvent());
      h.socket.emit({ type: "assistant.delta", text: "new", seq: 13 });
      const trailingRefresh = h.controller.refreshSelectedSession();
      first.resolve(snapshot());
      await trailingStarted.promise;
      h.socket.emit({ type: "assistant.delta", text: " answer", seq: 14 });
      trailing.resolve(snapshot({ page: secondQuestionPage, status: streamingStatus, seq: 13, partial: partial("new") }));
      await Promise.all([firstRefresh, trailingRefresh]);
      runPendingAnimationFrames();
      expect(h.transcriptSnapshot).toHaveBeenCalledTimes(3);
      expect(h.state().messages).toEqual(twoTurns);
    } finally {
      h.controller.dispose();
    }
  });

  it("keeps live output and dialogs visible during backoff, even when another caller requests a refresh", async () => {
    vi.useFakeTimers();
    const h = harness();
    const dialog: PendingExtensionDialog = { dialogId: "retry-dialog", kind: "confirm", title: "Continue?", askedAt: "now", runScoped: true };
    try {
      await h.controller.selectSession(oldSession, { updateUrl: false });
      const failedRead = deferred<SessionTranscriptSnapshot>();
      h.transcriptSnapshot.mockImplementationOnce(() => failedRead.promise);
      const recoveredSnapshot = snapshot({
        page: secondQuestionPage, status: { ...streamingStatus, pendingDialogs: [dialog] }, seq: 14, partial: partial("new answer"),
      });
      h.nextSnapshot(Promise.resolve(recoveredSnapshot));
      const refresh = h.controller.refreshSelectedSession(undefined, { recoverNetwork: true });
      await vi.advanceTimersByTimeAsync(0);
      h.socket.emit(secondUserEvent());
      failedRead.reject(new NetworkRequestError("Load failed"));
      await vi.advanceTimersByTimeAsync(0);
      runPendingAnimationFrames();
      expect(h.state().messages).toHaveLength(3);

      const coalesced = h.controller.refreshSelectedSession(undefined, { recoverNetwork: true });
      h.socket.emit({ type: "assistant.delta", text: "new answer", seq: 13 });
      h.socket.emit({ type: "dialog.opened", dialog, seq: 14 });
      runPendingAnimationFrames();
      expect(h.state().messages).toEqual(twoTurns);
      expect(h.state().pendingDialogs).toEqual([dialog]);
      expect(h.state().browserErrors).toEqual({});

      await vi.advanceTimersByTimeAsync(500);
      await Promise.all([refresh, coalesced]);
      runPendingAnimationFrames();
      expect(h.state().messages).toEqual(twoTurns);
      expect(h.state().pendingDialogs).toEqual([dialog]);
      expect(h.state().browserErrors).toEqual({});
    } finally {
      h.controller.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps streaming events and dialogs after exhausting HTTP recovery", async () => {
    vi.useFakeTimers();
    const h = harness();
    const dialog: PendingExtensionDialog = { dialogId: "retry-dialog", kind: "confirm", title: "Continue?", askedAt: "now", runScoped: true };
    try {
      await h.controller.selectSession(oldSession, { updateUrl: false });
      h.transcriptSnapshot.mockRejectedValue(new NetworkRequestError("Load failed"));
      const refresh = h.controller.refreshSelectedSession(undefined, { recoverNetwork: true });
      await vi.advanceTimersByTimeAsync(0);
      h.socket.emit(secondUserEvent());
      h.socket.emit({ type: "assistant.delta", text: "new answer", seq: 13 });
      h.socket.emit({ type: "dialog.opened", dialog, seq: 14 });
      runPendingAnimationFrames();
      expect(h.state().messages).toEqual(twoTurns);
      expect(h.state().pendingDialogs).toEqual([dialog]);
      await vi.runAllTimersAsync();
      await refresh;
      runPendingAnimationFrames();
      expect(h.state().messages).toEqual(twoTurns);
      expect(h.state().pendingDialogs).toEqual([dialog]);
      expect(Object.values(h.state().browserErrors).map((error) => error.recovery)).toEqual(["session-refresh"]);
    } finally {
      h.controller.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps events received during a failed initial join and continues streaming", async () => {
    const h = harness();
    try {
      const response = deferred<SessionTranscriptSnapshot>();
      h.nextSnapshot(response.promise);
      const joining = h.controller.selectSession(oldSession, { updateUrl: false });
      h.socket.emit(secondUserEvent());
      h.socket.emit({ type: "assistant.delta", text: "new", seq: 13 });
      response.reject(new Error("join failed"));
      await joining;
      h.socket.emit({ type: "assistant.delta", text: " answer", seq: 14 });
      runPendingAnimationFrames();
      expect(h.state().messages.slice(-2)).toEqual(twoTurns.slice(-2));
      expect(Object.values(h.state().browserErrors).map((error) => error.message)).toContain("Error: join failed");
    } finally {
      h.controller.dispose();
    }
  });

  it("does not replay a user message or partial already included in the snapshot", async () => {
    const h = harness();
    try {
      await h.controller.selectSession(oldSession, { updateUrl: false });
      const response = deferred<SessionTranscriptSnapshot>();
      h.nextSnapshot(response.promise);
      const refresh = h.controller.refreshSelectedSession();
      h.socket.emit(secondUserEvent());
      h.socket.emit({ type: "assistant.delta", text: "new", seq: 13 });
      h.socket.emit({ type: "assistant.delta", text: " answer", seq: 14 });
      response.resolve(snapshot({ page: secondQuestionPage, status: streamingStatus, seq: 13, partial: partial("new") }));
      await refresh;
      runPendingAnimationFrames();
      expect(h.state().messages).toEqual(twoTurns);
    } finally {
      h.controller.dispose();
    }
  });

  it("restores messages missed during a disconnect while replaying the continuing response", async () => {
    const h = harness();
    try {
      await h.controller.selectSession(oldSession, { updateUrl: false });
      const response = deferred<SessionTranscriptSnapshot>();
      h.nextSnapshot(response.promise);
      h.socket.reconnect();
      // Same-turn requests share the reconnect refresh, exposing its completion.
      const refresh = h.controller.refreshSelectedSession();
      h.socket.emit({ type: "assistant.delta", text: " answer", seq: 14 });
      response.resolve(snapshot({ page: secondQuestionPage, status: streamingStatus, seq: 13, partial: partial("new") }));
      await refresh;
      runPendingAnimationFrames();
      expect(h.transcriptSnapshot).toHaveBeenCalledTimes(2);
      expect(h.state().messages).toEqual(twoTurns);
    } finally {
      h.controller.dispose();
    }
  });

  it("resets the event watermark after a daemon restart even when history is unchanged", async () => {
    const h = harness();
    try {
      await h.controller.selectSession(oldSession, { updateUrl: false });
      h.nextSnapshot(Promise.resolve(snapshot({ seq: 1 })));
      h.socket.reconnect();
      const refresh = h.controller.refreshSelectedSession();
      h.socket.emit(secondUserEvent(2));
      h.socket.emit({ type: "assistant.delta", text: "new answer", seq: 3 });
      await refresh;
      runPendingAnimationFrames();
      expect(h.state().messages).toEqual(twoTurns);
    } finally {
      h.controller.dispose();
    }
  });

  it("replays buffered events after a failed refresh and keeps the socket live", async () => {
    const h = harness();
    try {
      await h.controller.selectSession(oldSession, { updateUrl: false });
      const response = deferred<SessionTranscriptSnapshot>();
      h.nextSnapshot(response.promise);
      const refresh = h.controller.refreshSelectedSession();
      h.socket.emit(secondUserEvent());
      h.socket.emit({ type: "assistant.delta", text: "new", seq: 13 });
      response.reject(new Error("snapshot unavailable"));
      await refresh;
      h.socket.emit({ type: "assistant.delta", text: " answer", seq: 14 });
      runPendingAnimationFrames();
      expect(h.state().messages).toEqual(twoTurns);
      expect(Object.values(h.state().browserErrors).map((error) => error.message)).toContain("Error: snapshot unavailable");

      h.nextSnapshot(Promise.resolve(snapshot({ page: secondQuestionPage, status: streamingStatus, seq: 14, partial: partial("new answer") })));
      await h.controller.refreshSelectedSession();
      expect(h.state().messages).toEqual(twoTurns);
    } finally {
      h.controller.dispose();
    }
  });

  it.each([false, true])("preserves dialog outcomes captured before the snapshot (opened during refresh: %s)", async (openedDuringRefresh) => {
    const h = harness();
    const dialog: PendingExtensionDialog = { dialogId: "dialog-1", kind: "confirm", title: "Continue?", askedAt: "2026-07-20T00:00:00.000Z", runScoped: true };
    try {
      h.nextSnapshot(Promise.resolve(snapshot({ status: { ...status(oldSession.id), pendingDialogs: openedDuringRefresh ? [] : [dialog] } })));
      await h.controller.selectSession(oldSession, { updateUrl: false });
      const response = deferred<SessionTranscriptSnapshot>();
      h.nextSnapshot(response.promise);
      const refresh = h.controller.refreshSelectedSession();
      if (openedDuringRefresh) h.socket.emit({ type: "dialog.opened", dialog, seq: 11 });
      h.socket.emit({ type: "dialog.closed", dialogId: dialog.dialogId, reason: "answered", answer: true, seq: 12 });
      // The global channel can remove the open card before the response arrives.
      h.controller.applyGlobalEvent({ type: "status.update", status: status(oldSession.id) });
      runPendingAnimationFrames();
      response.resolve(snapshot({ seq: 13, status: streamingStatus }));
      await refresh;
      expect(h.state().pendingDialogs).toEqual([]);
      expect(h.state().closedDialogs).toEqual([{ dialog, reason: "answered", answer: true }]);
    } finally {
      h.controller.dispose();
    }
  });

  it("preserves event-only errors and names that are not represented by a snapshot", async () => {
    const h = harness();
    try {
      await h.controller.selectSession(oldSession, { updateUrl: false });
      const response = deferred<SessionTranscriptSnapshot>();
      h.nextSnapshot(response.promise);
      const refresh = h.controller.refreshSelectedSession();
      h.socket.emit({ type: "session.error", message: "prompt failed", seq: 11 });
      h.socket.emit({ type: "session.name", sessionId: oldSession.id, name: "New name", seq: 12 });
      response.resolve(snapshot({ status: streamingStatus, seq: 13 }));
      await refresh;
      expect(h.state().messages.at(-1)).toEqual({ role: "system", parts: [{ type: "text", text: "prompt failed" }] });
      expect(h.state().selectedSession?.name).toBe("New name");
    } finally {
      h.controller.dispose();
    }
  });

  it("does not replay a retired refresh's events into a newly selected session", async () => {
    const h = harness();
    try {
      await h.controller.selectSession(oldSession, { updateUrl: false });
      const response = deferred<SessionTranscriptSnapshot>();
      h.nextSnapshot(response.promise);
      const refresh = h.controller.refreshSelectedSession();
      await Promise.resolve();
      h.socket.emit(secondUserEvent());
      h.nextSnapshot(Promise.resolve(snapshot({ page: { messages: [{ role: "user", content: "replacement" }], start: 0, total: 1 }, status: status(replacementSession.id) })));
      await h.controller.selectSession(replacementSession, { updateUrl: false });
      response.resolve(snapshot());
      await refresh;
      runPendingAnimationFrames();
      expect(h.state().selectedSession?.id).toBe(replacementSession.id);
      expect(h.state().messages).toEqual([{ role: "user", parts: [{ type: "text", text: "replacement" }] }]);
    } finally {
      h.controller.dispose();
    }
  });

  it.each([false, true])("does not duplicate live text already received before refreshing (painted: %s)", async (painted) => {
    const h = harness();
    try {
      await h.controller.selectSession(oldSession, { updateUrl: false });
      h.socket.emit(secondUserEvent());
      h.socket.emit({ type: "assistant.delta", text: "new", seq: 13 });
      if (painted) runPendingAnimationFrames();
      h.nextSnapshot(Promise.resolve(snapshot({ page: secondQuestionPage, status: streamingStatus, seq: 13, partial: partial("new") })));
      await h.controller.refreshSelectedSession();
      h.socket.emit({ type: "assistant.delta", text: " answer", seq: 14 });
      runPendingAnimationFrames();
      expect(h.state().messages).toEqual(twoTurns);
    } finally {
      h.controller.dispose();
    }
  });
});
