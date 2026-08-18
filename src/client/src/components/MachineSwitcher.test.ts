// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { Machine } from "../api";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { machineStatusSnapshot } from "../machineStatus.testSupport";
import { MachineSwitcher } from "./MachineSwitcher";

afterEach(() => {
  document.body.replaceChildren();
});

describe("machine-switcher status indicator", () => {
  it("shows an unread dot on the switcher button while the selected machine reports unread", async () => {
    const switcher = await mountSwitcher([machine("local", "local")], { local: machineStatusSnapshot({ machine: { "core:unread": true } }) });
    const button = switcherButton(switcher);
    const dot = button.querySelector(".activity-indicator.unread");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("title")).toBe("Unread sessions on this machine");

    switcher.statusSnapshots = { local: machineStatusSnapshot({ revision: 2 }) };
    await switcher.updateComplete;

    expect(switcherButton(switcher).querySelector(".activity-indicator.unread")).toBeNull();
  });

  it("marks only the unread machines among the dropdown options", async () => {
    const switcher = await mountSwitcher(
      [machine("local", "local"), machine("remote-a", "remote"), machine("remote-b", "remote")],
      { "remote-b": machineStatusSnapshot({ machine: { "core:unread": true } }) },
    );

    switcherButton(switcher).click();
    await switcher.updateComplete;

    expect(unreadDot(optionFor(switcher, "local"))).toBeNull();
    expect(unreadDot(optionFor(switcher, "remote-a"))).toBeNull();
    expect(unreadDot(optionFor(switcher, "remote-b"))).not.toBeNull();
  });

  it("wraps the work dot in an unread ring when the machine is busy and unread", async () => {
    const switcher = await mountSwitcher([machine("local", "local")], { local: machineStatusSnapshot({ machine: { "core:working": true, "core:unread": true } }) });

    const button = switcherButton(switcher);
    const ring = button.querySelector(".unread-ring");
    expect(ring?.querySelector(".activity-indicator.session")).not.toBeNull();
    expect(ring?.getAttribute("title")).toBe("Unread sessions on this machine · Machine active");
    // One mark only: the ring replaces the standalone unread dot.
    expect(button.querySelector(".activity-indicator.unread")).toBeNull();
  });

  it("shows no indicator for a machine that publishes no snapshot", async () => {
    const switcher = await mountSwitcher([machine("local", "local")], {});

    expect(switcherButton(switcher).querySelector(".activity-indicator")).toBeNull();
  });
});

async function mountSwitcher(machines: Machine[], statusSnapshots: Record<string, MachineStatusSnapshot>): Promise<MachineSwitcher> {
  const switcher = new MachineSwitcher();
  switcher.machines = machines;
  const selected = machines[0];
  if (selected === undefined) throw new Error("Expected at least one machine");
  switcher.selected = selected;
  switcher.statusSnapshots = statusSnapshots;
  document.body.append(switcher);
  await switcher.updateComplete;
  return switcher;
}

function switcherButton(switcher: MachineSwitcher): HTMLElement {
  const button = switcher.shadowRoot?.querySelector(".machine-switcher-button");
  if (!(button instanceof HTMLElement)) throw new Error("Expected the machine switcher button");
  return button;
}

function optionFor(switcher: MachineSwitcher, machineName: string): Element {
  const options = [...(switcher.shadowRoot?.querySelectorAll(".machine-option") ?? [])];
  const option = options.find((candidate) => candidate.textContent.includes(machineName));
  if (option === undefined) throw new Error(`Expected a machine option for ${machineName}`);
  return option;
}

function unreadDot(option: Element): Element | null {
  return option.querySelector(".activity-indicator.unread");
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
