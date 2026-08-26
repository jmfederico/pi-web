// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";
import { SettingsDisplayPanel, type WorkspaceToolSummary } from "./SettingsDisplayPanel";

afterEach(() => {
  document.body.replaceChildren();
});

const TOOLS: WorkspaceToolSummary[] = [
  { id: "core:workspace.files", title: "Files" },
  { id: "core:workspace.terminal", title: "Terminal" },
  { id: "relays:workspace.relays", title: "Relays" },
];

describe("settings-display-panel", () => {
  it("defaults to expanded breadcrumbs with every tool pinned", async () => {
    const panel = await mount({});
    expect(checkedBreadcrumb(panel)).toBe("expanded");
    expect(toolChecks(panel)).toEqual([true, true, true]);
    // "Pin all" is a no-op when nothing is customized.
    expect(pinAllButton(panel).disabled).toBe(true);
  });

  it("reflects a stored subset and enables pin-all", async () => {
    const panel = await mount({ pinnedWorkspaceTools: ["core:workspace.terminal"] });
    expect(toolChecks(panel)).toEqual([false, true, false]);
    expect(pinAllButton(panel).disabled).toBe(false);
  });

  it("saves compact breadcrumbs and clears expanded to the default", async () => {
    const saved: PiWebConfigValues[] = [];
    const panel = await mount({}, (config) => saved.push(config));
    breadcrumbRadio(panel, "compact").click();
    expect(saved.at(-1)).toEqual({ breadcrumbMode: "compact" });

    const expandedPanel = await mount({ breadcrumbMode: "compact" }, (config) => saved.push(config));
    breadcrumbRadio(expandedPanel, "expanded").click();
    expect(saved.at(-1)).toEqual({});
  });

  it("materializes the pin list when a tool is unpinned from the default", async () => {
    const saved: PiWebConfigValues[] = [];
    const panel = await mount({}, (config) => saved.push(config));
    toolCheckbox(panel, "core:workspace.files").click();
    expect(saved.at(-1)).toEqual({ pinnedWorkspaceTools: ["core:workspace.terminal", "relays:workspace.relays"] });
  });

  it("drops the key when the last unpinned tool is re-pinned to cover all", async () => {
    const saved: PiWebConfigValues[] = [];
    const panel = await mount({ pinnedWorkspaceTools: ["core:workspace.files", "core:workspace.terminal"] }, (config) => saved.push(config));
    toolCheckbox(panel, "relays:workspace.relays").click();
    expect(saved.at(-1)).toEqual({});
  });
});

async function mount(config: PiWebConfigValues, onSave: (config: PiWebConfigValues) => void = () => undefined): Promise<SettingsDisplayPanel> {
  const panel = new SettingsDisplayPanel();
  panel.tools = TOOLS;
  panel.configResponse = configResponse(config);
  panel.onSave = onSave;
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function configResponse(config: PiWebConfigValues): PiWebConfigResponse {
  return {
    path: "/tmp/config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, askUser: false },
  };
}

function breadcrumbRadios(panel: SettingsDisplayPanel): HTMLInputElement[] {
  return Array.from(panel.shadowRoot?.querySelectorAll<HTMLInputElement>('input[name="breadcrumb-mode"]') ?? []);
}

function checkedBreadcrumb(panel: SettingsDisplayPanel): string {
  const options = ["expanded", "compact"];
  const index = breadcrumbRadios(panel).findIndex((radio) => radio.checked);
  return options[index] ?? "none";
}

function breadcrumbRadio(panel: SettingsDisplayPanel, mode: "expanded" | "compact"): HTMLInputElement {
  const radio = breadcrumbRadios(panel)[mode === "expanded" ? 0 : 1];
  if (radio === undefined) throw new Error(`Expected the ${mode} radio`);
  return radio;
}

function toolCheckboxes(panel: SettingsDisplayPanel): HTMLInputElement[] {
  return Array.from(panel.shadowRoot?.querySelectorAll<HTMLInputElement>('.tool-row input[type="checkbox"]') ?? []);
}

function toolChecks(panel: SettingsDisplayPanel): boolean[] {
  return toolCheckboxes(panel).map((checkbox) => checkbox.checked);
}

function toolCheckbox(panel: SettingsDisplayPanel, id: string): HTMLInputElement {
  const index = TOOLS.findIndex((tool) => tool.id === id);
  const checkbox = toolCheckboxes(panel)[index];
  if (checkbox === undefined) throw new Error(`Expected a checkbox for ${id}`);
  return checkbox;
}

function pinAllButton(panel: SettingsDisplayPanel): HTMLButtonElement {
  const button = panel.shadowRoot?.querySelector<HTMLButtonElement>(".card-actions button");
  if (button === null || button === undefined) throw new Error("Expected the pin-all button");
  return button;
}
