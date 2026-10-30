// @vitest-environment happy-dom

import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Machine } from "../../api";
import { AppContextBar } from "./AppContextBar";

afterEach(() => {
  document.body.replaceChildren();
});

it("omits folder workspace selection while preserving project and session selection", async () => {
  const bar = new AppContextBar();
  bar.workspaceSelectionVisible = false;
  document.body.append(bar);
  await bar.updateComplete;
  expect(bar.shadowRoot?.querySelector('button[aria-label^="Workspace:"]')).toBeNull();
  expect(bar.shadowRoot?.querySelector('button[aria-label^="Project:"]')).not.toBeNull();
  expect(bar.shadowRoot?.querySelector('button[aria-label^="Session:"]')).not.toBeNull();
  bar.workspaceSelectionVisible = true;
  await bar.updateComplete;
  expect(bar.shadowRoot?.querySelector('button[aria-label^="Workspace:"]')).not.toBeNull();
});

it.each([false, true])("places reload before actions with navigation toggle: %s", async (showNavigation) => {
  const bar = new AppContextBar();
  bar.refreshControl = html`<button aria-label="Full page reload">Reload</button>`;
  bar.onShowActions = vi.fn();
  if (showNavigation) bar.onShowNavigation = vi.fn();
  document.body.append(bar);
  await bar.updateComplete;

  const labels = Array.from(bar.shadowRoot?.querySelectorAll(".context-actions button") ?? [], (button) => button.getAttribute("aria-label"));
  expect(labels).toEqual([
    ...(showNavigation ? ["Navigation"] : []),
    "Full page reload",
    "Show Actions",
  ]);
});

describe("machine crumb", () => {
  it("shows PI-WEB before machines load", async () => {
    const bar = await mountBar({ machines: [] });
    expect(machineChip(bar)?.tagName).toBe("SPAN");
    expect(machineChip(bar)?.textContent).toContain("PI-WEB");
  });

  it("shows the static machine name without a URL when there is no machine choice", async () => {
    const bar = await mountBar({ machines: [machine("local")] });

    expect(machineChip(bar)?.tagName).toBe("SPAN");
    expect(machineChip(bar)?.textContent).toContain("Local");
    expect(machineChip(bar)?.textContent).not.toContain(document.location.host);
    expect(machineChip(bar)?.querySelector("img")).not.toBeNull();
  });

  it("shows the machine logo in the picker without the URL", async () => {
    const opened: string[] = [];
    const bar = await mountBar({ machines: [machine("local"), machine("remote-a")], onOpenSection: (section) => { opened.push(section); } });

    const chip = machineChip(bar);
    expect(chip?.tagName).toBe("BUTTON");
    expect(chip?.textContent).toContain("Local");
    expect(chip?.querySelector("img")?.getAttribute("src")).toMatch(/\/favicon\.svg$/u);
    expect(chip?.textContent).not.toContain(document.location.host);
    chip?.click();
    expect(opened).toEqual(["machines"]);
  });

  it("keeps the remote URL in the tooltip rather than the selected machine label", async () => {
    const remote = machine("remote-a");
    remote.baseUrl = "https://fleet-a.example.com/";
    const bar = await mountBar({ machines: [machine("local"), remote], machine: remote });

    expect(machineChip(bar)?.textContent).toContain(remote.name);
    expect(machineChip(bar)?.textContent).not.toContain("fleet-a.example.com");
    expect(machineChip(bar)?.title).toBe(remote.baseUrl);
    expect(machineChip(bar)?.querySelector("img")?.getAttribute("src")).toBe("https://fleet-a.example.com/favicon.svg");
  });
});

interface BarFixture {
  machines: Machine[];
  machine?: Machine;
  onOpenSection?: (section: "machines" | "projects" | "workspaces" | "sessions") => void;
}

async function mountBar(fixture: BarFixture): Promise<AppContextBar> {
  const bar = new AppContextBar();
  bar.machines = fixture.machines;
  if (fixture.machine !== undefined) bar.machine = fixture.machine;
  if (fixture.onOpenSection !== undefined) bar.onOpenSection = fixture.onOpenSection;
  document.body.append(bar);
  await bar.updateComplete;
  return bar;
}

function machineChip(bar: AppContextBar): HTMLElement | undefined {
  return bar.shadowRoot?.querySelector<HTMLElement>(".machine-chip") ?? undefined;
}

function machine(id: string): Machine {
  return {
    id,
    name: id === "local" ? "Local" : id,
    kind: id === "local" ? "local" : "remote",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}
