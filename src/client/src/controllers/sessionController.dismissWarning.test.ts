import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { defaultApi, FakeSocket, oldSession, sessionLookupId, status, workspace, type AppState, type SessionStatus } from "./sessionController.testSupport";

function machine(id: string): NonNullable<AppState["selectedMachine"]> {
  return { id, name: id, kind: "remote", createdAt: "now", updatedAt: "now" };
}

function warningStatus(sessionId: string): SessionStatus {
  return {
    ...status(sessionId),
    warnings: [{ severity: "warning", message: "subscription active", source: "anthropic", dismiss: { id: "anthropicExtraUsage" } }],
  };
}

describe("SessionController warning dismissal", () => {
  it("dismisses via the API and applies the recomputed status", async () => {
    const withWarning = warningStatus(oldSession.id);
    const withoutWarning: SessionStatus = { ...status(oldSession.id), warnings: [] };
    const dismissCalls: { sessionId: string; dismissId: string; machineId: string }[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedMachine: machine("remote-a"),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
      status: withWarning,
      sessionStatuses: { [oldSession.id]: withWarning },
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      dismissWarning: (session, dismissId, machineId) => {
        dismissCalls.push({ sessionId: sessionLookupId(session), dismissId, machineId: machineId ?? "local" });
        return Promise.resolve(withoutWarning);
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.dismissWarning("anthropicExtraUsage");

    expect(dismissCalls).toEqual([{ sessionId: oldSession.id, dismissId: "anthropicExtraUsage", machineId: "remote-a" }]);
    expect(state.status).toEqual(withoutWarning);
    expect(state.sessionStatuses[oldSession.id]).toEqual(withoutWarning);
  });

  it("reports dismissal failures through the application error state", async () => {
    const withWarning = warningStatus(oldSession.id);
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
      status: withWarning,
      sessionStatuses: { [oldSession.id]: withWarning },
    };
    const api: typeof defaultApi = { ...defaultApi, dismissWarning: () => Promise.reject(new Error("dismiss failed")) };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.dismissWarning("anthropicExtraUsage");

    expect(state.error).toBe("Error: dismiss failed");
    expect(state.status).toBe(withWarning);
  });
});
