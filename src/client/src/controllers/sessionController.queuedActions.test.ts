import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, FakeSocket, oldSession, replacementSession, status, type AppState, type SessionStatus } from "./sessionController.testSupport";
import { loadDraft } from "../promptDraftStorage";
import { machineSessionKey } from "../machineKeys";

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
});

function setup() {
  let state: AppState = { ...initialAppState(), selectedSession: oldSession, status: status(oldSession.id), sessions: [oldSession] };
  const request = deferred<SessionStatus>();
  const mutateQueuedMessage = vi.fn().mockReturnValue(request.promise);
  const replacePromptEditorText = vi.fn();
  const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, { api: { ...defaultApi, mutateQueuedMessage }, socket: new FakeSocket(), replacePromptEditorText });
  return { controller, request, mutateQueuedMessage, replacePromptEditorText, state: () => state, selectOther: () => { state = { ...state, selectedSession: replacementSession, status: status(replacementSession.id) }; } };
}
const queue = [{ kind: "followUp" as const, text: "restore me" }];

describe("queued message mutation controller", () => {
  it("restores a recalled message only after successful mutation", async () => {
    const test = setup();
    const pending = test.controller.mutateQueuedMessage("edit", 0, queue);
    expect(test.replacePromptEditorText).not.toHaveBeenCalled();
    test.request.resolve(status(oldSession.id));
    await pending;
    expect(test.mutateQueuedMessage).toHaveBeenCalledWith(oldSession, { action: "edit", index: 0, expectedQueue: queue }, "local");
    expect(test.replacePromptEditorText).toHaveBeenCalledWith({ machineId: "local", sessionId: oldSession.id, text: "restore me" });
  });

  it("does not overwrite the newly selected session's composer", async () => {
    const test = setup();
    const pending = test.controller.mutateQueuedMessage("edit", 0, queue);
    test.selectOther();
    test.request.resolve(status(oldSession.id));
    await pending;
    expect(test.replacePromptEditorText).not.toHaveBeenCalled();
    expect(test.state().status?.sessionId).toBe(replacementSession.id);
    expect(loadDraft(machineSessionKey("local", oldSession.id))).toBe("restore me");
  });

  it("preserves the composer when a stale mutation fails", async () => {
    const test = setup();
    const pending = test.controller.mutateQueuedMessage("edit", 0, queue);
    test.request.reject(new Error("Queue changed"));
    await pending;
    expect(test.replacePromptEditorText).not.toHaveBeenCalled();
    expect(loadDraft(machineSessionKey("local", oldSession.id))).toBe("");
  });
});
