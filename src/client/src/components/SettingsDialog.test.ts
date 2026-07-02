import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_WEB_CAPABILITIES } from "../../../shared/capabilities";
import { configApi, pluginsApi, type Machine, type MachineRuntime, type PiWebConfigResponse, type PiWebConfigValues, type PiWebPluginInfo, type PiWebPluginsResponse } from "../api";
import { SettingsDialog } from "./SettingsDialog";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("settings-dialog session daemon machine targeting", () => {
  it("keeps gateway settings loads on the gateway config/plugin endpoints", async () => {
    const config = configResponse({ host: "127.0.0.1" });
    const plugins: PiWebPluginsResponse = { plugins: [] };
    const configSpy = vi.spyOn(configApi, "config").mockResolvedValue(config);
    const pluginsSpy = vi.spyOn(pluginsApi, "plugins").mockResolvedValue(plugins);
    const dialog = new SettingsDialog();

    await callDialogPromise(dialog, "loadConfig");

    expect(configSpy.mock.calls).toEqual([[]]);
    expect(pluginsSpy.mock.calls).toEqual([[]]);
    expect(getDialogProperty(dialog, "configResponse")).toBe(config);
    expect(getDialogProperty(dialog, "pluginsResponse")).toBe(plugins);
    expect(getDialogProperty(dialog, "error")).toBe("");
    expect(getDialogProperty(dialog, "loading")).toBe(false);
  });

  it("loads session-daemon config from the selected machine", async () => {
    const config = configResponse({ spawnSessions: false, subsessions: true });
    const configSpy = vi.spyOn(configApi, "config").mockResolvedValue(config);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "loadSessiondConfigForTarget");

    expect(configSpy.mock.calls).toEqual([["remote-a"]]);
    expect(getDialogProperty(dialog, "sessiondConfigResponse")).toBe(config);
    expect(getDialogProperty(dialog, "sessiondError")).toBe("");
    expect(getDialogProperty(dialog, "sessiondLoading")).toBe(false);
  });

  it("saves local session-daemon config through the local machine alias and updates local daemon state", async () => {
    stubWindowTimers();
    const gatewayConfig = configResponse({ host: "127.0.0.1", spawnSessions: false, subsessions: false });
    const savedConfig = configResponse({ spawnSessions: true });
    const saveSpy = vi.spyOn(configApi, "saveConfig").mockResolvedValue(savedConfig);
    const dialog = new SettingsDialog();
    setDialogProperty(dialog, "configResponse", gatewayConfig);

    await callDialogPromise(dialog, "saveSessiondConfig", { spawnSessions: true });

    expect(saveSpy.mock.calls).toEqual([[{ spawnSessions: true }, "local"]]);
    expect(getDialogProperty(dialog, "sessiondConfigResponse")).toBe(savedConfig);
    expect(getDialogProperty(dialog, "configResponse")).toMatchObject({ config: { host: "127.0.0.1", spawnSessions: true, subsessions: false } });
    expect(getDialogProperty(dialog, "savedMessage")).toBe("Config saved.");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("ignores stale session-daemon load responses after the selected machine changes", async () => {
    const load = deferred<PiWebConfigResponse>();
    vi.spyOn(configApi, "config").mockReturnValue(load.promise);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    const loadPromise = callDialogPromise(dialog, "loadSessiondConfigForTarget");
    expect(getDialogProperty(dialog, "sessiondLoading")).toBe(true);

    dialog.machine = secondRemoteMachine;
    callDialogUpdated(dialog, new Map([["machine", remoteMachine]]));
    load.resolve(configResponse({ spawnSessions: false }));
    await loadPromise;

    expect(getDialogProperty(dialog, "sessiondConfigResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "sessiondError")).toBe("");
    expect(getDialogProperty(dialog, "sessiondLoading")).toBe(false);
  });

  it("ignores stale session-daemon save responses after the selected machine changes", async () => {
    stubWindowTimers();
    const save = deferred<PiWebConfigResponse>();
    vi.spyOn(configApi, "saveConfig").mockReturnValue(save.promise);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    const savePromise = callDialogPromise(dialog, "saveSessiondConfig", { subsessions: true });
    expect(getDialogProperty(dialog, "saving")).toBe(true);

    dialog.machine = secondRemoteMachine;
    save.resolve(configResponse({ subsessions: true }));
    await savePromise;

    expect(getDialogProperty(dialog, "sessiondConfigResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "savedMessage")).toBe("");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("skips selected-machine settings loads when the remote runtime does not advertise support", async () => {
    const configSpy = vi.spyOn(configApi, "config").mockResolvedValue(configResponse({ spawnSessions: true }));
    const pluginsSpy = vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([pluginInfo("info", true)]));
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    dialog.machineRuntime = runtimeWithoutSelectedMachineSettings;

    await callDialogPromise(dialog, "loadSessiondConfigForTarget");
    await callDialogPromise(dialog, "loadAccessConfigForTarget");
    await callDialogPromise(dialog, "loadPluginsForTarget");

    expect(configSpy).not.toHaveBeenCalled();
    expect(pluginsSpy).not.toHaveBeenCalled();
    expect(getDialogProperty(dialog, "sessiondConfigResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "accessConfigResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "selectedPluginConfigResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "sessiondError")).toBe("Selected-machine settings are not available on Lab Mac. Update and restart PI WEB on that machine, then try again.");
    expect(getDialogProperty(dialog, "accessError")).toBe("Selected-machine settings are not available on Lab Mac. Update and restart PI WEB on that machine, then try again.");
    expect(getDialogProperty(dialog, "pluginError")).toBe("Selected-machine settings are not available on Lab Mac. Update and restart PI WEB on that machine, then try again.");
  });

  it("does not save remote selected-machine settings when runtime support is missing", async () => {
    const saveSpy = vi.spyOn(configApi, "saveConfig").mockResolvedValue(configResponse({ spawnSessions: true }));
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    dialog.machineRuntime = runtimeWithoutSelectedMachineSettings;
    setDialogProperty(dialog, "selectedPluginConfigResponse", configResponse({ plugins: { info: { enabled: true } } }));

    await callDialogPromise(dialog, "saveSessiondConfig", { spawnSessions: true });
    await callDialogPromise(dialog, "saveMachineAccessConfig", { pathAccess: { allowedPaths: ["/mnt/share"] } });
    await callDialogPromise(dialog, "togglePlugin", "info", false);

    expect(saveSpy).not.toHaveBeenCalled();
    expect(getDialogProperty(dialog, "sessiondError")).toBe("Selected-machine settings are not available on Lab Mac. Update and restart PI WEB on that machine, then try again.");
    expect(getDialogProperty(dialog, "accessError")).toBe("Selected-machine settings are not available on Lab Mac. Update and restart PI WEB on that machine, then try again.");
    expect(getDialogProperty(dialog, "pluginError")).toBe("Selected-machine settings are not available on Lab Mac. Update and restart PI WEB on that machine, then try again.");
  });

  it("shows selected-machine settings errors with the selected target name", async () => {
    vi.spyOn(configApi, "config").mockRejectedValue(new Error("Remote machine unavailable"));
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "loadSessiondConfigForTarget");

    expect(getDialogProperty(dialog, "sessiondError")).toBe("Failed to load session-daemon config from Lab Mac (remote machine): Could not reach Lab Mac for selected-machine settings. Check the machine connection and try again.");
    expect(getDialogProperty(dialog, "sessiondLoading")).toBe(false);
  });
});

describe("settings-dialog general settings machine targeting", () => {
  it("describes the General tab as gateway server plus selected-machine file/upload settings", () => {
    const dialog = new SettingsDialog();
    dialog.section = "general";
    dialog.machine = remoteMachine;

    expect(callDialogMethod(dialog, "settingsScopeMessage")).toBe("Gateway server config and selected machine file/upload config: Lab Mac (remote machine).");
  });

  it("keeps gateway server config saves on the gateway config endpoint", async () => {
    stubWindowTimers();
    const savedConfig = configResponse({ host: "0.0.0.0", port: 9000, allowedHosts: true });
    const saveSpy = vi.spyOn(configApi, "saveConfig").mockResolvedValue(savedConfig);
    const onConfigSaved = vi.fn();
    const dialog = new SettingsDialog();
    dialog.onConfigSaved = onConfigSaved;

    await callDialogPromise(dialog, "saveConfig", { host: "0.0.0.0", port: 9000, allowedHosts: true });

    expect(saveSpy.mock.calls).toEqual([[{ host: "0.0.0.0", port: 9000, allowedHosts: true }]]);
    expect(getDialogProperty(dialog, "configResponse")).toBe(savedConfig);
    expect(onConfigSaved).toHaveBeenCalledWith({ host: "0.0.0.0", port: 9000, allowedHosts: true });
    expect(getDialogProperty(dialog, "savedMessage")).toBe("Config saved.");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("loads file access and upload config from the selected machine", async () => {
    const config = configResponse({ pathAccess: { allowedPaths: ["/mnt/share"] }, uploads: { defaultFolder: "manual/uploads" } });
    const configSpy = vi.spyOn(configApi, "config").mockResolvedValue(config);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "loadAccessConfigForTarget");

    expect(configSpy.mock.calls).toEqual([["remote-a"]]);
    expect(getDialogProperty(dialog, "accessConfigResponse")).toBe(config);
    expect(getDialogProperty(dialog, "accessError")).toBe("");
    expect(getDialogProperty(dialog, "accessLoading")).toBe(false);
  });

  it("saves selected-machine file access and upload config through the selected-machine endpoint", async () => {
    stubWindowTimers();
    const patch = { pathAccess: { allowedPaths: ["/mnt/share", "~/SDKs"] }, uploads: { defaultFolder: "manual/uploads" } };
    const savedConfig = configResponse(patch);
    const saveSpy = vi.spyOn(configApi, "saveConfig").mockResolvedValue(savedConfig);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "saveMachineAccessConfig", patch);

    expect(saveSpy.mock.calls).toEqual([[patch, "remote-a"]]);
    expect(getDialogProperty(dialog, "accessConfigResponse")).toBe(savedConfig);
    expect(getDialogProperty(dialog, "configResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "savedMessage")).toBe("Config saved.");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("merges local selected-machine access saves into gateway config without dropping gateway-only values", async () => {
    stubWindowTimers();
    const gatewayConfig = configResponse({
      host: "127.0.0.1",
      port: 8504,
      allowedHosts: ["gateway.local"],
      shortcuts: { "core:view.chat": "mod+1" },
      plugins: { info: { enabled: true } },
      spawnSessions: false,
      pathAccess: { allowedPaths: ["/old"] },
      uploads: { defaultFolder: "old/uploads" },
      maxUploadBytes: 1234,
    });
    const patch = { pathAccess: { allowedPaths: ["~/SDKs"] }, uploads: {} };
    const savedConfig = configResponse({ pathAccess: { allowedPaths: ["~/SDKs"] }, uploads: {}, maxUploadBytes: 5678 });
    const saveSpy = vi.spyOn(configApi, "saveConfig").mockResolvedValue(savedConfig);
    const onConfigSaved = vi.fn();
    const dialog = new SettingsDialog();
    dialog.onConfigSaved = onConfigSaved;
    setDialogProperty(dialog, "configResponse", gatewayConfig);

    await callDialogPromise(dialog, "saveMachineAccessConfig", patch);

    expect(saveSpy.mock.calls).toEqual([[patch, "local"]]);
    expect(getDialogProperty(dialog, "accessConfigResponse")).toBe(savedConfig);
    expect(getDialogProperty(dialog, "configResponse")).toMatchObject({
      config: {
        host: "127.0.0.1",
        port: 8504,
        allowedHosts: ["gateway.local"],
        shortcuts: { "core:view.chat": "mod+1" },
        plugins: { info: { enabled: true } },
        spawnSessions: false,
        pathAccess: { allowedPaths: ["~/SDKs"] },
        uploads: {},
        maxUploadBytes: 5678,
      },
      effectiveConfig: {
        host: "127.0.0.1",
        port: 8504,
        allowedHosts: ["gateway.local"],
        shortcuts: { "core:view.chat": "mod+1" },
        plugins: { info: { enabled: true } },
        spawnSessions: false,
        pathAccess: { allowedPaths: ["~/SDKs"] },
        uploads: {},
        maxUploadBytes: 5678,
      },
    });
    expect(onConfigSaved).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 8504,
      allowedHosts: ["gateway.local"],
      shortcuts: { "core:view.chat": "mod+1" },
      plugins: { info: { enabled: true } },
      spawnSessions: false,
      pathAccess: { allowedPaths: ["~/SDKs"] },
      uploads: {},
      maxUploadBytes: 5678,
    });
  });

  it("ignores stale file access load responses after the selected machine changes", async () => {
    const load = deferred<PiWebConfigResponse>();
    vi.spyOn(configApi, "config").mockReturnValue(load.promise);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    const loadPromise = callDialogPromise(dialog, "loadAccessConfigForTarget");
    expect(getDialogProperty(dialog, "accessLoading")).toBe(true);

    dialog.machine = secondRemoteMachine;
    callDialogUpdated(dialog, new Map([["machine", remoteMachine]]));
    load.resolve(configResponse({ pathAccess: { allowedPaths: ["/stale"] } }));
    await loadPromise;

    expect(getDialogProperty(dialog, "accessConfigResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "accessError")).toBe("");
    expect(getDialogProperty(dialog, "accessLoading")).toBe(false);
  });

  it("ignores stale file access save responses after the selected machine changes", async () => {
    const save = deferred<PiWebConfigResponse>();
    vi.spyOn(configApi, "saveConfig").mockReturnValue(save.promise);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    const savePromise = callDialogPromise(dialog, "saveMachineAccessConfig", { pathAccess: { allowedPaths: ["/mnt/share"] }, uploads: { defaultFolder: "manual" } });
    expect(getDialogProperty(dialog, "saving")).toBe(true);

    dialog.machine = secondRemoteMachine;
    callDialogUpdated(dialog, new Map([["machine", remoteMachine]]));
    save.resolve(configResponse({ pathAccess: { allowedPaths: ["/mnt/share"] }, uploads: { defaultFolder: "manual" } }));
    await savePromise;

    expect(getDialogProperty(dialog, "accessConfigResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "savedMessage")).toBe("");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("shows selected-machine file access errors with the selected target name", async () => {
    vi.spyOn(configApi, "config").mockRejectedValue(new Error("Remote machine unavailable"));
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "loadAccessConfigForTarget");

    expect(getDialogProperty(dialog, "accessError")).toBe("Failed to load file access/upload config from Lab Mac (remote machine): Could not reach Lab Mac for selected-machine settings. Check the machine connection and try again.");
    expect(getDialogProperty(dialog, "accessLoading")).toBe(false);
  });
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

  it("keeps fulfilled plugin config when the selected machine plugin list is unsupported", async () => {
    const config = configResponse({ plugins: { info: { enabled: true } } });
    vi.spyOn(configApi, "config").mockResolvedValue(config);
    vi.spyOn(pluginsApi, "plugins").mockRejectedValue(new Error("route GET:/api/plugins not found"));
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "loadPluginsForTarget");

    expect(getDialogProperty(dialog, "selectedPluginConfigResponse")).toBe(config);
    expect(getDialogProperty(dialog, "selectedPluginsResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "pluginError")).toBe("Failed to load PI WEB plugin settings from Lab Mac (remote machine): PI WEB plugins: Selected-machine settings are not available on Lab Mac. Update and restart PI WEB on that machine, then try again.");
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

const remoteMachine: Machine = {
  id: "remote-a",
  name: "Lab Mac",
  kind: "remote",
  baseUrl: "https://lab.example.test",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const secondRemoteMachine: Machine = {
  id: "remote-b",
  name: "Build Box",
  kind: "remote",
  baseUrl: "https://build.example.test",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const runtimeWithoutSelectedMachineSettings: MachineRuntime = {
  machineId: "remote-a",
  ok: true,
  checkedAt: "2026-07-01T00:00:00.000Z",
  capabilities: [PI_WEB_CAPABILITIES.piPackagesManage],
};

function getDialogProperty(dialog: SettingsDialog, property: string): unknown {
  return Reflect.get(dialog, property);
}

function setDialogProperty(dialog: SettingsDialog, property: string, value: unknown): void {
  if (!Reflect.set(dialog, property, value)) throw new Error(`Failed to set SettingsDialog property ${property}`);
}

async function callDialogPromise(dialog: SettingsDialog, methodName: string, ...args: readonly unknown[]): Promise<void> {
  const result = callDialogMethod(dialog, methodName, ...args);
  if (!(result instanceof Promise)) throw new Error(`SettingsDialog.${methodName} did not return a promise`);
  await result;
}

function callDialogUpdated(dialog: SettingsDialog, changed: Map<string, unknown>): void {
  const result = callDialogMethod(dialog, "updated", changed);
  if (result !== undefined) throw new Error("SettingsDialog.updated returned an unexpected value");
}

function callDialogMethod(dialog: SettingsDialog, methodName: string, ...args: readonly unknown[]): unknown {
  const method: unknown = Reflect.get(dialog, methodName);
  if (!isDialogMethod(method)) throw new Error(`SettingsDialog.${methodName} is not callable`);
  return method.call(dialog, ...args);
}

function isDialogMethod(value: unknown): value is (this: SettingsDialog, ...args: readonly unknown[]) => unknown {
  return typeof value === "function";
}

function configResponse(config: PiWebConfigValues): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false },
  };
}

function pluginsResponse(plugins: PiWebPluginInfo[]): PiWebPluginsResponse {
  return { plugins };
}

function pluginInfo(id: string, enabled: boolean): PiWebPluginInfo {
  return {
    id,
    module: `/pi-web-plugins/${id}/plugin.js`,
    source: "test",
    scope: "local",
    machineSpecific: false,
    enabled,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolveDeferred: ((value: T) => void) | undefined;
  let rejectDeferred: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  if (resolveDeferred === undefined || rejectDeferred === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

function stubWindowTimers(): void {
  vi.stubGlobal("window", {
    clearTimeout: vi.fn(),
    setTimeout: vi.fn(() => 1),
  });
}
