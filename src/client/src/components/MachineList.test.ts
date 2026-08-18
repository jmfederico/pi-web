// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { Machine, MachineHealth, MachineStatus } from "../api";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { machineStatusSnapshot } from "../machineStatus.testSupport";
import { canRemoveMachine, MachineList } from "./MachineList";

afterEach(() => {
  document.body.replaceChildren();
});

describe("canRemoveMachine", () => {
  it("only allows remote machines to be removed from the machine list", () => {
    expect(canRemoveMachine(machine("local", "local"))).toBe(false);
    expect(canRemoveMachine(machine("remote-a", "remote"))).toBe(true);
  });
});

describe("machine status indicator", () => {
  it("shows an unread dot only on machines whose snapshot reports unread, including offline ones", async () => {
    const list = await mountMachineList(
      [machine("local", "local"), machine("remote-a", "remote"), machine("remote-b", "remote")],
      {
        "remote-a": machineStatusSnapshot({ machine: { "core:unread": true } }),
        "remote-b": machineStatusSnapshot({ machine: { "core:unread": true } }),
      },
      { "remote-b": machineHealth("remote-b", "offline") },
    );

    expect(unreadDot(rowFor(list, "local"))).toBeNull();
    const remoteDot = unreadDot(rowFor(list, "remote-a"));
    expect(remoteDot).not.toBeNull();
    expect(remoteDot?.getAttribute("title")).toBe("Unread sessions on this machine");
    // Stale-but-present counts: an offline machine keeps its last-known unread state.
    expect(unreadDot(rowFor(list, "remote-b"))).not.toBeNull();
  });

  it("clears the dot once a newer snapshot reports nothing unread", async () => {
    const list = await mountMachineList([machine("local", "local")], { local: machineStatusSnapshot({ machine: { "core:unread": true } }) });
    expect(list.shadowRoot?.querySelector(".activity-indicator.unread")).not.toBeNull();

    list.statusSnapshots = { local: machineStatusSnapshot({ revision: 2 }) };
    await list.updateComplete;

    expect(list.shadowRoot?.querySelector(".activity-indicator.unread")).toBeNull();
  });

  it("wraps the work dot in an unread ring when a machine is busy and unread", async () => {
    const list = await mountMachineList(
      [machine("local", "local"), machine("remote-a", "remote")],
      {
        local: machineStatusSnapshot({ machine: { "core:working": true, "core:unread": true } }),
        "remote-a": machineStatusSnapshot({ machine: { "core:terminal": true, "core:unread": true } }),
      },
    );

    const localRing = rowFor(list, "local").querySelector(".unread-ring");
    expect(localRing?.querySelector(".activity-indicator.session")).not.toBeNull();
    expect(localRing?.getAttribute("title")).toBe("Unread sessions on this machine · Machine active");

    const remoteRing = rowFor(list, "remote-a").querySelector(".unread-ring");
    expect(remoteRing?.querySelector(".activity-indicator.terminal")).not.toBeNull();
    expect(remoteRing?.getAttribute("title")).toBe("Unread sessions on this machine · Machine terminal active");

    // One mark per row: the ring replaces the standalone unread dot.
    expect(rowFor(list, "local").querySelector(".activity-indicator.unread")).toBeNull();
  });

  it("shows no indicator at all for a machine that publishes no snapshot", async () => {
    const list = await mountMachineList(
      [machine("local", "local"), machine("remote-a", "remote")],
      { "remote-a": machineStatusSnapshot({ machine: { "core:working": true } }) },
    );

    expect(rowFor(list, "local").querySelector(".activity-indicator")).toBeNull();
    expect(rowFor(list, "remote-a").querySelector(".activity-indicator.session")).not.toBeNull();
  });

  it("still lights a row from a flag id this build does not know", async () => {
    const list = await mountMachineList([machine("local", "local")], { local: machineStatusSnapshot({ machine: { "core:future": true } }) });

    expect(rowFor(list, "local").querySelector(".activity-indicator.session")).not.toBeNull();
  });

  it("hides the work dot while a machine is unreachable", async () => {
    const list = await mountMachineList(
      [machine("remote-a", "remote")],
      { "remote-a": machineStatusSnapshot({ machine: { "core:working": true } }) },
      { "remote-a": machineHealth("remote-a", "offline") },
    );

    expect(rowFor(list, "remote-a").querySelector(".activity-indicator")).toBeNull();
  });
});

async function mountMachineList(
  machines: Machine[],
  statusSnapshots: Record<string, MachineStatusSnapshot> = {},
  statuses: Record<string, MachineHealth> = {},
): Promise<MachineList> {
  const list = new MachineList();
  list.machines = machines;
  list.statusSnapshots = statusSnapshots;
  list.statuses = statuses;
  document.body.append(list);
  await list.updateComplete;
  return list;
}

function rowFor(list: MachineList, machineName: string): Element {
  const rows = [...(list.shadowRoot?.querySelectorAll(".machine-row") ?? [])];
  const row = rows.find((candidate) => candidate.textContent.includes(machineName));
  if (row === undefined) throw new Error(`Expected a machine row for ${machineName}`);
  return row;
}

function unreadDot(row: Element): Element | null {
  return row.querySelector(".activity-indicator.unread");
}

function machine(id: string, kind: Machine["kind"]): Machine {
  return {
    id,
    name: id,
    kind,
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

function machineHealth(machineId: string, status: MachineStatus): MachineHealth {
  return { machineId, ok: status === "online", checkedAt: "2026-06-04T00:00:00.000Z", status };
}
