import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_WEB_CAPABILITIES } from "../../../shared/capabilities";
import { configApi, pluginsApi, type PiWebConfigResponse, type PiWebPluginsResponse } from "../api";
import { SettingsDialog } from "./SettingsDialog";
import { callDialogPromise, callDialogUpdated, configResponse, deferred, getDialogProperty, pluginInfo, pluginsResponse, remoteMachine, secondRemoteMachine, setDialogProperty, stubWindowTimers } from "./SettingsDialog.testSupport";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("settings-dialog plugin settings machine targeting", () => {
  it("loads plugin config and plugin list from the selected machine", async () => {
    const config = configResponse({ plugins: { info: { enabled: true } } });
    const plugins = pluginsResponse([pluginInfo("info", true)]);
    const configSpy = vi.spyOn(configApi, "config").mockResolvedValue(config);
    const pluginsSpy = vi.spyOn(pluginsApi, "plugins").mockResolvedValue(plugins);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "loadPluginsForTarget");

    expect(configSpy.mock.calls).toEqual([["remote-a"]]);
    expect(pluginsSpy.mock.calls).toEqual([["remote-a"]]);
    expect(getDialogProperty(dialog, "selectedPluginConfigResponse")).toBe(config);
    expect(getDialogProperty(dialog, "selectedPluginsResponse")).toBe(plugins);
    expect(getDialogProperty(dialog, "pluginError")).toBe("");
    expect(getDialogProperty(dialog, "pluginLoading")).toBe(false);
  });

  it("uses runtime capability negotiation to keep config editable without requesting an old remote lifecycle API", async () => {
    stubWindowTimers();
    const config = configResponse({ plugins: { info: { enabled: false } } });
    const saved = configResponse({ plugins: { info: { enabled: true } } });
    const configSpy = vi.spyOn(configApi, "config").mockResolvedValue(config);
    const saveSpy = vi.spyOn(configApi, "saveConfig").mockResolvedValue(saved);
    const pluginsSpy = vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([pluginInfo("info", false)]));
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    dialog.machineRuntime = {
      machineId: remoteMachine.id,
      ok: true,
      checkedAt: "now",
      capabilities: [],
    };

    await callDialogPromise(dialog, "loadPluginsForTarget");

    expect(configSpy).toHaveBeenCalledWith("remote-a");
    expect(pluginsSpy).not.toHaveBeenCalled();
    expect(getDialogProperty(dialog, "selectedPluginConfigResponse")).toBe(config);
    expect(getDialogProperty(dialog, "selectedPluginsResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "pluginError")).toContain("Plugin lifecycle diagnostics are not available on Lab Mac");

    await callDialogPromise(dialog, "togglePlugin", "info", true);

    expect(saveSpy).toHaveBeenCalledWith({ plugins: { info: { enabled: true } } }, "remote-a");
    expect(pluginsSpy).not.toHaveBeenCalled();
    expect(getDialogProperty(dialog, "selectedPluginConfigResponse")).toBe(saved);
    expect(getDialogProperty(dialog, "savedMessage")).toBe("Config saved.");
    expect(getDialogProperty(dialog, "pluginError")).toContain("Plugin lifecycle diagnostics are not available on Lab Mac");
  });

  it("loads remote lifecycle data when the plugin lifecycle capability is advertised", async () => {
    const config = configResponse({ plugins: { info: { enabled: true } } });
    const plugins = pluginsResponse([pluginInfo("info", true)]);
    vi.spyOn(configApi, "config").mockResolvedValue(config);
    const pluginsSpy = vi.spyOn(pluginsApi, "plugins").mockResolvedValue(plugins);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    dialog.machineRuntime = {
      machineId: remoteMachine.id,
      ok: true,
      checkedAt: "now",
      capabilities: [PI_WEB_CAPABILITIES.pluginLifecycle],
    };

    await callDialogPromise(dialog, "loadPluginsForTarget");

    expect(pluginsSpy).toHaveBeenCalledWith("remote-a");
    expect(getDialogProperty(dialog, "selectedPluginsResponse")).toBe(plugins);
    expect(getDialogProperty(dialog, "pluginError")).toBe("");
  });

  it("keeps fulfilled plugin config when the selected machine plugin list fails to load", async () => {
    const config = configResponse({ plugins: { info: { enabled: true } } });
    vi.spyOn(configApi, "config").mockResolvedValue(config);
    vi.spyOn(pluginsApi, "plugins").mockRejectedValue(new Error("route GET:/api/plugins not found"));
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "loadPluginsForTarget");

    expect(getDialogProperty(dialog, "selectedPluginConfigResponse")).toBe(config);
    expect(getDialogProperty(dialog, "selectedPluginsResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "pluginError")).toBe("Failed to load PI WEB plugin settings from Lab Mac (remote machine): PI WEB plugins: route GET:/api/plugins not found");
    expect(getDialogProperty(dialog, "pluginLoading")).toBe(false);
  });

  it("saves selected-machine plugin toggles as plugin-only patches and refreshes the selected machine plugin list", async () => {
    stubWindowTimers();
    const baseConfig = configResponse({
      plugins: {
        keep: { enabled: true, settings: { level: 1 } },
        info: { settings: { color: "blue" } },
      },
    });
    const savedConfig = configResponse({
      plugins: {
        keep: { enabled: true, settings: { level: 1 } },
        info: { enabled: false, settings: { color: "blue" } },
      },
    });
    const refreshedPlugins = pluginsResponse([pluginInfo("info", false), pluginInfo("keep", true)]);
    const saveSpy = vi.spyOn(configApi, "saveConfig").mockResolvedValue(savedConfig);
    const pluginsSpy = vi.spyOn(pluginsApi, "plugins").mockResolvedValue(refreshedPlugins);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    setDialogProperty(dialog, "selectedPluginConfigResponse", baseConfig);

    await callDialogPromise(dialog, "togglePlugin", "info", false);

    expect(saveSpy.mock.calls).toEqual([[
      {
        plugins: {
          keep: { enabled: true, settings: { level: 1 } },
          info: { enabled: false, settings: { color: "blue" } },
        },
      },
      "remote-a",
    ]]);
    expect(pluginsSpy.mock.calls).toEqual([["remote-a"]]);
    expect(getDialogProperty(dialog, "selectedPluginConfigResponse")).toBe(savedConfig);
    expect(getDialogProperty(dialog, "selectedPluginsResponse")).toBe(refreshedPlugins);
    expect(getDialogProperty(dialog, "savedMessage")).toBe("Config saved.");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("keeps a successful desired config save when active lifecycle refresh is unavailable", async () => {
    stubWindowTimers();
    const baseConfig = configResponse({ plugins: { info: { enabled: true, settings: { color: "blue" } } } });
    const savedConfig = configResponse({ plugins: { info: { enabled: false, settings: { color: "blue" } } } });
    const stalePlugins = pluginsResponse([pluginInfo("info", true)]);
    vi.spyOn(configApi, "saveConfig").mockResolvedValue(savedConfig);
    vi.spyOn(pluginsApi, "plugins").mockRejectedValue(new Error("Session daemon unavailable"));
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    setDialogProperty(dialog, "selectedPluginConfigResponse", baseConfig);
    setDialogProperty(dialog, "selectedPluginsResponse", stalePlugins);

    await callDialogPromise(dialog, "togglePlugin", "info", false);

    expect(getDialogProperty(dialog, "selectedPluginConfigResponse")).toBe(savedConfig);
    expect(getDialogProperty(dialog, "selectedPluginsResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "savedMessage")).toBe("Config saved.");
    expect(getDialogProperty(dialog, "pluginError")).toContain("Config saved, but failed to refresh PI WEB plugins");
  });

  it("merges local selected-machine plugin saves into gateway config without dropping gateway-only values", async () => {
    stubWindowTimers();
    const gatewayConfig = configResponse({
      host: "127.0.0.1",
      shortcuts: { "core:view.chat": "mod+1" },
      spawnSessions: false,
      plugins: { info: { enabled: false }, gateway: { settings: { theme: "dark" } } },
    });
    const savedConfig = configResponse({ plugins: { info: { enabled: true }, gateway: { settings: { theme: "dark" } } } });
    const refreshedPlugins = pluginsResponse([pluginInfo("info", true)]);
    const saveSpy = vi.spyOn(configApi, "saveConfig").mockResolvedValue(savedConfig);
    vi.spyOn(pluginsApi, "plugins").mockResolvedValue(refreshedPlugins);
    const onConfigSaved = vi.fn();
    const dialog = new SettingsDialog();
    dialog.onConfigSaved = onConfigSaved;
    setDialogProperty(dialog, "configResponse", gatewayConfig);
    setDialogProperty(dialog, "selectedPluginConfigResponse", configResponse({ plugins: { info: { enabled: false } } }));

    await callDialogPromise(dialog, "togglePlugin", "info", true);

    expect(saveSpy.mock.calls).toEqual([[{ plugins: { info: { enabled: true } } }, "local"]]);
    expect(getDialogProperty(dialog, "selectedPluginConfigResponse")).toBe(savedConfig);
    expect(getDialogProperty(dialog, "selectedPluginsResponse")).toBe(refreshedPlugins);
    expect(getDialogProperty(dialog, "configResponse")).toMatchObject({
      config: {
        host: "127.0.0.1",
        shortcuts: { "core:view.chat": "mod+1" },
        spawnSessions: false,
        plugins: { info: { enabled: true }, gateway: { settings: { theme: "dark" } } },
      },
      effectiveConfig: {
        host: "127.0.0.1",
        shortcuts: { "core:view.chat": "mod+1" },
        spawnSessions: false,
        plugins: { info: { enabled: true }, gateway: { settings: { theme: "dark" } } },
      },
    });
    expect(onConfigSaved).toHaveBeenCalledWith({
      host: "127.0.0.1",
      shortcuts: { "core:view.chat": "mod+1" },
      spawnSessions: false,
      plugins: { info: { enabled: true }, gateway: { settings: { theme: "dark" } } },
    });
  });

  it("ignores stale plugin load responses after the selected machine changes", async () => {
    const configLoad = deferred<PiWebConfigResponse>();
    const pluginsLoad = deferred<PiWebPluginsResponse>();
    vi.spyOn(configApi, "config").mockReturnValue(configLoad.promise);
    vi.spyOn(pluginsApi, "plugins").mockReturnValue(pluginsLoad.promise);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    const loadPromise = callDialogPromise(dialog, "loadPluginsForTarget");
    expect(getDialogProperty(dialog, "pluginLoading")).toBe(true);

    dialog.machine = secondRemoteMachine;
    callDialogUpdated(dialog, new Map([["machine", remoteMachine]]));
    configLoad.resolve(configResponse({ plugins: { info: { enabled: true } } }));
    pluginsLoad.resolve(pluginsResponse([pluginInfo("info", true)]));
    await loadPromise;

    expect(getDialogProperty(dialog, "selectedPluginConfigResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "selectedPluginsResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "pluginError")).toBe("");
    expect(getDialogProperty(dialog, "pluginLoading")).toBe(false);
  });

  it("ignores stale plugin save responses after the selected machine changes", async () => {
    const save = deferred<PiWebConfigResponse>();
    const pluginsSpy = vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([pluginInfo("info", false)]));
    vi.spyOn(configApi, "saveConfig").mockReturnValue(save.promise);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    setDialogProperty(dialog, "selectedPluginConfigResponse", configResponse({ plugins: { info: { enabled: true } } }));

    const savePromise = callDialogPromise(dialog, "togglePlugin", "info", false);
    expect(getDialogProperty(dialog, "saving")).toBe(true);

    dialog.machine = secondRemoteMachine;
    callDialogUpdated(dialog, new Map([["machine", remoteMachine]]));
    save.resolve(configResponse({ plugins: { info: { enabled: false } } }));
    await savePromise;

    expect(pluginsSpy).not.toHaveBeenCalled();
    expect(getDialogProperty(dialog, "selectedPluginConfigResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "selectedPluginsResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "savedMessage")).toBe("");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });
});
