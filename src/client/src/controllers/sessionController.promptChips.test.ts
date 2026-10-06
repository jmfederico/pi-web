import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { emptyTranscriptApi, deferred, FakeSocket, oldSession, workspace, type AppState, type SessionInfo } from "./sessionController.testSupport";

const target = { machineId: "local", sessionId: oldSession.id };

describe("chip-bearing prompt delivery", () => {
  it("rejects stale machine/conversation targets and archived sessions without submitting", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession };
    const prompt = vi.fn<typeof emptyTranscriptApi.prompt>();
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, { api: { ...emptyTranscriptApi, prompt }, socket: new FakeSocket() });
    expect(await controller.send("context", undefined, undefined, "inline", undefined, { ...target, machineId: "other" })).toBe(false);
    expect(await controller.send("context", undefined, undefined, "inline", undefined, { ...target, sessionId: "other" })).toBe(false);
    state = { ...state, selectedSession: { ...oldSession, archived: true } };
    expect(await controller.send("context", undefined, undefined, "inline", undefined, target)).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not treat the browser's pending-session queue as chip submission acceptance", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace };
    const creating = deferred<SessionInfo>();
    const prompt = vi.fn<typeof emptyTranscriptApi.prompt>().mockResolvedValue({ accepted: true });
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, { api: { ...emptyTranscriptApi, startSession: () => creating.promise, prompt }, socket: new FakeSocket() });
    const start = controller.startSession();
    const pendingId = state.selectedSession?.id;
    if (pendingId === undefined) throw new Error("Missing pending session");
    expect(await controller.send("context", undefined, undefined, "inline", undefined, { ...target, sessionId: pendingId })).toBe(false);
    expect(state.clientQueuedSessionMessages).toEqual({});
    creating.resolve(oldSession);
    await start;
    expect(prompt).not.toHaveBeenCalled();
    controller.dispose();
  });
});
