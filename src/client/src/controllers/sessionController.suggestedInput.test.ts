import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { machineSessionKey } from "../machineKeys";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import { SessionController } from "./sessionController";
import { FakeSocket, MemoryStorage, oldSession, replacementSession, status, type AppState } from "./sessionController.testSupport";

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
});

describe("SessionController explicit suggested input use", () => {
  it.each(["use this\nverbatim  ", ""])("saves and replaces the current editor only when requested (%s)", async (suggestedInput) => {
    const key = machineSessionKey("local", oldSession.id);
    saveDraft(key, "unsent draft");
    let state: AppState = { ...initialAppState(), selectedSession: oldSession, status: { ...status(oldSession.id), suggestedInput } };
    const replacePromptEditorText = vi.fn();
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined,
      { socket: new FakeSocket(), replacePromptEditorText });
    expect(loadDraft(key)).toBe("unsent draft");
    expect(replacePromptEditorText).not.toHaveBeenCalled();
    await controller.useSuggestedInput("local", oldSession.id);
    expect(loadDraft(key)).toBe(suggestedInput);
    expect(replacePromptEditorText).toHaveBeenCalledExactlyOnceWith({ machineId: "local", sessionId: oldSession.id, text: suggestedInput });
    // The daemon still owns the latest suggestion; use is neither send nor clear.
    expect(state.status?.suggestedInput).toBe(suggestedInput);
    expect(state.messages).toEqual([]);
    controller.dispose();
  });

  it("ignores stale targets, unavailable suggestions, mismatched status, and archived sessions", async () => {
    const key = machineSessionKey("local", oldSession.id);
    saveDraft(key, "protected draft");
    let state: AppState = { ...initialAppState(), selectedSession: oldSession, status: { ...status(oldSession.id), suggestedInput: "suggestion" } };
    const replacePromptEditorText = vi.fn();
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined,
      { socket: new FakeSocket(), replacePromptEditorText });
    await controller.useSuggestedInput("remote", oldSession.id);
    await controller.useSuggestedInput("local", replacementSession.id);
    state = { ...state, status: status(oldSession.id) };
    await controller.useSuggestedInput("local", oldSession.id);
    state = { ...state, status: { ...status(replacementSession.id), suggestedInput: "another session" } };
    await controller.useSuggestedInput("local", oldSession.id);
    state = { ...state, selectedSession: { ...oldSession, archived: true }, status: { ...status(oldSession.id), suggestedInput: "archived" } };
    await controller.useSuggestedInput("local", oldSession.id);
    expect(loadDraft(key)).toBe("protected draft");
    expect(replacePromptEditorText).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("reports editor replacement failure while retaining the deliberately saved draft", async () => {
    let state: AppState = { ...initialAppState(), selectedSession: oldSession, status: { ...status(oldSession.id), suggestedInput: "requested" } };
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined,
      { socket: new FakeSocket(), replacePromptEditorText: () => Promise.reject(new Error("Editor unavailable")) });
    await controller.useSuggestedInput("local", oldSession.id);
    expect(loadDraft(machineSessionKey("local", oldSession.id))).toBe("requested");
    expect(Object.values(state.browserErrors).map((error) => error.message).join("\n")).toContain("Editor unavailable");
    controller.dispose();
  });
});
