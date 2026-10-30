// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { Machine, MachineHealth, MachineStatus } from "../api";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { machineStatusSnapshot } from "../machineStatus.testSupport";
import { installPopoverFake } from "./anchoredPopup.testSupport";
installPopoverFake();
import { MachineSwitcher } from "./MachineSwitcher";

afterEach(() => {
  document.body.replaceChildren();
});

describe("machine-switcher status indicator", () => {
  it("keeps the full machine name and current status available without the visible labels", async () => {
    const remote = { ...machine("remote-a", "remote"), name: "Production build machine in the office", baseUrl: "https://fleet-a.example.com/" };
    const switcher = await mountSwitcher([remote, machine("local", "local")], {}, { "remote-a": { ...health("offline"), machineId: "remote-a" } });
    const button = switcherButton(switcher);

    expect(button.getAttribute("aria-label")).toBe(`Machine: ${remote.name}. offline. Switch machine.`);
    expect(button.title).toBe(`${remote.name} · ${remote.baseUrl} · offline`);
    expect(button.classList.contains("disconnected")).toBe(true);
    expect(button.querySelector(".machine-status")).toBeNull();
    expect(button.querySelector(".machine-icon")?.classList.contains("dimmed")).toBe(true);

    switcher.statuses = { "remote-a": { ...health("online"), machineId: "remote-a" } };
    await switcher.updateComplete;
    expect(button.getAttribute("aria-label")).toContain("online");
    expect(button.classList.contains("disconnected")).toBe(false);
    expect(button.querySelector(".machine-status")).toBeNull();
    expect(button.querySelector(".machine-icon")?.classList.contains("dimmed")).toBe(false);

    button.click();
    await switcher.updateComplete;
    const option = optionFor(switcher, remote.name);
    expect(option.querySelector(".machine-option-name")?.textContent).toContain(remote.name);
    expect(option.querySelector("small")?.textContent).toContain("online");
  });

  it("does not repeat the selected machine's attention in the other-machines indicator", async () => {
    const switcher = await mountSwitcher([machine("local", "local"), machine("remote-a", "remote")], {
      local: machineStatusSnapshot({ machine: { "core:working": true, "core:unread": true } }),
    });

    expect(switcherButton(switcher).querySelector(".unread-ring")).not.toBeNull();
    expect(switcherButton(switcher).querySelector(".other-machines-activity")).toBeNull();
  });

  it("combines work and unread from unselected machines and updates when selection changes", async () => {
    const remoteA = machine("remote-a", "remote");
    const remoteB = machine("remote-b", "remote");
    const switcher = await mountSwitcher([machine("local", "local"), remoteA, remoteB], {
      "remote-a": machineStatusSnapshot({ machine: { "core:terminal": true, "core:unread": true } }),
      "remote-b": machineStatusSnapshot({ machine: { "core:working": true } }),
    });
    const otherIndicator = () => switcherButton(switcher).querySelector(".other-machines-activity");

    expect(otherIndicator()?.querySelector(".unread-ring")?.getAttribute("title")).toBe("Unread sessions on other machines · Other machines active");
    expect(otherIndicator()?.querySelector(".activity-indicator.session")).not.toBeNull();

    switcher.selected = remoteA;
    await switcher.updateComplete;
    expect(otherIndicator()?.querySelector(".unread-ring")).toBeNull();
    expect(otherIndicator()?.querySelector(".activity-indicator.session")).not.toBeNull();

    switcher.selected = remoteB;
    await switcher.updateComplete;
    expect(otherIndicator()?.querySelector(".activity-indicator.terminal")).not.toBeNull();
    expect(otherIndicator()?.querySelector(".unread-ring")?.getAttribute("title")).toBe("Unread sessions on other machines · Terminal active on other machines");
  });

  it.each(["offline", "error"] as const)("keeps unread but ignores stale work from %s unselected machines", async (status) => {
    const switcher = await mountSwitcher([machine("local", "local"), machine("remote-a", "remote")], {
      "remote-a": machineStatusSnapshot({ machine: { "core:working": true, "core:unread": true } }),
    }, { "remote-a": { ...health(status), machineId: "remote-a" } });
    const indicator = switcherButton(switcher).querySelector(".other-machines-activity");

    expect(indicator?.querySelector(".activity-indicator.session")).toBeNull();
    expect(indicator?.querySelector(".activity-indicator.unread")?.getAttribute("title")).toBe("Unread sessions on other machines");

    switcher.statusSnapshots = { "remote-a": machineStatusSnapshot({ machine: { "core:working": true } }) };
    await switcher.updateComplete;
    expect(switcherButton(switcher).querySelector(".other-machines-activity")).toBeNull();
  });

  it("shows an unread dot on the switcher button while the selected machine reports unread", async () => {
    const switcher = await mountSwitcher([machine("local", "local"), machine("remote-a", "remote")], { local: machineStatusSnapshot({ machine: { "core:unread": true } }) });
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
    const switcher = await mountSwitcher([machine("local", "local"), machine("remote-a", "remote")], { local: machineStatusSnapshot({ machine: { "core:working": true, "core:unread": true } }) });

    const button = switcherButton(switcher);
    const ring = button.querySelector(".unread-ring");
    expect(ring?.querySelector(".activity-indicator.session")).not.toBeNull();
    expect(ring?.getAttribute("title")).toBe("Unread sessions on this machine · Machine active");
    // One mark only: the ring replaces the standalone unread dot.
    expect(button.querySelector(".activity-indicator.unread")).toBeNull();
  });

  it("shows no indicator for a machine that publishes no snapshot", async () => {
    const switcher = await mountSwitcher([machine("local", "local"), machine("remote-a", "remote")], {});

    expect(switcherButton(switcher).querySelector(".activity-indicator")).toBeNull();
  });

  it("keeps the unread dot on the single-machine info bubble", async () => {
    const switcher = await mountSwitcher([machine("local", "local")], { local: machineStatusSnapshot({ machine: { "core:unread": true } }) });

    const dot = switcher.shadowRoot?.querySelector(".machine-info .activity-indicator.unread");
    expect(dot).not.toBeNull();
  });
});

