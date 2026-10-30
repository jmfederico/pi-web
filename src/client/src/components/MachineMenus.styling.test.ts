// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Machine } from "../api";
import { installPopoverFake } from "./anchoredPopup.testSupport";
installPopoverFake();
import { MachineList } from "./MachineList";
import { MachineSwitcher } from "./MachineSwitcher";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

function machine(id: string, kind: Machine["kind"] = "remote"): Machine {
  return { id, name: id, kind, createdAt: "2026-06-04", updatedAt: "2026-06-04" };
}
const local = machine("local", "local");
const first = machine("remote/a");
const second = machine("remote?a");
type MachineComponent = MachineList | MachineSwitcher;

async function settle(component: MachineComponent): Promise<void> {
  await component.updateComplete;
  await component.updateComplete;
}

function button(root: ParentNode, selector: string): HTMLButtonElement {
  const found = root.querySelector(selector);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Missing button: ${selector}`);
  return found;
}

function option(component: MachineSwitcher, id: string): HTMLButtonElement {
  const found = [...component.renderRoot.querySelectorAll<HTMLButtonElement>(".machine-option-main")]
    .find((candidate) => candidate.dataset["machineId"] === id);
  if (!found) throw new Error(`Missing machine option: ${id}`);
  return found;
}

function linkedPanel(component: MachineComponent, trigger: HTMLButtonElement, context: string): HTMLElement {
  expect(trigger.classList.contains("ui-popup-trigger")).toBe(true);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const panel = component.shadowRoot?.getElementById(trigger.getAttribute("aria-controls") ?? "");
  if (!(panel instanceof HTMLElement)) throw new Error("Missing linked panel");
  expect(panel.matches(".ui-menu.ui-popup-panel[popover=auto]")).toBe(true);
  expect(panel.dataset["uiContext"]).toBe(context);
  return panel;
}

async function mount(component: MachineComponent, machines = [local, first, second]): Promise<void> {
  component.machines = machines;
  component.onSelect = vi.fn();
  component.onEdit = vi.fn();
  component.onRemove = vi.fn();
  document.body.append(component);
  await settle(component);
  if (component instanceof MachineSwitcher) {
    const trigger = button(component.renderRoot, ".machine-switcher-button");
    trigger.click();
    await settle(component);
    linkedPanel(component, trigger, "machine-picker");
  }
}

describe.each([
  { name: "MachineList", Component: MachineList },
  { name: "MachineSwitcher", Component: MachineSwitcher },
])("$name menu styling contract", ({ Component }) => {
  it("associates action hooks with distinct opaque identities without selecting a machine", async () => {
    const component = new Component();
    await mount(component);
    const panelIds = new Set<string>();
    // These identities collided under the old lossy replacement; the ID format is not public.
    for (const target of [first, second]) {
      const row = component instanceof MachineSwitcher ? option(component, target.id).parentElement :
        [...component.renderRoot.querySelectorAll<HTMLElement>(".machine-row")].find((row) => row.dataset["machineId"] === target.id);
      if (!row) throw new Error("Missing machine row");
      const trigger = button(row, component instanceof MachineSwitcher ? ".machine-option-actions-toggle" : ".action-menu-toggle");
      trigger.click();
      await settle(component);
      const panel = linkedPanel(component, trigger, "machine-actions");
      panelIds.add(panel.id);
      const actions = [...panel.querySelectorAll<HTMLButtonElement>("button")];
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.every((action) => action.matches(".ui-button.ui-menu-item"))).toBe(true);
      expect(actions.some((action) => action.matches(".danger"))).toBe(true);
      expect(component.onSelect).not.toHaveBeenCalled();
      trigger.click();
      await settle(component);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    }
    expect(panelIds.size).toBe(2);
  });
});

it("synchronizes picker current hooks with fallback and explicit selection, not focus", async () => {
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
  const component = new MachineSwitcher();
  await mount(component, [first, local, second]);
  const expectCurrent = (id: string) => {
    for (const candidate of [first, local, second]) {
      const item = option(component, candidate.id);
      const current = candidate.id === id;
      expect(item.classList.contains("ui-menu-item")).toBe(true);
      expect(item.dataset["current"]).toBe(String(current));
      expect(item.getAttribute("aria-current")).toBe(current ? "true" : null);
    }
  };
  expectCurrent(local.id);
  option(component, first.id).focus();
  expectCurrent(local.id);
  component.selected = second;
  await settle(component);
  expectCurrent(second.id);
  expect(component.onSelect).not.toHaveBeenCalled();
});
