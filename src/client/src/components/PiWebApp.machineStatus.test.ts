import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../appState";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { MachineStatusController } from "../controllers/machineStatusController";
import { machineStatusSnapshot } from "../machineStatus.testSupport";
import { PiWebApp } from "./PiWebApp";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp machine status snapshot refresh", () => {
  it("applies every reachable machine's snapshot when one machine's status request fails", async () => {
    const app = createApp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const local = machineStatusSnapshot({ machine: { "core:working": true } });
    refreshMachines(app, ["local", "remote-1"]);
    useStatusApi(app, (machineId) => machineId === "local"
      ? Promise.resolve(local)
      : Promise.reject(new Error("Not Found")));

    await refreshMachineStatusSnapshots(app);

    expect(appState(app).machineStatusSnapshots).toEqual({ local });
    expect(appState(app).error).toBe("");
    expect(warn).toHaveBeenCalledWith("Failed to refresh machine status for remote-1", expect.any(Error));
  });
});

function createApp(): PiWebApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebApp();
}

/**
 * Fixes the machines the refresh iterates over. Which machines are eligible is
 * health-driven and covered separately; this test is about what happens to the
 * others when one of them fails.
 */
function refreshMachines(app: PiWebApp, machineIds: string[]): void {
  if (!Reflect.set(app, "refreshableMachineIds", () => machineIds)) throw new Error("Could not replace PiWebApp.refreshableMachineIds");
}

/** Drives the app's real controller and state through the controller's api seam. */
function useStatusApi(app: PiWebApp, machineStatus: (machineId: string) => Promise<MachineStatusSnapshot>): void {
  const controller = new MachineStatusController(() => appState(app), (patch) => { setAppState(app, patch); }, { api: { machineStatus } });
  if (!Reflect.set(app, "machineStatus", controller)) throw new Error("Could not replace PiWebApp's MachineStatusController");
}

async function refreshMachineStatusSnapshots(app: PiWebApp): Promise<void> {
  const refresh: unknown = Reflect.get(app, "refreshMachineStatusSnapshots");
  if (typeof refresh !== "function") throw new Error("PiWebApp.refreshMachineStatusSnapshots is not callable");
  await Reflect.apply(refresh, app, []);
}

function appState(app: PiWebApp): AppState {
  const state: unknown = Reflect.get(app, "state");
  if (!isAppState(state)) throw new Error("PiWebApp state was unavailable");
  return state;
}

function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null && "machineStatusSnapshots" in value && "error" in value;
}

function setAppState(app: PiWebApp, patch: Partial<AppState>): void {
  const setState: unknown = Reflect.get(app, "setState");
  if (typeof setState !== "function") throw new Error("PiWebApp.setState is not callable");
  Reflect.apply(setState, app, [patch]);
}
