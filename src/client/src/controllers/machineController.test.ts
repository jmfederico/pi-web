import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type Machine, type MachineHealth } from "../api";
import { initialAppState, type AppState } from "../appState";
import { MachineController } from "./machineController";

const localMachine: Machine = {
  id: "local",
  name: "Local",
  kind: "local",
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
};

const remoteMachine: Machine = {
  id: "remote-1",
  name: "Remote",
  kind: "remote",
  baseUrl: "http://remote.example.test:8504",
  createdAt: "2026-05-26T00:00:00.000Z",
  updatedAt: "2026-05-26T00:00:00.000Z",
};

const offlineHealth: MachineHealth = {
  machineId: remoteMachine.id,
  ok: false,
  checkedAt: "2026-05-26T00:00:01.000Z",
  status: "offline",
  error: "Remote machine request timed out",
};

describe("MachineController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to the local machine when the routed remote machine is offline", async () => {
    let state: AppState = initialAppState();
    const setState = (patch: Partial<AppState>) => { state = { ...state, ...patch }; };
    const updateUrl = vi.fn();
    const projects = { loadProjects: vi.fn() };

    vi.spyOn(api, "machines").mockResolvedValue([localMachine, remoteMachine]);
    vi.spyOn(api, "health").mockImplementation((machineId: string) => Promise.resolve(
      machineId === remoteMachine.id
        ? offlineHealth
        : { machineId: "local", ok: true, checkedAt: "2026-05-26T00:00:01.000Z", status: "online" },
    ));

    const controller = new MachineController(() => state, setState, updateUrl, projects);

    await controller.loadMachines(remoteMachine.id);

    expect(state.selectedMachine).toEqual(localMachine);
    expect(state.machineStatuses[remoteMachine.id]).toEqual(offlineHealth);
    expect(state.error).toContain("Remote is offline");
  });

  it("records offline health when the routed remote health request rejects", async () => {
    let state: AppState = initialAppState();
    const setState = (patch: Partial<AppState>) => { state = { ...state, ...patch }; };
    const updateUrl = vi.fn();
    const projects = { loadProjects: vi.fn() };

    vi.spyOn(api, "machines").mockResolvedValue([localMachine, remoteMachine]);
    vi.spyOn(api, "health").mockRejectedValue(new Error("Internal Server Error"));

    const controller = new MachineController(() => state, setState, updateUrl, projects);

    await controller.loadMachines(remoteMachine.id);

    expect(state.selectedMachine).toEqual(localMachine);
    expect(state.machineStatuses[remoteMachine.id]).toMatchObject({ machineId: remoteMachine.id, ok: false, status: "offline", error: "Internal Server Error" });
    expect(state.error).toContain("Remote is offline");
  });
});
