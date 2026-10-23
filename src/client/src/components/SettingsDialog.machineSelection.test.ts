// @vitest-environment happy-dom

import { LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PI_WEB_CAPABILITIES } from "../../../shared/capabilities";
import { configApi, piPackagesApi, pluginsApi, type Machine, type PiPackagesResponse, type PiWebConfigResponse, type PiWebPluginsResponse } from "../api";
import { PluginRegistry } from "../plugins/registry";
import { themePackPlugin } from "../plugins/themes";
import type { SettingsSection } from "../settingsRoute";
import { SettingsDialog } from "./SettingsDialog";
import { configResponse, deferred, packageInfo, pluginInfo, pluginsResponse, remoteMachine, secondRemoteMachine } from "./SettingsDialog.testSupport";
import type { SettingsGeneralPanel } from "./settings/SettingsGeneralPanel";
import type { SettingsPackagesPanel } from "./settings/SettingsPackagesPanel";
import type { SettingsPluginsPanel } from "./settings/SettingsPluginsPanel";
import type { SettingsSessiondPanel } from "./settings/SettingsSessiondPanel";
import type { SettingsShortcutsPanel } from "./settings/SettingsShortcutsPanel";
import type { SettingsThemePanel } from "./settings/SettingsThemePanel";

const gatewayMachine: Machine = {
  id: "local", name: "Gateway", kind: "local",
  createdAt: remoteMachine.createdAt, updatedAt: remoteMachine.updatedAt,
};
const gatewayConfig = { host: "gateway.local", port: 8504, shortcuts: { "core:chat": "mod+1" } };

beforeEach(() => {
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
  vi.spyOn(configApi, "config").mockImplementation((id) => Promise.resolve(configResponse(id === undefined ? gatewayConfig : {
    uploads: { defaultFolder: `${id}/uploads` }, spawnSessions: true, plugins: { info: { enabled: true } },
  })));
  vi.spyOn(configApi, "namingModels").mockResolvedValue({ models: [] });
  vi.spyOn(configApi, "saveConfig").mockImplementation((config) => Promise.resolve(configResponse(config)));
  vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([pluginInfo("info", true)]));
  vi.spyOn(piPackagesApi, "packages").mockImplementation((id) => Promise.resolve({ packages: [packageInfo(`npm:${id ?? "gateway"}`)] }));
  vi.spyOn(piPackagesApi, "install").mockResolvedValue({ action: "install", packages: [] });
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Mirror querySelector's caller-selected element type while failing on missing controls.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function query<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing ${selector}`);
  return element;
}

function root(element: LitElement): ShadowRoot {
  if (element.shadowRoot === null) throw new Error("Missing shadow root");
  return element.shadowRoot;
}

function button(element: LitElement, label: string): HTMLButtonElement {
  const match = Array.from(root(element).querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent.trim() === label);
  if (match === undefined) throw new Error(`Missing button ${label}`);
  return match;
}

// Drain Lit's follow-up renders and API promise continuations, including nested panels.
async function settle(element: LitElement): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await element.updateComplete;
    for (const child of root(element).querySelectorAll("*")) {
      if (child instanceof LitElement) await settleChild(child);
    }
  }
}

async function settleChild(element: LitElement): Promise<void> {
  await element.updateComplete;
  await element.updateComplete;
  for (const child of root(element).querySelectorAll("*")) {
    if (child instanceof LitElement) await settleChild(child);
  }
}

async function mount(): Promise<SettingsDialog> {
  const dialog = new SettingsDialog();
  dialog.machine = remoteMachine;
  dialog.machines = [gatewayMachine, remoteMachine, secondRemoteMachine];
  dialog.onNavigate = (section) => { dialog.section = section; };
  dialog.onRefreshMachineRuntime = vi.fn();
  document.body.append(dialog);
  await settle(dialog);
  return dialog;
}

function selector(dialog: SettingsDialog): HTMLSelectElement {
  return query(root(dialog), "select#settings-machine");
}

async function selectMachine(dialog: SettingsDialog, id: string): Promise<void> {
  const select = selector(dialog);
  select.value = id;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle(dialog);
}

