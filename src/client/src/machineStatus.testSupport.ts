import type { MachineStatusSnapshot } from "../../shared/machineStatus";

/**
 * Build a complete status snapshot for tests. Callers override only the nodes
 * the scenario is about, which keeps each test focused on the flags it asserts
 * rather than on the snapshot's structural fields.
 */
export function machineStatusSnapshot(patch: Partial<MachineStatusSnapshot> = {}): MachineStatusSnapshot {
  return {
    epochId: "epoch-1",
    revision: 1,
    machine: {},
    projects: {},
    workspaces: {},
    unattributed: {},
    generatedAt: "2026-06-04T00:00:00.000Z",
    ...patch,
  };
}
