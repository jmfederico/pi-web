// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configApi, piPackagesApi, pluginsApi } from "../api";
import { PluginRegistry } from "../plugins/registry";
import { themePackPlugin } from "../plugins/themes";
import { SettingsDialog } from "./SettingsDialog";
import { configResponse, pluginsResponse, remoteMachine } from "./SettingsDialog.testSupport";
import { SettingsThemePanel } from "./settings/SettingsThemePanel";

beforeEach(() => {
  vi.spyOn(configApi, "config").mockResolvedValue(configResponse({}));
  vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([]));
  vi.spyOn(piPackagesApi, "packages").mockResolvedValue({ packages: [] });
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("saving a theme default", () => {
  it("uses fresh gateway config even with a remote machine selected, preserving other keys", async () => {
    const dialog = await mountDialog();
    const onSaved = vi.fn();
    dialog.onConfigSaved = onSaved;
    dialog.machine = remoteMachine;
    await dialog.updateComplete;
    const current = { host: "127.0.0.1", shortcuts: { "core:view.chat": "mod+1" }, plugins: { info: { enabled: true } } };
    const defaultTheme = { themeId: "themes:pi-web-dark", auto: true };
    vi.mocked(configApi.config).mockResolvedValue(configResponse(current));
    const save = vi.spyOn(configApi, "saveConfig").mockResolvedValue(configResponse({ ...current, defaultTheme }));
    vi.mocked(configApi.config).mockClear();
    button(themePanel(dialog), "Set as default").click();
    await vi.waitFor(() => { expect(save).toHaveBeenCalledWith({ ...current, defaultTheme }); });
    await vi.waitFor(() => { expect(onSaved).toHaveBeenCalledWith({ ...current, defaultTheme }); });
    expect(vi.mocked(configApi.config).mock.calls).toContainEqual([]);
    expect(save.mock.calls).toHaveLength(1);
  });

  it("reports a failed save without applying a new default", async () => {
    const dialog = await mountDialog();
    const onSaved = vi.fn();
    dialog.onConfigSaved = onSaved;
    vi.spyOn(configApi, "saveConfig").mockRejectedValue(new Error("Disk is read-only"));
    button(themePanel(dialog), "Set as default").click();
    await vi.waitFor(() => { expect(generalPanel(dialog).error).toContain("Failed to save default theme: Disk is read-only"); });
    expect(onSaved).not.toHaveBeenCalled();
    expect(themePanel(dialog).defaultPreference).toEqual({ themeId: "themes:pi-web-dark", auto: true });
  });
});

async function mountDialog(): Promise<SettingsDialog> {
  const registry = new PluginRegistry();
  await registry.registerBatch([{ id: "themes", plugin: themePackPlugin }]);
  const dialog = new SettingsDialog();
  dialog.themes = registry.getThemes();
  document.body.append(dialog);
  await vi.waitFor(() => { expect(themePanel(dialog).loading).toBe(false); });
  await themePanel(dialog).updateComplete;
  await registry.dispose();
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

function button(panel: SettingsThemePanel, label: string): HTMLButtonElement {
  const control = [...panel.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? []].find((element) => element.textContent === label);
  if (control === undefined) throw new Error(`Expected ${label}`);
  return control;
}
