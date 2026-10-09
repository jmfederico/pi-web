import { html } from "lit";
import { expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { machineScopedPluginId } from "../../../shared/machinePluginIds";
import { PluginRegistry, installApplicationPanelScope } from "./registry";
import type { ApplicationPanelContext, ApplicationPanelContribution, PiWebPlugin } from "./types";

it("preserves portable and machine-specific precedence for application tabs and route identities", async () => {
  const registry = new PluginRegistry();
  const panel: ApplicationPanelContribution = { id: "workspace.info", title: "Info", render: () => html`Info` };
  Reflect.set(panel, "sourceContributionId", "forged:workspace.info");
  const plugin: PiWebPlugin = { apiVersion: 4, name: "Info", activate: () => ({ contributions: {
    applicationPanels: [panel],
  } }) };
  await registry.register({ id: "info", plugin });
  expect(visibleIds(registry, "remote")).toEqual(["info:workspace.info"]);
  await registry.register({ id: "remote-info", sourcePluginId: "info", machineId: "remote", machineSpecific: true, plugin });
  expect(visibleIds(registry, "local")).toEqual(["info:workspace.info"]);
  expect(visibleIds(registry, "remote")).toEqual(["remote-info:workspace.info"]);
  expect(visibleIds(registry, "other")).toEqual(["info:workspace.info"]);
  expect(registry.resolveWorkspacePanelRouteId("info:workspace.info", "local")).toBe("info:workspace.info");
  expect(registry.resolveWorkspacePanelRouteId("info:workspace.info", "remote")).toBe("remote-info:workspace.info");
  expect(registry.resolveWorkspacePanelRouteId("info:workspace.info", "other")).toBe("info:workspace.info");
  expect(registry.resolveWorkspacePanelRouteId("remote-info:workspace.info", "remote")).toBe("remote-info:workspace.info");
  expect(registry.resolveWorkspacePanelRouteId("remote-info:workspace.info", "local")).toBeUndefined();
  expect(registry.resolveWorkspacePanelRouteId("remote-info:workspace.info", "other")).toBeUndefined();
  for (const machineId of ["local", "remote", "other"]) {
    for (const historicalId of ["old-info", "workspace.info", "legacy:workspace.info", "forged:workspace.info"]) {
      expect(registry.resolveWorkspacePanelRouteId(historicalId, machineId)).toBeUndefined();
    }
  }
  expect(registry.getApplicationPanels().map(({ id, sourceContributionId }) => ({ id, sourceContributionId })))
    .toEqual([
      { id: "info:workspace.info", sourceContributionId: "info:workspace.info" },
      { id: "remote-info:workspace.info", sourceContributionId: "info:workspace.info" },
    ]);
  for (const qualifiedPanel of registry.getApplicationPanels()) {
    expect(qualifiedPanel).not.toHaveProperty("routeAliases");
    expect(qualifiedPanel).not.toHaveProperty("navigationAliases");
  }
  await registry.dispose();
  expect(registry.getApplicationPanels()).toEqual([]);
  expect(registry.resolveWorkspacePanelRouteId("info:workspace.info", "remote")).toBeUndefined();
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
  expect(render).toHaveBeenCalledWith(scoped);
  expect(registry.resolveWorkspacePanelRouteId("info:workspace.info", "remote")).toBe("info:workspace.info");
  render.mockClear(); visible.mockClear(); badge.mockClear();
  enabled = false;
  expect(panel?.visible?.(base)).toBe(false);
  expect(panel?.badge?.(base)).toBeUndefined();
  panel?.render(base);
  expect(render).not.toHaveBeenCalled();
  expect(visible).not.toHaveBeenCalled();
  expect(badge).not.toHaveBeenCalled();
  expect(registry.hasPlugin("info")).toBe(true);
  expect(registry.resolveWorkspacePanelRouteId("info:workspace.info", "remote")).toBeUndefined();
  enabled = true;
  expect(registry.resolveWorkspacePanelRouteId("info:workspace.info", "remote")).toBe("info:workspace.info");
  await registry.dispose();
});

it.each([
  { field: "routeAliases", value: ["old-info", "legacy:workspace.info"] },
  { field: "routeAliases", value: [] },
  { field: "routeAliases", value: null },
  { field: "navigationAliases", value: ["legacy:workspace.info"] },
  { field: "navigationAliases", value: ["not-qualified"] },
  { field: "navigationAliases", value: [] },
  { field: "navigationAliases", value: null },
])("rejects removed application panel $field=$value transactionally and permits a clean retry", async ({ field, value }) => {
  const registry = new PluginRegistry();
  const runtimePluginId = machineScopedPluginId("remote", "info");
  const panel: ApplicationPanelContribution = { id: "workspace.info", title: "Info", render: () => html`Info` };
  Reflect.set(panel, field, value);
  const start = vi.fn();
  const dispose = vi.fn();
  const plugin: PiWebPlugin = { apiVersion: 4, name: "Info", activate: () => ({
    contributions: {
      applicationPanels: [{ id: "application.ready", title: "Ready", render: () => html`Ready` }, panel],
      workspacePanels: [{ id: "workspace.ready", title: "Ready", render: () => html`Ready` }],
    },
    start,
    dispose,
  }) };
  const registration = { id: runtimePluginId, sourcePluginId: "info", machineId: "remote", machineSpecific: true, plugin };

  const message = `Panel aliases were removed for ${runtimePluginId}:workspace.info; remove routeAliases and navigationAliases and use the current contribution ID`;
  await expect(registry.register(registration)).rejects.toMatchObject({
    phase: "validate",
    message,
    cause: { name: "BrowserPluginIncompatibleError", message },
  });
  expect(registry.hasPlugin(runtimePluginId)).toBe(false);
  expect(registry.getApplicationPanels()).toEqual([]);
  expect(registry.getWorkspacePanels()).toEqual([]);
  expect(registry.resolveWorkspacePanelRouteId(`${runtimePluginId}:application.ready`, "remote")).toBeUndefined();
  expect(registry.resolveWorkspacePanelRouteId(`${runtimePluginId}:workspace.info`, "remote")).toBeUndefined();
  expect(registry.resolveWorkspacePanelRouteId("info:workspace.info", "remote")).toBeUndefined();
  expect(start).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();

  Reflect.deleteProperty(panel, field);
  await registry.register(registration);
  expect(registry.hasPlugin(runtimePluginId)).toBe(true);
  expect(visibleIds(registry, "remote")).toEqual([`${runtimePluginId}:workspace.info`, `${runtimePluginId}:application.ready`]);
  expect(visibleIds(registry, "local")).toEqual([]);
  expect(registry.getWorkspacePanels().map(({ id }) => id)).toEqual([`${runtimePluginId}:workspace.ready`]);
  expect(registry.resolveWorkspacePanelRouteId("info:workspace.info", "remote")).toBe(`${runtimePluginId}:workspace.info`);
  expect(start).toHaveBeenCalledOnce();
  await registry.dispose();
});

it("allows undefined obsolete application panel options", async () => {
  const registry = new PluginRegistry();
  const panel: ApplicationPanelContribution = { id: "workspace.info", title: "Info", render: () => html`Info` };
  Reflect.set(panel, "routeAliases", undefined);
  Reflect.set(panel, "navigationAliases", undefined);
  await registry.register({ id: "info", plugin: { apiVersion: 4, name: "Info", activate: () => ({ contributions: { applicationPanels: [panel] } }) } });
  expect(registry.getApplicationPanels()[0]?.sourceContributionId).toBe("info:workspace.info");
  expect(registry.resolveWorkspacePanelRouteId("info:workspace.info", "local")).toBe("info:workspace.info");
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
