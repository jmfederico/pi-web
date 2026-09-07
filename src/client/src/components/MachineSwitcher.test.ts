// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { Machine, MachineHealth, MachineStatus } from "../api";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { machineStatusSnapshot } from "../machineStatus.testSupport";
import { MachineSwitcher } from "./MachineSwitcher";

afterEach(() => {
  document.body.replaceChildren();
});

describe("machine-switcher status indicator", () => {
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
    const switcher = await mountSwitcher([machine("local", "local")], { local: machineStatusSnapshot({ machine: { "core:unread": true } }) }, {}, true);

    const dot = switcher.shadowRoot?.querySelector(".machine-info .activity-indicator.unread");
    expect(dot).not.toBeNull();
  });
});

describe("machine icons", () => {
  it("shows the selected machine's icon on the switcher button", async () => {
    const switcher = await mountSwitcher([machine("local", "local"), machine("remote-a", "remote")], {});

    const icon = switcherButton(switcher).querySelector<HTMLImageElement>(".machine-icon");
    expect(icon?.getAttribute("src")).toBe(`${document.baseURI}favicon.svg`);
    expect(icon?.classList.contains("dimmed")).toBe(false);
  });

  it("dims the icon of an offline machine", async () => {
    const switcher = await mountSwitcher([machine("local", "local")], {}, { local: health("offline") }, true);

    const icon = switcher.shadowRoot?.querySelector<HTMLImageElement>(".machine-info .machine-icon");
    expect(icon?.classList.contains("dimmed")).toBe(true);
  });

  it("places the switcher button's activity indicator to the right of the favicon", async () => {
    const switcher = await mountSwitcher([machine("local", "local"), machine("remote-a", "remote")], { local: machineStatusSnapshot({ machine: { "core:unread": true } }) });

    const icon = requiredElement(switcherButton(switcher), ".machine-icon");
    const dot = requiredElement(switcherButton(switcher), ".activity-indicator");
    expect(icon.compareDocumentPosition(dot)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
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
  it("renders a static bubble instead of a dropdown when only the local machine exists in PWA mode", async () => {
    const switcher = await mountSwitcher([machine("local", "local")], {}, {}, true);

    expect(switcher.shadowRoot?.querySelector(".machine-switcher-button")).toBeNull();
    const info = switcher.shadowRoot?.querySelector<HTMLElement>(".machine-info");
    expect(info).not.toBeNull();
    expect(info?.querySelector(".machine-chevron")).toBeNull();
  });

  it("renders nothing for a single machine in browser mode", async () => {
    const switcher = await mountSwitcher([machine("local", "local")], {});

    expect(switcher.shadowRoot?.querySelector(".machine-info")).toBeNull();
    expect(switcher.shadowRoot?.querySelector(".machine-switcher-button")).toBeNull();
  });

  it("carries just the machine icon and URL", async () => {
    const switcher = await mountSwitcher([machine("local", "local")], {}, {}, true);

    const info = switcher.shadowRoot?.querySelector<HTMLElement>(".machine-info");
    expect(info?.querySelector(".machine-info-url")?.textContent).toBe(document.location.host);
    expect(info?.querySelector(".machine-icon")).not.toBeNull();
    expect(info?.querySelector(".machine-status")).toBeNull();
    expect(info?.querySelector(".machine-switcher-text")).toBeNull();
  });

  it("places the activity indicator to the right of the favicon", async () => {
    const switcher = await mountSwitcher([machine("local", "local")], { local: machineStatusSnapshot({ machine: { "core:unread": true } }) }, {}, true);

    const icon = requiredElement(switcher.shadowRoot, ".machine-info .machine-icon");
    const dot = requiredElement(switcher.shadowRoot, ".machine-info .activity-indicator");
    expect(icon.compareDocumentPosition(dot)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("does not open a menu when clicked", async () => {
    const switcher = await mountSwitcher([machine("local", "local")], {}, {}, true);

    switcher.shadowRoot?.querySelector<HTMLElement>(".machine-info")?.click();
    await switcher.updateComplete;

    expect(switcher.shadowRoot?.querySelector(".machine-switcher-menu")).toBeNull();
  });

  it("is not keyboard-focusable", async () => {
    const switcher = await mountSwitcher([machine("local", "local")], {}, {}, true);

    expect(await switcher.focusSelectedOrFirst()).toBe(false);
  });

  it("renders nothing while no machines are loaded", async () => {
    const switcher = new MachineSwitcher();
    switcher.machines = [];
    switcher.locationIndicator = true;
    document.body.append(switcher);
    await switcher.updateComplete;

    expect(switcher.shadowRoot?.querySelector(".machine-info")).toBeNull();
    expect(switcher.shadowRoot?.querySelector(".machine-switcher-button")).toBeNull();
  });
});

async function mountSwitcher(machines: Machine[], statusSnapshots: Record<string, MachineStatusSnapshot>, statuses: Record<string, MachineHealth> = {}, locationIndicator = false): Promise<MachineSwitcher> {
  const switcher = new MachineSwitcher();
  switcher.machines = machines;
  const selected = machines[0];
  if (selected === undefined) throw new Error("Expected at least one machine");
  switcher.selected = selected;
  switcher.statusSnapshots = statusSnapshots;
  switcher.statuses = statuses;
  switcher.locationIndicator = locationIndicator;
  document.body.append(switcher);
  await switcher.updateComplete;
  return switcher;
}

function switcherButton(switcher: MachineSwitcher): HTMLElement {
  const button = switcher.shadowRoot?.querySelector(".machine-switcher-button");
  if (!(button instanceof HTMLElement)) throw new Error("Expected the machine switcher button");
  return button;
}

function requiredElement(root: ParentNode | null | undefined, selector: string): Element {
  const element = root?.querySelector(selector);
  if (element === null || element === undefined) throw new Error(`Expected ${selector}`);
  return element;
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
