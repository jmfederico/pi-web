import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { defaultApi, FakeSocket, oldSession, sessionLookupId, workspace, type AppState } from "./sessionController.testSupport";

const catalogModels = [
  { provider: "openai", id: "gpt-5", enabled: true },
  { provider: "anthropic", id: "claude-sonnet-4-5", enabled: true },
  { provider: "openai", id: "gpt-4o", enabled: false },
];

function machine(id: string): NonNullable<AppState["selectedMachine"]> {
  return { id, name: id, kind: "remote", createdAt: "now", updatedAt: "now" };
}

function controllerWithApi(state: AppState, setState: (patch: Partial<AppState>) => void, api: typeof defaultApi): SessionController {
  return new SessionController(
    () => state,
    setState,
    () => undefined,
    undefined,
    { api, socket: new FakeSocket() },
  );
}

describe("SessionController model catalog", () => {
  it("lists the machine's catalog with per-model enabled state", async () => {
    const calls: { sessionId: string; machineId: string }[] = [];
    let state: AppState = { ...initialAppState(), selectedMachine: machine("remote-a"), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      modelCatalog: (session, machineId) => {
        calls.push({ sessionId: sessionLookupId(session), machineId: machineId ?? "local" });
        return Promise.resolve({ models: catalogModels });
      },
    };
    const controller = controllerWithApi(state, (patch) => { state = { ...state, ...patch }; }, api);

    const models = await controller.listModelCatalog();

    expect(calls).toEqual([{ sessionId: oldSession.id, machineId: "remote-a" }]);
    expect(models).toEqual(catalogModels);
  });

  it("reports catalog listing failures through the application error state", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = { ...defaultApi, modelCatalog: () => Promise.reject(new Error("catalog failed")) };
    const controller = controllerWithApi(state, (patch) => { state = { ...state, ...patch }; }, api);

    const models = await controller.listModelCatalog();

    expect(models).toEqual([]);
    expect(Object.values(state.browserErrors).map((error) => error.message)).toContain("Error: catalog failed");
  });

  it("toggles one model's membership and returns the fresh catalog", async () => {
    const calls: { provider: string; modelId: string; enabled: boolean; machineId: string }[] = [];
    let state: AppState = { ...initialAppState(), selectedMachine: machine("remote-a"), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      setModelEnabled: (session, provider, modelId, enabled, machineId) => {
        calls.push({ provider, modelId, enabled, machineId: machineId ?? "local" });
        return Promise.resolve({ models: catalogModels.map((model) => model.id === "gpt-4o" ? { ...model, enabled: true } : model) });
      },
    };
    const controller = controllerWithApi(state, (patch) => { state = { ...state, ...patch }; }, api);

    const models = await controller.setModelEnabled("openai", "gpt-4o", true);

    expect(calls).toEqual([{ provider: "openai", modelId: "gpt-4o", enabled: true, machineId: "remote-a" }]);
    expect(models?.find((model) => model.id === "gpt-4o")?.enabled).toBe(true);
    expect(state.error).toBe("");
  });

  it("atomically sets the model scope preset on the selected machine", async () => {
    const calls: { mode: "all" | "current"; machineId: string }[] = [];
    let state: AppState = { ...initialAppState(), selectedMachine: machine("remote-a"), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      setModelScope: (_session, mode, machineId) => {
        calls.push({ mode, machineId: machineId ?? "local" });
        return Promise.resolve({ models: catalogModels });
      },
    };
    const controller = controllerWithApi(state, (patch) => { state = { ...state, ...patch }; }, api);

    await expect(controller.setModelScope("current")).resolves.toEqual(catalogModels);

    expect(calls).toEqual([{ mode: "current", machineId: "remote-a" }]);
  });

  it("returns undefined for a failed toggle so the dialog can keep the row's state", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = { ...defaultApi, setModelEnabled: () => Promise.reject(new Error("toggle failed")) };
    const controller = controllerWithApi(state, (patch) => { state = { ...state, ...patch }; }, api);

    const models = await controller.setModelEnabled("openai", "gpt-4o", true);

    expect(models).toBeUndefined();
    expect(Object.values(state.browserErrors).map((error) => error.message)).toContain("Error: toggle failed");
  });

  it("reports scope preset failures through the application error state", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = { ...defaultApi, setModelScope: () => Promise.reject(new Error("scope failed")) };
    const controller = controllerWithApi(state, (patch) => { state = { ...state, ...patch }; }, api);

    await expect(controller.setModelScope("all")).resolves.toBeUndefined();
    expect(Object.values(state.browserErrors).map((error) => error.message)).toContain("Error: scope failed");
  });

  it("lists and toggles nothing without a selected session", async () => {
    let state: AppState = initialAppState();
    const api: typeof defaultApi = {
      ...defaultApi,
      modelCatalog: () => { throw new Error("must not be called"); },
      setModelEnabled: () => { throw new Error("must not be called"); },
      setModelScope: () => { throw new Error("must not be called"); },
    };
    const controller = controllerWithApi(state, (patch) => { state = { ...state, ...patch }; }, api);

    expect(await controller.listModelCatalog()).toEqual([]);
    expect(await controller.setModelEnabled("openai", "gpt-4o", true)).toBeUndefined();
    expect(await controller.setModelScope("current")).toBeUndefined();
    expect(state.error).toBe("");
  });
});