it("keeps nested machine actions in the parent popup and closes only the top popup on Escape", async () => {
  const switcher = await mountSwitcher([machine("local", "local"), machine("remote-a", "remote")], {});
  switcher.onRemove = () => undefined;
  await switcher.updateComplete;
  switcherButton(switcher).click(); await switcher.updateComplete;
  const actions = optionFor(switcher, "remote-a").querySelector<HTMLButtonElement>(".machine-option-actions-toggle");
  if (!actions) throw new Error("Missing machine actions");
  actions.click(); await switcher.updateComplete;
  const child = switcher.shadowRoot?.querySelector<HTMLElement>(".machine-option-actions-panel");
  const parent = switcher.shadowRoot?.querySelector<HTMLElement>(".machine-switcher-menu");
  expect(parent?.contains(child ?? null)).toBe(true);
  child?.querySelector("button")?.focus();
  child?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
  await switcher.updateComplete;
  expect(switcher.shadowRoot?.querySelector(".machine-option-actions-panel")).toBeNull();
  expect(switcher.shadowRoot?.querySelector(".machine-switcher-menu")).toBe(parent);
  expect(actions.getAttribute("aria-expanded")).toBe("false");
  expect(switcher.shadowRoot?.activeElement).toBe(actions);
  actions.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
  await switcher.updateComplete;
  expect(switcher.shadowRoot?.querySelector(".machine-switcher-menu")).toBeNull();
  expect(switcherButton(switcher).getAttribute("aria-expanded")).toBe("false");
});

