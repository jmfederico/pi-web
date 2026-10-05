import { html } from "lit";
import { expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { PluginRegistry, installApplicationPanelScope } from "./registry";
import type { ApplicationPanelContext, PiWebPlugin } from "./types";

it("preserves portable and machine-specific precedence for application tabs and route identities", async () => {
  const registry = new PluginRegistry();
  const plugin: PiWebPlugin = { apiVersion: 4, name: "Info", activate: () => ({ contributions: {
    applicationPanels: [{ id: "workspace.info", title: "Info", routeAliases: ["old-info"], render: () => html`Info` }],
  } }) };
  await registry.register({ id: "info", plugin });
  expect(visibleIds(registry, "remote")).toEqual(["info:workspace.info"]);
  await registry.register({ id: "remote-info", sourcePluginId: "info", machineId: "remote", machineSpecific: true, plugin });
  expect(visibleIds(registry, "local")).toEqual(["info:workspace.info"]);
  expect(visibleIds(registry, "remote")).toEqual(["remote-info:workspace.info"]);
  expect(visibleIds(registry, "other")).toEqual(["info:workspace.info"]);
  expect(registry.resolveWorkspacePanelRouteId("info:workspace.info", "remote")).toBe("remote-info:workspace.info");
  expect(registry.resolveWorkspacePanelRouteId("old-info", "local")).toBe("info:workspace.info");
  await registry.dispose();
  expect(registry.getApplicationPanels()).toEqual([]);
});

it("gates application callbacks and scopes host helpers to the registration", async () => {
  let enabled = true;
  const registry = new PluginRegistry({ isContributionEnabled: () => enabled });
  const render = vi.fn(() => html`Info`);
  const visible = vi.fn(() => true);
  const badge = vi.fn(() => "1");
  await registry.register({ id: "info", plugin: { apiVersion: 4, name: "Info", activate: () => ({ contributions: {
    applicationPanels: [{ id: "workspace.info", title: "Info", visible, badge, render }],
  } }) } });
  const panel = registry.getApplicationPanels()[0];
  const scoped = context("remote");
  const scope = vi.fn(() => scoped);
  const base = installApplicationPanelScope(context("remote"), scope);
  expect(panel?.visible?.(base)).toBe(true);
  expect(panel?.badge?.(base)).toBe("1");
  panel?.render(base);
  expect(scope).toHaveBeenCalledWith("info");
  expect(render).toHaveBeenCalledWith(expect.objectContaining(scoped));
  render.mockClear(); visible.mockClear(); badge.mockClear();
  enabled = false;
  expect(panel?.visible?.(base)).toBe(false);
  expect(panel?.badge?.(base)).toBeUndefined();
  panel?.render(base);
  expect(render).not.toHaveBeenCalled();
  expect(visible).not.toHaveBeenCalled();
  expect(badge).not.toHaveBeenCalled();
  await registry.dispose();
});

it("warns about unknown contribution names at registration without disabling recognized contributions", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const registry = new PluginRegistry();
  const contributions = {
    applicationPanels: [{ id: "info", title: "Info", render: () => html`Info` }],
    actions: [{ id: "action", title: "Action", run: () => undefined }],
    misspelledPanels: { arbitraryPluginData: true },
  };
  try {
    await registry.register({ id: "diagnostic", plugin: { apiVersion: 4, name: "Diagnostic", activate: () => ({ contributions }) } });
    expect(warn).toHaveBeenCalledExactlyOnceWith("PI WEB plugin diagnostic has unknown contribution: misspelledPanels");
    expect(registry.getApplicationPanels().map(({ id }) => id)).toEqual(["diagnostic:info"]);
    expect(registry.resolveWorkspacePanelRouteId("diagnostic:info", "local")).toBe("diagnostic:info");
    expect(registry.hasPlugin("diagnostic")).toBe(true);
    await registry.dispose();
  } finally { warn.mockRestore(); }
});

function visibleIds(registry: PluginRegistry, machineId: string): string[] {
  return registry.getApplicationPanels().filter((panel) => panel.visible?.(context(machineId)) ?? true).map(({ id }) => id);
}

function context(machineId: string): ApplicationPanelContext {
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    state: initialAppState(), navigate: () => Promise.resolve(),
    prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null }, host: { requestRender: vi.fn() },
  };
}
