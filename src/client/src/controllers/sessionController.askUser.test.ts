import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { loadAskDraft, saveAskDraft } from "../askDrafts";
import type { AskUserRequest, MessagePage } from "../api";
import { SessionController, type SessionControllerDependencies, type SessionEventSocket } from "./sessionController";
import { defaultApi, EmitSocket, FakeSocket, MemoryStorage, oldSession, runPendingAnimationFrames, sessionKey, status, workspace, type AppState } from "./sessionController.testSupport";

const ask: AskUserRequest = {
  askId: "ask-1",
  askedAt: "2026-07-20T00:00:00.000Z",
  questions: [{ id: "q1", question: "Which database?", options: [{ value: "pg", label: "Postgres" }] }],
};
const questionMessage = {
  role: "toolResult",
  toolName: "ask_user",
  toolCallId: "ask-call-1",
  content: [{ type: "text", text: "Posted questions." }],
  details: { ask },
  isError: false,
};
const questionPage: MessagePage = { messages: [questionMessage], start: 0, total: 1 };

function selectedSessionState(patch: Partial<AppState> = {}): AppState {
  return { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession], ...patch };
}

function controllerHarness(api: typeof defaultApi = defaultApi, socket: SessionEventSocket = new FakeSocket(), callbacks: Pick<SessionControllerDependencies, "onAskResponseAccepted"> = {}) {
  let state = selectedSessionState();
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    { api, socket, ...callbacks },
  );
  return { controller, state: () => state };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
});

describe("SessionController question transcript", () => {
  it("rehydrates questions from history without question state in status", async () => {
    const h = controllerHarness({
      ...defaultApi,
      transcriptSnapshot: () => Promise.resolve({ page: questionPage, status: status(oldSession.id), seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    });
    try {
      await h.controller.selectSession(oldSession, { updateUrl: false });
      expect(h.state().messages.flatMap((message) => message.parts)).toContainEqual({ type: "askUserQuestion", ask });
      expect(h.state()).not.toHaveProperty("pendingAsk");

      const before = h.state().messages;
      h.controller.applySessionStatus(status(oldSession.id));
      expect(h.state().messages).toBe(before);
    } finally {
      h.controller.dispose();
    }
  });

  it("receives questions and subsequent human messages through ordinary transcript events", async () => {
    const socket = new EmitSocket();
    const h = controllerHarness({
      ...defaultApi,
      transcriptSnapshot: () => Promise.resolve({ page: { messages: [], start: 0, total: 0 }, status: status(oldSession.id), seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    }, socket);
    try {
      await h.controller.selectSession(oldSession, { updateUrl: false });
      socket.emit({ type: "tool.end", toolName: "ask_user", toolCallId: "ask-call-1", text: "Posted questions.", isError: false, details: { ask } });
      socket.emit({ type: "message.end", message: questionMessage });
      runPendingAnimationFrames();
      expect(h.state().messages.flatMap((message) => message.parts).filter((part) => part.type === "askUserQuestion")).toEqual([{ type: "askUserQuestion", ask }]);

      socket.emit({ type: "message.append", message: { role: "user", content: "Use SQLite instead." } });
      runPendingAnimationFrames();
      expect(h.state().messages.at(-1)?.parts).toEqual([{ type: "text", text: "Use SQLite instead." }]);
      expect(h.state().messages.flatMap((message) => message.parts)).toContainEqual({ type: "askUserQuestion", ask });
    } finally {
      h.controller.dispose();
    }
  });
});

describe("SessionController question responses", () => {
  it("sends answers without a pending slot, clears the draft, and applies status", async () => {
    const calls: { askId: string; answers: unknown; machineId: string }[] = [];
    const returnedStatus = { ...status(oldSession.id), isStreaming: true };
    const accepted = vi.fn();
    const h = controllerHarness({
      ...defaultApi,
      submitAsk: (_session, askId, submission, machineId) => {
        calls.push({ askId, answers: submission.answers, machineId: machineId ?? "local" });
        return Promise.resolve(returnedStatus);
      },
    }, new FakeSocket(), { onAskResponseAccepted: accepted });
    saveAskDraft(sessionKey(oldSession.id), ask.askId, { q1: { values: ["pg"] } });
    try {
      await h.controller.submitAsk(ask.askId, { answers: [{ id: "q1", values: ["pg"] }] });
      expect(calls).toEqual([{ askId: ask.askId, answers: [{ id: "q1", values: ["pg"] }], machineId: "local" }]);
      expect(loadAskDraft(sessionKey(oldSession.id), ask.askId)).toEqual({});
      expect(h.state().status).toEqual(returnedStatus);
      expect(accepted).toHaveBeenCalledExactlyOnceWith("local", oldSession.id, ask.askId);
    } finally {
      h.controller.dispose();
    }
  });

  it("records skips through the existing route", async () => {
    const calls: string[] = [];
    const h = controllerHarness({ ...defaultApi, cancelAsk: (_session, askId) => {
      calls.push(askId);
      return Promise.resolve(status(oldSession.id));
    } });
    saveAskDraft(sessionKey(oldSession.id), ask.askId, { q1: { values: ["pg"] } });
    try {
      await h.controller.cancelAsk(ask.askId);
      expect(calls).toEqual([ask.askId]);
      expect(loadAskDraft(sessionKey(oldSession.id), ask.askId)).toEqual({});
    } finally {
      h.controller.dispose();
    }
  });

  it("does not suppress two human responses to the same request", async () => {
    const calls: unknown[] = [];
    const h = controllerHarness({ ...defaultApi, submitAsk: (_session, askId, submission) => {
      calls.push({ askId, answers: submission.answers });
      return Promise.resolve(status(oldSession.id));
    } });
    try {
      await h.controller.submitAsk(ask.askId, { answers: [{ id: "q1", values: ["pg"] }] });
      await h.controller.submitAsk(ask.askId, { answers: [{ id: "q1", values: [], otherText: "SQLite" }] });
      expect(calls).toHaveLength(2);
    } finally {
      h.controller.dispose();
    }
  });

  it("keeps the draft and reports a failed submission", async () => {
    const accepted = vi.fn();
    const h = controllerHarness({ ...defaultApi, submitAsk: () => Promise.reject(new Error("submit failed")) }, new FakeSocket(), { onAskResponseAccepted: accepted });
    saveAskDraft(sessionKey(oldSession.id), ask.askId, { q1: { values: ["pg"] } });
    try {
      await h.controller.submitAsk(ask.askId, { answers: [{ id: "q1", values: ["pg"] }] });
      expect(Object.values(h.state().browserErrors).map((error) => error.message)).toContain("Error: submit failed");
      expect(loadAskDraft(sessionKey(oldSession.id), ask.askId)).toEqual({ q1: { values: ["pg"] } });
      expect(accepted).not.toHaveBeenCalled();
    } finally {
      h.controller.dispose();
    }
  });

  it("does not submit for an archived session", async () => {
    const archived = { ...oldSession, archived: true as const };
    let state = selectedSessionState({ selectedSession: archived, sessions: [archived] });
    let submitted = false;
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, {
      api: { ...defaultApi, submitAsk: () => {
        submitted = true;
        return Promise.resolve(status(oldSession.id));
      } },
      socket: new FakeSocket(),
    });
    try {
      await controller.submitAsk(ask.askId, { answers: [] });
      expect(submitted).toBe(false);
    } finally {
      controller.dispose();
    }
  });
});
