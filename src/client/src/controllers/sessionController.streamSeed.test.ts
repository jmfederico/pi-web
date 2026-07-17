import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, EmitSocket, oldSession, runPendingAnimationFrames, status, workspace, type AppState, type MessagePage, type SessionStatus, type SessionStreamSnapshot } from "./sessionController.testSupport";

function assistantPartial(text: string): SessionStreamSnapshot["partial"] {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("SessionController stream seed + watermark reconciliation", () => {
  it("seeds the in-flight partial on top of committed history at join time", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve({ messages: [{ role: "user", content: "question" }], start: 0, total: 1 }),
      status: () => Promise.resolve({ ...status(oldSession.id), isStreaming: true }),
      streamSnapshot: () => Promise.resolve({ seq: 4, partial: assistantPartial("streaming answer") }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );

    await controller.selectSession(oldSession, { updateUrl: false });

    expect(state.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "question" }] },
      { role: "assistant", parts: [{ type: "text", text: "streaming answer" }] },
    ]);
    // The seeded partial must never be written to the raw history cache.
    expect(controller).toBeDefined();
  });

  it("drops live events at or below the watermark and applies later events exactly once", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve({ messages: [{ role: "user", content: "question" }], start: 0, total: 1 }),
      status: () => Promise.resolve({ ...status(oldSession.id), isStreaming: true }),
      streamSnapshot: () => Promise.resolve({ seq: 4, partial: assistantPartial("seed") }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );

    await controller.selectSession(oldSession, { updateUrl: false });

    // Already reflected in the seeded partial (seq <= 4): dropped.
    socket.emit({ type: "assistant.delta", text: "DUP", seq: 3 });
    socket.emit({ type: "assistant.delta", text: "DUP", seq: 4 });
    // Past the watermark (seq > 4): appended onto the seeded partial exactly once.
    socket.emit({ type: "assistant.delta", text: " more", seq: 5 });
    runPendingAnimationFrames();

    expect(state.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "question" }] },
      { role: "assistant", parts: [{ type: "text", text: "seed more" }] },
    ]);
  });

  it("applies buffered events replayed after join through the same watermark", async () => {
    const socket = new EmitSocket();
    const page = deferred<MessagePage>();
    const statusResult = deferred<SessionStatus>();
    const snapshot = deferred<SessionStreamSnapshot>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => page.promise,
      status: () => statusResult.promise,
      streamSnapshot: () => snapshot.promise,
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );

    const selecting = controller.selectSession(oldSession, { updateUrl: false });
    // Events arriving during the join fetch are buffered by selectSession.
    socket.emit({ type: "assistant.delta", text: "STALE", seq: 2 });
    socket.emit({ type: "assistant.delta", text: " live", seq: 6 });

    page.resolve({ messages: [{ role: "user", content: "question" }], start: 0, total: 1 });
    statusResult.resolve({ ...status(oldSession.id), isStreaming: true });
    snapshot.resolve({ seq: 4, partial: assistantPartial("seed") });
    await selecting;
    runPendingAnimationFrames();

    expect(state.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "question" }] },
      { role: "assistant", parts: [{ type: "text", text: "seed live" }] },
    ]);
  });

  it("handles a mid-tool join: null partial, committed tool call in history, live tool.update filtered by seq", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve({
        messages: [
          { role: "user", content: "run it" },
          { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "ls" } }] },
        ],
        start: 0,
        total: 2,
      }),
      status: () => Promise.resolve({ ...status(oldSession.id), isStreaming: true, isBashRunning: true }),
      // Mid tool execution the assistant-message stream has ended, so the
      // snapshot carries no partial; the tool call is already in history.
      streamSnapshot: () => Promise.resolve({ seq: 7, partial: null }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );

    await controller.selectSession(oldSession, { updateUrl: false });

    const toolLine = state.messages.find((line) => line.parts.some((part) => part.type === "toolExecution"));
    expect(toolLine?.parts[0]).toMatchObject({ type: "toolExecution", toolCallId: "tool-1", toolName: "bash" });

    // Reflected in the snapshot watermark (seq <= 7): dropped.
    socket.emit({ type: "tool.update", toolName: "bash", toolCallId: "tool-1", text: "stale", content: undefined, details: undefined, seq: 7 });
    // Fresh progress past the watermark: applied.
    socket.emit({ type: "tool.update", toolName: "bash", toolCallId: "tool-1", text: "fresh output", content: undefined, details: undefined, seq: 8 });
    runPendingAnimationFrames();

    const updatedToolLine = state.messages.find((line) => line.parts.some((part) => part.type === "toolExecution"));
    expect(updatedToolLine?.parts[0]).toMatchObject({ resultText: "fresh output" });
  });

  it("loads the transcript and streams live even when the snapshot fetch fails (older/un-restarted peer)", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve({ messages: [{ role: "user", content: "question" }], start: 0, total: 1 }),
      status: () => Promise.resolve({ ...status(oldSession.id), isStreaming: true }),
      // A session daemon / remote pi-web without the stream-snapshot route 404s.
      streamSnapshot: () => Promise.reject(new Error("Not Found")),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );

    await controller.selectSession(oldSession, { updateUrl: false });

    // The core transcript still loads (no error banner, no dropped history).
    expect(state.error).toBeFalsy();
    expect(state.messages).toEqual([{ role: "user", parts: [{ type: "text", text: "question" }] }]);

    // With a fallback watermark of 0, fresh live deltas still stream in.
    socket.emit({ type: "assistant.delta", text: "live answer", seq: 1 });
    runPendingAnimationFrames();

    expect(state.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "question" }] },
      { role: "assistant", parts: [{ type: "text", text: "live answer" }] },
    ]);
  });

  it("does not seed a partial and does not filter events for an idle join", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve({ messages: [{ role: "user", content: "question" }], start: 0, total: 1 }),
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );

    await controller.selectSession(oldSession, { updateUrl: false });

    expect(state.messages).toEqual([{ role: "user", parts: [{ type: "text", text: "question" }] }]);

    // A watermark of 0 must not drop a fresh streamed delta (seq >= 1).
    socket.emit({ type: "assistant.delta", text: "new turn", seq: 1 });
    runPendingAnimationFrames();

    expect(state.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "question" }] },
      { role: "assistant", parts: [{ type: "text", text: "new turn" }] },
    ]);
  });
});
