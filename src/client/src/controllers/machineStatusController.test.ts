import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { machineStatusSnapshot as snapshot } from "../machineStatus.testSupport";
import { MachineStatusController } from "./machineStatusController";

describe("MachineStatusController", () => {
  it("stores each machine's snapshot under its own id without mirroring the selected machine", () => {
    let state = initialAppState();
    const controller = new MachineStatusController(() => state, (patch) => { state = { ...state, ...patch }; });

    controller.apply("remote", snapshot({ machine: { "core:working": true } }));
    controller.apply("local", snapshot({ machine: { "core:unread": true } }));

    expect(state.machineStatusSnapshots["remote"]?.machine).toEqual({ "core:working": true });
    expect(state.machineStatusSnapshots["local"]?.machine).toEqual({ "core:unread": true });
  });

  it("ignores snapshots at an equal or lower revision within the same epoch", () => {
    let state = initialAppState();
    const controller = new MachineStatusController(() => state, (patch) => { state = { ...state, ...patch }; });

    controller.apply("local", snapshot({ revision: 5, machine: { "core:working": true } }));
    controller.apply("local", snapshot({ revision: 5, machine: {} }));
    controller.apply("local", snapshot({ revision: 4, machine: {} }));

    expect(state.machineStatusSnapshots["local"]).toMatchObject({ revision: 5, machine: { "core:working": true } });

    controller.apply("local", snapshot({ revision: 6, machine: {} }));

    expect(state.machineStatusSnapshots["local"]).toMatchObject({ revision: 6, machine: {} });
  });

  it("replaces state wholesale when the epoch changes, even at a lower revision", () => {
    let state = initialAppState();
    const controller = new MachineStatusController(() => state, (patch) => { state = { ...state, ...patch }; });

    controller.apply("local", snapshot({ epochId: "epoch-1", revision: 9, projects: { "project-1": { "core:working": true } } }));
    controller.apply("local", snapshot({ epochId: "epoch-2", revision: 1, projects: {} }));

    expect(state.machineStatusSnapshots["local"]).toMatchObject({ epochId: "epoch-2", revision: 1, projects: {} });
  });

  it("keeps an unknown flag id so a newer daemon's status still reaches the rows", () => {
    let state = initialAppState();
    const controller = new MachineStatusController(() => state, (patch) => { state = { ...state, ...patch }; });

    controller.apply("local", snapshot({ machine: { "core:working": true, "core:future": true } }));

    expect(state.machineStatusSnapshots["local"]?.machine).toEqual({ "core:working": true, "core:future": true });
  });

  it("applies the fetched snapshot for the requested machine", async () => {
    let state = initialAppState();
    const controller = new MachineStatusController(() => state, (patch) => { state = { ...state, ...patch }; }, {
      api: { machineStatus: (machineId) => Promise.resolve(snapshot({ epochId: `epoch-${machineId}` })) },
    });

    await controller.refresh("remote");
    await controller.refresh("local");

    expect(state.machineStatusSnapshots["remote"]).toMatchObject({ epochId: "epoch-remote" });
    expect(state.machineStatusSnapshots["local"]).toMatchObject({ epochId: "epoch-local" });
  });

  it("leaves a machine without a snapshot and raises no blocking error when the refresh fails", async () => {
    let state = initialAppState();
    const controller = new MachineStatusController(() => state, (patch) => { state = { ...state, ...patch }; }, {
      api: { machineStatus: () => Promise.reject(new Error("Not Found")) },
    });

    await expect(controller.refresh("local")).rejects.toThrow("Not Found");

    expect(state.machineStatusSnapshots).toEqual({});
    expect(state.error).toBe("");
  });

  it("does not let a late refresh response overwrite a newer socket snapshot", async () => {
    let state = initialAppState();
    let resolveFetch: ((value: MachineStatusSnapshot) => void) | undefined;
    const fetched = new Promise<MachineStatusSnapshot>((resolve) => { resolveFetch = resolve; });
    const controller = new MachineStatusController(() => state, (patch) => { state = { ...state, ...patch }; }, {
      api: { machineStatus: () => fetched },
    });

    const refreshing = controller.refresh("local");
    controller.apply("local", snapshot({ revision: 7, machine: { "core:terminal": true } }));
    resolveFetch?.(snapshot({ revision: 3, machine: {} }));
    await refreshing;

    expect(state.machineStatusSnapshots["local"]).toMatchObject({ revision: 7, machine: { "core:terminal": true } });
  });
});
