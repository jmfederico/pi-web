// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configApi, piPackagesApi, pluginsApi } from "../api";
import { PluginRegistry } from "../plugins/registry";
import { builtInThemeCatalog } from "../themeCatalog.testSupport";
import * as themeCatalog from "../themeCatalog";
import { SettingsDialog } from "./SettingsDialog";
import { configResponse, deferred, pluginsResponse, remoteMachine } from "./SettingsDialog.testSupport";
import { SettingsThemePanel } from "./settings/SettingsThemePanel";

beforeEach(() => {
  vi.spyOn(themeCatalog, "loadThemeCatalog").mockResolvedValue(builtInThemeCatalog());
  vi.spyOn(configApi, "config").mockResolvedValue(configResponse({}));
  vi.spyOn(configApi, "namingModels").mockResolvedValue({ models: [] });
  vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([]));
  vi.spyOn(piPackagesApi, "packages").mockResolvedValue({ packages: [] });
});

const registries: PluginRegistry[] = [];
afterEach(async () => {
  document.body.replaceChildren();
  for (const registry of registries.splice(0)) await registry.dispose();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("saving a theme default", () => {
  it("loads inventory on first General visit and retries failures only explicitly", async () => {
    const pending = deferred<themeCatalog.BrowserThemeCatalog>();
    vi.mocked(themeCatalog.loadThemeCatalog).mockReturnValueOnce(pending.promise);
    const loaded = vi.fn();
    const dialog = new SettingsDialog();
    dialog.section = "shortcuts";
    dialog.onThemeCatalogLoaded = loaded;
    document.body.append(dialog);
    await dialog.updateComplete;
    expect(themeCatalog.loadThemeCatalog).not.toHaveBeenCalled();

    dialog.section = "general";
    await dialog.updateComplete;
    await dialog.updateComplete;
    const panel = themePanel(dialog);
    await panel.updateComplete;
    expect(themeCatalog.loadThemeCatalog).toHaveBeenCalledOnce();
    expect(requiredSelect(panel).disabled).toBe(true);
    pending.reject(new Error("Catalog request failed"));
    await vi.waitFor(() => {
      expect(panel.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("Catalog request failed");
    });
    dialog.section = "shortcuts";
    await dialog.updateComplete;
    dialog.section = "general";
    await dialog.updateComplete;
    expect(themeCatalog.loadThemeCatalog).toHaveBeenCalledOnce();
    await themePanel(dialog).updateComplete;
    button(themePanel(dialog), "Retry").click();
    await vi.waitFor(() => { expect(loaded).toHaveBeenCalledExactlyOnceWith(builtInThemeCatalog()); });
    dialog.section = "shortcuts";
    await dialog.updateComplete;
    dialog.section = "general";
    await dialog.updateComplete;
    expect(themeCatalog.loadThemeCatalog).toHaveBeenCalledTimes(2);
    expect(dialog.themePreference).toEqual({ themeId: "themes:pi-web-dark", auto: true });
  });

  it("does not register inventory after the dialog disconnects", async () => {
    const pending = deferred<themeCatalog.BrowserThemeCatalog>();
    vi.mocked(themeCatalog.loadThemeCatalog).mockReturnValueOnce(pending.promise);
    const loaded = vi.fn();
    const dialog = new SettingsDialog();
    dialog.onThemeCatalogLoaded = loaded;
    document.body.append(dialog);
    await dialog.updateComplete;
    dialog.remove();
    pending.resolve(builtInThemeCatalog());
    await pending.promise;
    expect(loaded).not.toHaveBeenCalled();
  });

  it("patches only the gateway theme even with a remote machine selected", async () => {
    const dialog = await mountDialog();
    const onSaved = vi.fn();
    dialog.onConfigSaved = onSaved;
    dialog.machine = remoteMachine;
    await dialog.updateComplete;
    const current = { host: "127.0.0.1", shortcuts: { "core:view.chat": "mod+1" }, plugins: { info: { enabled: true } } };
    const defaultTheme = { themeId: "themes:pi-web-dark", auto: true };
    vi.mocked(configApi.config).mockResolvedValue(configResponse(current));
    const save = vi.spyOn(configApi, "updateConfig").mockResolvedValue(configResponse({ ...current, defaultTheme }));
    vi.mocked(configApi.config).mockClear();
    button(themePanel(dialog), "Set gateway default").click();
    await vi.waitFor(() => { expect(save).toHaveBeenCalledWith({ set: { defaultTheme } }); });
    await vi.waitFor(() => { expect(onSaved).toHaveBeenCalledWith({ ...current, defaultTheme }); });
    expect(vi.mocked(configApi.config).mock.calls).not.toContainEqual([]);
    expect(save.mock.calls).toHaveLength(1);
  });

  it("reports a failed save without applying a new default", async () => {
    const dialog = await mountDialog();
    const onSaved = vi.fn();
    dialog.onConfigSaved = onSaved;
    vi.spyOn(configApi, "updateConfig").mockRejectedValue(new Error("Disk is read-only"));
    button(themePanel(dialog), "Set gateway default").click();
    await vi.waitFor(() => { expect(generalPanel(dialog).error).toContain("Couldn't save the default theme: Disk is read-only"); });
    expect(onSaved).not.toHaveBeenCalled();
    expect(themePanel(dialog).defaultPreference).toEqual({ themeId: "themes:pi-web-dark", auto: true });
  });
});

async function mountDialog(): Promise<SettingsDialog> {
  const registry = new PluginRegistry();
  registries.push(registry);
  const catalog = builtInThemeCatalog();
  registry.setDeclarativeThemes(catalog.themes, catalog.themePairs);
  const dialog = new SettingsDialog();
  dialog.themes = registry.getThemes();
  document.body.append(dialog);
  await vi.waitFor(() => {
    expect(themePanel(dialog).loading).toBe(false);
    expect(themePanel(dialog).catalogLoading).toBe(false);
  });
  await themePanel(dialog).updateComplete;
  return dialog;
}

function generalPanel(dialog: SettingsDialog): import("./settings/SettingsGeneralPanel").SettingsGeneralPanel {
  const panel = dialog.shadowRoot?.querySelector<import("./settings/SettingsGeneralPanel").SettingsGeneralPanel>("settings-general-panel");
  if (panel == null) throw new Error("Expected General settings");
  return panel;
}

function themePanel(dialog: SettingsDialog): SettingsThemePanel {
  const panel = generalPanel(dialog).querySelector<SettingsThemePanel>("settings-theme-panel");
  if (panel == null) throw new Error("Expected theme settings");
  return panel;
}

function requiredSelect(panel: SettingsThemePanel): HTMLSelectElement {
  const select = panel.shadowRoot?.querySelector("select");
  if (select == null) throw new Error("Expected theme selector");
  return select;
}

function button(panel: SettingsThemePanel, label: string): HTMLButtonElement {
  const control = [...panel.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? []].find((element) => element.textContent === label);
  if (control === undefined) throw new Error(`Expected ${label}`);
  return control;
}