describe("machine icons", () => {
  it("shows the selected machine's icon on the switcher button", async () => {
    const switcher = await mountSwitcher([machine("local", "local"), machine("remote-a", "remote")], {});

    const icon = switcherButton(switcher).querySelector<HTMLImageElement>(".machine-icon");
    expect(icon?.getAttribute("src")).toBe(`${document.baseURI}favicon.svg`);
    expect(icon?.classList.contains("dimmed")).toBe(false);
  });

  it("dims the icon of an offline machine", async () => {
    const switcher = await mountSwitcher([machine("local", "local")], {}, { local: health("offline") });

    const icon = switcher.shadowRoot?.querySelector<HTMLImageElement>(".machine-info .machine-icon");
    expect(icon?.classList.contains("dimmed")).toBe(true);
  });

  it("shows each machine's own favicon in the dropdown", async () => {
    const remote = machine("remote-a", "remote");
    remote.baseUrl = "https://fleet-a.example.com/";
    const switcher = await mountSwitcher([machine("local", "local"), remote], {});

    switcherButton(switcher).click();
    await switcher.updateComplete;

    const icons = [...(switcher.shadowRoot?.querySelectorAll<HTMLImageElement>(".machine-option .machine-icon") ?? [])];
    expect(icons.map((icon) => icon.getAttribute("src"))).toEqual([
      `${document.baseURI}favicon.svg`,
      "https://fleet-a.example.com/favicon.svg",
    ]);
  });

  it("identifies the local machine by the gateway URL in the dropdown", async () => {
    const switcher = await mountSwitcher([machine("local", "local"), machine("remote-a", "remote")], {});

    switcherButton(switcher).click();
    await switcher.updateComplete;

    const subtitle = optionFor(switcher, "local").querySelector("small");
    expect(subtitle?.textContent).toContain(document.location.host);
  });

  it("hides a broken remote icon instead of showing a broken image", async () => {
    const remote = machine("remote-a", "remote");
    remote.baseUrl = "https://fleet-a.example.com/";
    const switcher = await mountSwitcher([machine("local", "local"), remote], {});

    switcherButton(switcher).click();
    await switcher.updateComplete;

    const icon = switcher.shadowRoot?.querySelector<HTMLImageElement>(".machine-option:last-child .machine-icon");
    icon?.dispatchEvent(new Event("error"));
    expect(icon?.style.display).toBe("none");
  });
});

describe("single-machine info bubble", () => {
  it("renders a static bubble instead of a dropdown when only the local machine exists", async () => {
    const switcher = await mountSwitcher([machine("local", "local")], {});

    expect(switcher.shadowRoot?.querySelector(".machine-switcher-button")).toBeNull();
    const info = switcher.shadowRoot?.querySelector<HTMLElement>(".machine-info");
    expect(info).not.toBeNull();
    expect(info?.querySelector(".machine-chevron")).toBeNull();
  });

  it("renders the static machine name without the URL", async () => {
    const switcher = await mountSwitcher([machine("local", "local")], {});

    expect(switcher.shadowRoot?.querySelector(".machine-info")?.textContent).toContain("local");
    expect(switcher.shadowRoot?.querySelector(".machine-info-url")).toBeNull();
    expect(switcher.shadowRoot?.querySelector(".machine-switcher-button")).toBeNull();
  });

  it("keeps the URL in the tooltip alongside the machine name and icon", async () => {
    const switcher = await mountSwitcher([machine("local", "local")], {});

    const info = switcher.shadowRoot?.querySelector<HTMLElement>(".machine-info");
    expect(info?.textContent).not.toContain(document.location.host);
    expect(info?.title).toContain(document.location.host);
    expect(info?.querySelector(".machine-icon")).not.toBeNull();
    expect(info?.querySelector(".machine-status")).toBeNull();
    expect(info?.querySelector(".machine-switcher-label")?.textContent).toBe("local");
  });

  it("does not open a menu when clicked", async () => {
    const switcher = await mountSwitcher([machine("local", "local")], {});

    switcher.shadowRoot?.querySelector<HTMLElement>(".machine-info")?.click();
    await switcher.updateComplete;

    expect(switcher.shadowRoot?.querySelector(".machine-switcher-menu")).toBeNull();
  });

  it("is not keyboard-focusable", async () => {
    const switcher = await mountSwitcher([machine("local", "local")], {});

    expect(await switcher.focusSelectedOrFirst()).toBe(false);
  });

  it("renders PI-WEB while no machines are loaded", async () => {
    const switcher = new MachineSwitcher();
    switcher.machines = [];
    document.body.append(switcher);
    await switcher.updateComplete;

    expect(switcher.shadowRoot?.querySelector(".machine-info")?.textContent).toContain("PI-WEB");
    expect(switcher.shadowRoot?.querySelector(".machine-switcher-button")).toBeNull();
  });
});

async function mountSwitcher(machines: Machine[], statusSnapshots: Record<string, MachineStatusSnapshot>, statuses: Record<string, MachineHealth> = {}): Promise<MachineSwitcher> {
  const switcher = new MachineSwitcher();
  switcher.machines = machines;
  const selected = machines[0];
  if (selected === undefined) throw new Error("Expected at least one machine");
  switcher.selected = selected;
  switcher.statusSnapshots = statusSnapshots;
  switcher.statuses = statuses;
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

function health(status: MachineStatus): MachineHealth {
  return { machineId: "local", ok: status === "online", checkedAt: "2026-06-04T00:00:00.000Z", status };
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
