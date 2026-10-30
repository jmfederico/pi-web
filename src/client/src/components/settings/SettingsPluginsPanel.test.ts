// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { PiWebConfigResponse, PiWebConfigValues, PiWebPluginInfo, PiWebPluginsResponse } from "../../api";
import { SettingsPluginsPanel, settingsPluginRows } from "./SettingsPluginsPanel";
import { SettingsPanelFrame } from "./SettingsPanelFrame";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("settings plugin rows", () => {
  it("uses saved enablement over stale lifecycle data and retains configured-only IDs", () => {
    const config = configResponse({ plugins: {
      "stale-ui": { enabled: false },
      "configured-only": { enabled: true, settings: { retained: true } },
    } });
    expect(settingsPluginRows(pluginsResponse([pluginInfo("stale-ui", true)]), config)).toEqual([
      expect.objectContaining({ id: "configured-only", enabled: true, configOnly: true, editable: true }),
      expect.objectContaining({ id: "stale-ui", enabled: false, configOnly: false, editable: true }),
    ]);
    expect(settingsPluginRows(undefined, config).map(({ id, editable }) => ({ id, editable }))).toEqual([
      { id: "configured-only", editable: true }, { id: "stale-ui", editable: true },
    ]);
  });

  it("keeps required Terminal enabled and non-editable despite saved disablement", () => {
    const config = configResponse({ plugins: { "pi-web.terminal": { enabled: false } } });
    const terminal = { ...pluginInfo("pi-web.terminal", true), required: true as const };
    for (const response of [pluginsResponse([terminal]), undefined]) {
      expect(settingsPluginRows(response, config)).toEqual([
        expect.objectContaining({ id: "pi-web.terminal", enabled: true, editable: false, required: true }),
      ]);
    }
  });
});

it("uses conservative restart guidance when a saved plugin's active lifecycle is unknown", async () => {
  const panel = new SettingsPluginsPanel();
  panel.configResponse = configResponse({ plugins: { provider: { enabled: false } } });
  panel.savedMessage = "Config saved.";
  document.body.append(panel);
  await panel.updateComplete;
  const frame = panel.shadowRoot?.querySelector("settings-panel-frame");
  if (!(frame instanceof SettingsPanelFrame)) throw new Error("Missing settings frame");
  await frame.updateComplete;
  expect(frame.shadowRoot?.textContent).toContain("Restart the session daemon");
  expect(frame.shadowRoot?.textContent).not.toContain("Reload this browser tab to apply browser-only plugin changes");
});

function configResponse(config: PiWebConfigValues): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json", exists: true, config, effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, sessionMessages: false, askUser: false },
  };
}

function pluginsResponse(plugins: PiWebPluginInfo[]): PiWebPluginsResponse {
  return {
    lifecycleVersion: 2, plugins, diagnostics: [],
    serverRuntime: {
      status: "available", terminalMode: "recovery-disabled", restartRequired: false,
      recovery: {
        showSafeStart: "pi-web plugins safe-start show",
        bundledOnly: "pi-web plugins safe-start set bundled-only --restart",
        noServerPlugins: "pi-web plugins safe-start set none --restart",
        clearSafeStart: "pi-web plugins safe-start clear --restart",
      },
    },
  };
}

function pluginInfo(id: string, enabled: boolean): PiWebPluginInfo {
  return {
    id, module: `/pi-web-plugins/${id}/plugin.js`, source: "test", scope: "local",
    machineSpecific: false, enabled, discovered: true, conflict: false,
  };
}