async function navigate(dialog: SettingsDialog, section: SettingsSection, label: string): Promise<void> {
  const nav = query(root(dialog), "nav");
  const match = Array.from(nav.querySelectorAll("button")).find((candidate) => candidate.querySelector("strong")?.textContent === label);
  if (match === undefined) throw new Error(`Missing section ${label}`);
  match.click();
  await settle(dialog);
  expect(dialog.section).toBe(section);
}

function general(dialog: SettingsDialog): SettingsGeneralPanel {
  return query(root(dialog), "settings-general-panel");
}

function uploadInput(panel: SettingsGeneralPanel): HTMLInputElement {
  return query(root(panel), 'section[aria-label="Selected machine file access and upload settings"] input');
}

function hostInput(panel: SettingsGeneralPanel): HTMLInputElement {
  return query(root(panel), 'section[aria-label="Gateway server settings"] input');
}

async function edit(panel: LitElement, input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle(panel);
}

function submit(input: HTMLInputElement): void {
  if (input.form === null) throw new Error("Missing settings form");
  input.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

describe("settings-only machine selection DOM", () => {
  it("passes selected-machine naming models to the daemon panel and refreshes them", async () => {
    const models = [{ provider: "provider", id: "naming" }];
    vi.mocked(configApi.namingModels).mockResolvedValue({ models });
    const dialog = await mount();
    await navigate(dialog, "sessiond", "Session daemon");
    const panel = query<SettingsSessiondPanel>(root(dialog), "settings-sessiond-panel");

    expect(configApi.namingModels).toHaveBeenCalledWith(remoteMachine.id);
    expect(panel.namingModels).toEqual(models);
    expect(panel.namingModelsLoading).toBe(false);
    expect(panel.namingModelsError).toBe("");

    vi.mocked(configApi.namingModels).mockClear().mockResolvedValue({ models: [] });
    await panel.onReload?.();
    await settle(dialog);
    expect(configApi.namingModels).toHaveBeenCalledExactlyOnceWith(remoteMachine.id);
    expect(panel.namingModels).toEqual([]);
  });

  it("keeps daemon config editable when naming models fail to load", async () => {
    vi.mocked(configApi.namingModels).mockRejectedValue(new Error("Model catalog unavailable"));
    const dialog = await mount();
    await navigate(dialog, "sessiond", "Session daemon");
    const panel = query<SettingsSessiondPanel>(root(dialog), "settings-sessiond-panel");

    expect(panel.loading).toBe(false);
    expect(panel.error).toBe("");
    expect(panel.namingModelsLoading).toBe(false);
    expect(panel.namingModelsError).toContain("Model catalog unavailable");
    expect(panel.namingModelsError).toContain("Lab Mac");
    expect(query<HTMLInputElement>(root(panel), "#spawn-sessions").disabled).toBe(false);
  });

  it.each(["success", "failure"])("ignores stale naming-model %s after switching away and back", async (outcome) => {
    const stale = deferred<{ models: { provider: string; id: string }[] }>();
    const currentModels = [{ provider: "provider", id: "current" }];
    vi.mocked(configApi.namingModels).mockResolvedValue({ models: currentModels });
    const dialog = await mount();
    await navigate(dialog, "sessiond", "Session daemon");
    const panel = query<SettingsSessiondPanel>(root(dialog), "settings-sessiond-panel");
    vi.mocked(configApi.namingModels).mockReturnValueOnce(stale.promise);
    // Refresh the original target, then switch away and return before it finishes.
    const refresh = panel.onReload?.();
    await settle(dialog);
    expect(panel.namingModelsLoading).toBe(true);

    await selectMachine(dialog, secondRemoteMachine.id);
    expect(configApi.namingModels).toHaveBeenLastCalledWith(secondRemoteMachine.id);
    expect(panel.namingModels).toEqual(currentModels);
    await selectMachine(dialog, remoteMachine.id);
    if (outcome === "success") stale.resolve({ models: [{ provider: "old", id: "stale" }] });
    else stale.reject(new Error("Stale model error"));
    await refresh;
    await settle(dialog);

    expect(panel.namingModels).toEqual(currentModels);
    expect(panel.namingModelsLoading).toBe(false);
    expect(panel.namingModelsError).toBe("");
  });

  it("defaults to the current machine and retargets every machine endpoint and save without changing the workspace machine", async () => {
    const dialog = await mount();
    expect(selector(dialog).value).toBe(remoteMachine.id);
    expect(uploadInput(general(dialog)).value).toBe("remote-a/uploads");
    vi.mocked(configApi.config).mockClear();
    vi.mocked(pluginsApi.plugins).mockClear();
    vi.mocked(piPackagesApi.packages).mockClear();

    await selectMachine(dialog, secondRemoteMachine.id);
    expect(dialog.machine).toBe(remoteMachine);
    expect(selector(dialog).value).toBe(secondRemoteMachine.id);
    expect(vi.mocked(configApi.config).mock.calls).toEqual([["remote-b"], ["remote-b"], ["remote-b"]]);
    expect(pluginsApi.plugins).toHaveBeenCalledWith("remote-b");
    expect(piPackagesApi.packages).toHaveBeenCalledWith("remote-b");
    expect(dialog.onRefreshMachineRuntime).toHaveBeenLastCalledWith("remote-b");
    expect(uploadInput(general(dialog)).value).toBe("remote-b/uploads");
    await edit(general(dialog), uploadInput(general(dialog)), "new/uploads");
    submit(uploadInput(general(dialog)));
    await settle(dialog);
    expect(configApi.saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({ uploads: { defaultFolder: "new/uploads" } }), "remote-b");

    await navigate(dialog, "sessiond", "Session daemon");
    const sessiond = query<SettingsSessiondPanel>(root(dialog), "settings-sessiond-panel");
    expect(sessiond.configResponse?.config.uploads?.defaultFolder).toBe("remote-b/uploads");
    query<HTMLInputElement>(root(sessiond), "#spawn-sessions").click();
    await settle(dialog);
    expect(configApi.saveConfig).toHaveBeenLastCalledWith({ spawnSessions: false }, "remote-b");
    const namingBudget = query<HTMLInputElement>(root(sessiond), "#session-naming-max-tokens");
    namingBudget.value = "48";
    namingBudget.dispatchEvent(new Event("change"));
    await settle(dialog);
    expect(configApi.saveConfig).toHaveBeenLastCalledWith({ sessionNaming: { maxTokens: 48 } }, "remote-b");

    await navigate(dialog, "plugins", "PI WEB plugins");
    const plugins = query<SettingsPluginsPanel>(root(dialog), "settings-plugins-panel");
    query<HTMLInputElement>(root(plugins), 'input[aria-label="Enable info"]').click();
    await settle(dialog);
    expect(configApi.saveConfig).toHaveBeenLastCalledWith({ plugins: { info: { enabled: false } } }, "remote-b");

    await navigate(dialog, "packages", "Pi packages");
    const packages = query<SettingsPackagesPanel>(root(dialog), "settings-packages-panel");
    expect(packages.packagesResponse?.packages[0]?.source).toBe("npm:remote-b");
    await packages.onInstallPackage?.("npm:test-package");
    await settle(dialog);
    expect(piPackagesApi.install).toHaveBeenCalledWith("npm:test-package", "remote-b");
    expect(dialog.machine).toBe(remoteMachine);
  });

  it("keeps gateway, theme, browser and shortcut operations scoped here after switching", async () => {
    const dialog = await mount();
    const registry = new PluginRegistry();
    try {
      await registry.registerBatch([{ id: "themes", plugin: themePackPlugin }]);
      dialog.themes = registry.getThemes();
      dialog.actions = [{ id: "core:chat", title: "Chat", shortcut: "mod+1", run: () => undefined }];
      dialog.onUseLocalTheme = vi.fn();
      dialog.onUseDefaultTheme = vi.fn();
      dialog.hasLocalThemeOverride = true;
      await selectMachine(dialog, secondRemoteMachine.id);
      expect(hostInput(general(dialog)).value).toBe("gateway.local");
      await edit(general(dialog), hostInput(general(dialog)), "new.gateway.local");
      submit(hostInput(general(dialog)));
      await settle(dialog);
      expect(vi.mocked(configApi.saveConfig).mock.lastCall).toEqual([expect.objectContaining({ host: "new.gateway.local" })]);

      const theme = query<SettingsThemePanel>(root(dialog), "settings-theme-panel");
      button(theme, "Use in this browser").click();
      button(theme, "Use the default").click();
      expect(dialog.onUseLocalTheme).toHaveBeenCalledWith(dialog.themePreference);
      expect(dialog.onUseDefaultTheme).toHaveBeenCalledOnce();
      vi.mocked(configApi.config).mockClear();
      button(theme, "Set gateway default").click();
      await settle(dialog);
      expect(vi.mocked(configApi.config).mock.calls).toEqual([[]]);
      expect(vi.mocked(configApi.saveConfig).mock.lastCall).toEqual([{ ...gatewayConfig, defaultTheme: dialog.themePreference }]);

      await navigate(dialog, "shortcuts", "Keyboard shortcuts");
      const shortcuts = query<SettingsShortcutsPanel>(root(dialog), "settings-shortcuts-panel");
      expect(shortcuts.configResponse?.config.host).toBe("gateway.local");
      query<HTMLButtonElement>(root(shortcuts), '[aria-label="Disable shortcut for Chat"]').click();
      await settle(dialog);
      expect(vi.mocked(configApi.saveConfig).mock.lastCall).toEqual([expect.objectContaining({ shortcuts: { "core:chat": null } })]);
      expect(dialog.machine).toBe(remoteMachine);
    } finally {
      await registry.dispose();
    }
  });

  it("negotiates lifecycle support using the selected machineRuntimes entry, including subsequent capability updates", async () => {
    const dialog = await mount();
    dialog.machineRuntime = { machineId: remoteMachine.id, ok: true, checkedAt: "now", capabilities: [PI_WEB_CAPABILITIES.pluginLifecycle] };
    dialog.machineRuntimes = { "remote-b": { machineId: "remote-b", ok: true, checkedAt: "now", capabilities: [] } };
    vi.mocked(pluginsApi.plugins).mockClear();
    await selectMachine(dialog, "remote-b");
    expect(pluginsApi.plugins).not.toHaveBeenCalled();
    await navigate(dialog, "plugins", "PI WEB plugins");
    const panel = query<SettingsPluginsPanel>(root(dialog), "settings-plugins-panel");
    expect(panel.error).toContain("Plugin lifecycle diagnostics are not available on Build Box");
    expect(panel.configResponse).toBeDefined();
    expect(panel.recoveryCommandsSupported).toBe(false);
    dialog.machineRuntimes = { "remote-b": { machineId: "remote-b", ok: true, checkedAt: "later", capabilities: [PI_WEB_CAPABILITIES.pluginLifecycle] } };
    await settle(dialog);
    expect(pluginsApi.plugins).toHaveBeenCalledWith("remote-b");
    expect(panel.error).toBe("");
    expect(panel.recoveryCommandsSupported).toBe(true);
  });

  it("shows unavailable selected-machine status and connection guidance", async () => {
    const dialog = await mount();
    dialog.machineStatuses = { "remote-b": { machineId: "remote-b", ok: false, checkedAt: "now", status: "offline", error: "Connection refused" } };
    await selectMachine(dialog, "remote-b");
    const status = query(root(dialog), "#settings-machine-status");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("Unavailable");
    const guidance = query(root(dialog), "#settings-machine-error");
    expect(guidance.textContent).toContain("Connection refused");
    expect(guidance.textContent).toContain("Check the machine connection, then refresh settings.");
    expect(selector(dialog).getAttribute("aria-describedby")).toContain(status.id);
    expect(selector(dialog).getAttribute("aria-describedby")).toContain(guidance.id);
    expect(selector(dialog).disabled).toBe(false);
  });

  it("keeps machine controls out of the header and scope guidance collapsed until requested", async () => {
    const dialog = await mount();
    const select = selector(dialog);
    expect(select.closest("header")).toBeNull();
    expect(select.closest("main")).not.toBeNull();
    const details = query<HTMLDetailsElement>(root(dialog), "details.machine-scope");
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("Your browser theme, workspace, and session stay unchanged");
    query<HTMLElement>(details, "summary").click();
    expect(details.open).toBe(true);
    expect(root(dialog).querySelector("#settings-machine-error")).toBeNull();
  });

  it("hides the selector with only one registered machine", async () => {
    const dialog = await mount();
    dialog.machines = [remoteMachine];
    await settle(dialog);
    expect(root(dialog).querySelector("#settings-machine")).toBeNull();
    expect(uploadInput(general(dialog)).value).toBe("remote-a/uploads");
  });

  it("confirms dirty machine drafts while General is cached, keeps edits or discards only machine edits", async () => {
    const dialog = await mount();
    await edit(general(dialog), hostInput(general(dialog)), "unsaved.gateway.local");
    await edit(general(dialog), uploadInput(general(dialog)), "unsaved/uploads");
    await navigate(dialog, "packages", "Pi packages");
    vi.mocked(configApi.config).mockClear();
    await selectMachine(dialog, "remote-b");
    expect(selector(dialog).value).toBe("remote-a");
    expect(query(root(dialog), '[role="alert"]').textContent).toContain("Discard them and configure Build Box?");
    expect(configApi.config).not.toHaveBeenCalled();
    button(dialog, "Keep editing").click();
    await settle(dialog);
    expect(root(dialog).querySelector('[aria-label="Unsaved machine settings"]')).toBeNull();
    await navigate(dialog, "general", "General");
    expect(uploadInput(general(dialog)).value).toBe("unsaved/uploads");
    expect(hostInput(general(dialog)).value).toBe("unsaved.gateway.local");

    await navigate(dialog, "packages", "Pi packages");
    await selectMachine(dialog, "remote-b");
    button(dialog, "Discard edits and switch").click();
    await settle(dialog);
    expect(selector(dialog).value).toBe("remote-b");
    expect(dialog.section).toBe("packages");
    expect(dialog.machine).toBe(remoteMachine);
    await navigate(dialog, "general", "General");
    expect(uploadInput(general(dialog)).value).toBe("remote-b/uploads");
    expect(hostInput(general(dialog)).value).toBe("unsaved.gateway.local");
    // A gateway-only draft must not trigger the machine-discard prompt.
    await selectMachine(dialog, "remote-a");
    expect(selector(dialog).value).toBe("remote-a");
    expect(root(dialog).querySelector('[aria-label="Unsaved machine settings"]')).toBeNull();
    expect(hostInput(general(dialog)).value).toBe("unsaved.gateway.local");
    expect(configApi.saveConfig).not.toHaveBeenCalled();
  });

  it("ignores delayed loads after rapid selector changes, including returning to the original machine", async () => {
    const dialog = await mount();
    const config = deferred<PiWebConfigResponse>();
    const plugins = deferred<PiWebPluginsResponse>();
    const packages = deferred<PiPackagesResponse>();
    vi.mocked(configApi.config).mockImplementation(async (id) => id === "remote-b" ? config.promise : configResponse({ uploads: { defaultFolder: "current/uploads" } }));
    vi.mocked(pluginsApi.plugins).mockImplementation(async (id) => id === "remote-b" ? plugins.promise : pluginsResponse([pluginInfo("current", true)]));
    vi.mocked(piPackagesApi.packages).mockImplementation(async (id) => id === "remote-b" ? packages.promise : { packages: [packageInfo("npm:current")] });
    await selectMachine(dialog, "remote-b");
    await selectMachine(dialog, "remote-a");
    config.resolve(configResponse({ uploads: { defaultFolder: "stale/uploads" } }));
    plugins.resolve(pluginsResponse([pluginInfo("stale", true)]));
    packages.resolve({ packages: [packageInfo("npm:stale")] });
    await settle(dialog);
    expect(uploadInput(general(dialog)).value).toBe("current/uploads");
    await navigate(dialog, "sessiond", "Session daemon");
    expect(query<SettingsSessiondPanel>(root(dialog), "settings-sessiond-panel").configResponse?.config.uploads?.defaultFolder).toBe("current/uploads");
    await navigate(dialog, "plugins", "PI WEB plugins");
    expect(query<SettingsPluginsPanel>(root(dialog), "settings-plugins-panel").pluginsResponse?.plugins.map((plugin) => plugin.id)).toEqual(["current"]);
    await navigate(dialog, "packages", "Pi packages");
    expect(query<SettingsPackagesPanel>(root(dialog), "settings-packages-panel").packagesResponse?.packages.map((pkg) => pkg.source)).toEqual(["npm:current"]);
    expect(selector(dialog).value).toBe("remote-a");
  });
});
