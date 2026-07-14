import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_WEB_CAPABILITIES } from "../../../shared/capabilities";
import { configApi, pluginsApi, type PiWebConfigResponse, type PiWebPluginsResponse } from "../api";
import { SettingsDialog } from "./SettingsDialog";
import { callDialogPromise, callDialogUpdated, configResponse, deferred, getDialogProperty, pluginInfo, pluginsResponse, remoteMachine, runtimeWithPackageManagement as runtimeWithoutSelectedMachineSettings, secondRemoteMachine, setDialogProperty, stubWindowTimers } from "./SettingsDialog.testSupport";

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

  it("reloads desired config and the active runtime descriptor together", async () => {
    const config = configResponse({ agent: { command: "agent-lab", dir: "/srv/agent-lab" } });
    const configSpy = vi.spyOn(configApi, "config").mockResolvedValue(config);
    const runtimeRefresh = vi.fn(() => Promise.resolve());
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    dialog.onRefreshMachineRuntime = runtimeRefresh;

    await callDialogPromise(dialog, "reloadSessiondState");

    expect(configSpy).toHaveBeenCalledWith(remoteMachine.id);
    expect(runtimeRefresh).toHaveBeenCalledWith(remoteMachine.id);
    expect(getDialogProperty(dialog, "sessiondConfigResponse")).toBe(config);
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

  it("fails closed for a remote agent-profile save without granular support", async () => {
    const saveSpy = vi.spyOn(configApi, "saveConfig").mockResolvedValue(configResponse({ agent: { command: "agent-lab", dir: "/srv/agent-lab" } }));
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    dialog.machineRuntime = {
      machineId: remoteMachine.id,
      ok: true,
      checkedAt: "now",
      capabilities: [PI_WEB_CAPABILITIES.selectedMachineSettings],
    };

    await callDialogPromise(dialog, "saveSessiondConfig", { agent: { command: "agent-lab", dir: "/srv/agent-lab" } });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(getDialogProperty(dialog, "sessiondError")).toBe("Pi-compatible agent profile settings are not available on Lab Mac. Update and restart PI WEB on that machine, then try again.");
  });

  it("saves a remote agent profile when granular support is advertised", async () => {
    stubWindowTimers();
    const patch = { agent: { command: "agent-lab", dir: "/srv/agent-lab" } };
    const saved = configResponse(patch);
    const saveSpy = vi.spyOn(configApi, "saveConfig").mockResolvedValue(saved);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    dialog.machineRuntime = {
      machineId: remoteMachine.id,
      ok: true,
      checkedAt: "now",
      capabilities: [PI_WEB_CAPABILITIES.selectedMachineSettings, PI_WEB_CAPABILITIES.agentProfileConfig],
    };

    await callDialogPromise(dialog, "saveSessiondConfig", patch);

    expect(saveSpy).toHaveBeenCalledWith(patch, remoteMachine.id);
    expect(getDialogProperty(dialog, "sessiondConfigResponse")).toBe(saved);
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
