import { afterEach, describe, expect, it, vi } from "vitest";
import { configApi, pluginsApi, type PiWebConfigResponse } from "../api";
import { SettingsDialog } from "./SettingsDialog";
import { callDialogPromise, callDialogUpdated, configResponse, deferred, getDialogProperty, pluginsResponse, remoteMachine, secondRemoteMachine, setDialogProperty, stubWindowTimers } from "./SettingsDialog.testSupport";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("settings-dialog general settings machine targeting", () => {
  it("keeps gateway server config saves on the gateway config endpoint", async () => {
    stubWindowTimers();
    const savedConfig = configResponse({ host: "0.0.0.0", port: 9000, allowedHosts: true });
    const saveSpy = vi.spyOn(configApi, "updateConfig").mockResolvedValue(savedConfig);
    const onConfigSaved = vi.fn();
    const dialog = new SettingsDialog();
    dialog.onConfigSaved = onConfigSaved;
    const onGatewayConfigLoaded = vi.fn();
    dialog.onGatewayConfigLoaded = onGatewayConfigLoaded;

    await callDialogPromise(dialog, "saveConfig", { host: "0.0.0.0", port: 9000, allowedHosts: true });

    expect(saveSpy.mock.calls).toEqual([[{ set: { host: "0.0.0.0", port: 9000, allowedHosts: true }, unset: [] }]]);
    expect(getDialogProperty(dialog, "configResponse")).toBe(savedConfig);
    expect(onGatewayConfigLoaded).toHaveBeenCalledExactlyOnceWith(savedConfig);
    expect(onConfigSaved).toHaveBeenCalledWith({ host: "0.0.0.0", port: 9000, allowedHosts: true });
    expect(getDialogProperty(dialog, "savedMessage")).toBe("Gateway settings saved. Restart the web/API service to apply network and Host validation changes.");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("saves only quiet mode on the gateway endpoint without reading or replacing unrelated settings", async () => {
    stubWindowTimers();
    const current = configResponse({ host: "127.0.0.1", shortcuts: { "core:view.chat": "mod+1" } });
    const savedConfig = configResponse({ ...current.config, quietMode: true });
    const configSpy = vi.spyOn(configApi, "config").mockResolvedValue(current);
    const saveSpy = vi.spyOn(configApi, "updateConfig").mockResolvedValue(savedConfig);
    const onConfigSaved = vi.fn();
    const dialog = new SettingsDialog();
    dialog.onConfigSaved = onConfigSaved;

    await callDialogPromise(dialog, "saveQuietMode", true);

    expect(configSpy).not.toHaveBeenCalled();
    expect(saveSpy.mock.calls).toEqual([[{ set: { quietMode: true } }]]);
    expect(getDialogProperty(dialog, "configResponse")).toBe(savedConfig);
    expect(onConfigSaved).toHaveBeenCalledWith(savedConfig.effectiveConfig);
    expect(getDialogProperty(dialog, "savedMessage")).toBe("Quiet mode is on. Chat events start collapsed into one expandable “events” line.");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("reports a failed quiet-mode save without claiming it was saved", async () => {
    stubWindowTimers();
    vi.spyOn(configApi, "config").mockResolvedValue(configResponse({ host: "127.0.0.1" }));
    vi.spyOn(configApi, "updateConfig").mockRejectedValue(new Error("Disk is read-only"));
    const dialog = new SettingsDialog();

    await callDialogPromise(dialog, "saveQuietMode", false);

    expect(getDialogProperty(dialog, "error")).toBe("Couldn't save quiet mode: Disk is read-only");
    expect(getDialogProperty(dialog, "savedMessage")).toBe("");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("combines explicit gateway changes and resets without touching hidden env-controlled overrides", async () => {
    stubWindowTimers();
    const current = { ...configResponse({ host: "hidden", port: 8504, quietMode: true }), enforcedSettings: { "/host": "PI_WEB_HOST" } };
    const save = vi.spyOn(configApi, "updateConfig").mockResolvedValue(configResponse({ host: "hidden", port: 9000 }));
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    setDialogProperty(dialog, "configResponse", current);
    await callDialogPromise(dialog, "saveConfig", { host: "effective-env", port: 9000 }, ["/quietMode", "/host"]);
    expect(save).toHaveBeenCalledExactlyOnceWith({ set: { port: 9000 }, unset: ["/quietMode"] });
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
    const patch = { installationName: "Lab", pathAccess: { allowedPaths: ["/mnt/share", "~/SDKs"] }, uploads: { defaultFolder: "manual/uploads" } };
    const savedConfig = configResponse(patch);
    const saveSpy = vi.spyOn(configApi, "updateConfig").mockResolvedValue(savedConfig);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    const onMachineConfigSaved = vi.fn();
    dialog.onMachineConfigSaved = onMachineConfigSaved;

    await callDialogPromise(dialog, "saveMachineAccessConfig", patch);
    expect(onMachineConfigSaved).toHaveBeenCalledExactlyOnceWith(remoteMachine.id);

    expect(saveSpy.mock.calls).toEqual([[{ set: patch, unset: [] }, "remote-a"]]);
    expect(getDialogProperty(dialog, "accessConfigResponse")).toBe(savedConfig);
    expect(getDialogProperty(dialog, "configResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "savedMessage")).toBe("Machine settings saved for Lab Mac.");
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
    const patch = { pathAccess: { allowedPaths: ["~/SDKs"] } };
    const savedConfig = configResponse({ pathAccess: { allowedPaths: ["~/SDKs"] }, uploads: {}, maxUploadBytes: 5678 });
    const saveSpy = vi.spyOn(configApi, "updateConfig").mockResolvedValue(savedConfig);
    const onConfigSaved = vi.fn();
    const dialog = new SettingsDialog();
    dialog.onConfigSaved = onConfigSaved;
    setDialogProperty(dialog, "configResponse", gatewayConfig);

    await callDialogPromise(dialog, "saveMachineAccessConfig", patch);

    expect(saveSpy.mock.calls).toEqual([[{ set: patch, unset: [] }, "local"]]);
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

  it("notifies the identity owner after a save even when the settings target has changed", async () => {
    const save = deferred<PiWebConfigResponse>();
    vi.spyOn(configApi, "updateConfig").mockReturnValue(save.promise);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    const onMachineConfigSaved = vi.fn();
    dialog.onMachineConfigSaved = onMachineConfigSaved;
    const savePromise = callDialogPromise(dialog, "saveMachineAccessConfig", { installationName: "Studio", pathAccess: { allowedPaths: ["/mnt/share"] }, uploads: { defaultFolder: "manual" } });
    expect(getDialogProperty(dialog, "saving")).toBe(true);

    dialog.machine = secondRemoteMachine;
    callDialogUpdated(dialog, new Map([["machine", remoteMachine]]));
    save.resolve(configResponse({ pathAccess: { allowedPaths: ["/mnt/share"] }, uploads: { defaultFolder: "manual" } }));
    await savePromise;

    expect(onMachineConfigSaved).toHaveBeenCalledExactlyOnceWith(remoteMachine.id);
    expect(getDialogProperty(dialog, "accessConfigResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "savedMessage")).toBe("");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("keeps a local name save in the gateway snapshot after changing targets and rejects older gateway loads", async () => {
    const load = deferred<PiWebConfigResponse>();
    const save = deferred<PiWebConfigResponse>();
    vi.spyOn(configApi, "config").mockReturnValue(load.promise);
    vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([]));
    vi.spyOn(configApi, "updateConfig").mockReturnValue(save.promise);
    const dialog = new SettingsDialog();
    const onConfigSaved = vi.fn();
    dialog.onConfigSaved = onConfigSaved;
    setDialogProperty(dialog, "configResponse", configResponse({ installationName: "Old", host: "gateway.local" }));
    const loading = callDialogPromise(dialog, "loadConfig");
    const saving = callDialogPromise(dialog, "saveMachineAccessConfig", { installationName: "Studio" });
    dialog.machine = remoteMachine;
    save.resolve(configResponse({ installationName: "Studio" }));
    await saving;
    load.resolve(configResponse({ installationName: "Old" }));
    await loading;
    expect(getDialogProperty(dialog, "configResponse")).toMatchObject({ config: { installationName: "Studio", host: "gateway.local" } });
    expect(onConfigSaved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ installationName: "Studio" }));
    expect(getDialogProperty(dialog, "accessConfigResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "savedMessage")).toBe("");
  });

  it("does not let an outstanding settings load restore a name replaced by a save", async () => {
    stubWindowTimers();
    const load = deferred<PiWebConfigResponse>();
    vi.spyOn(configApi, "config").mockReturnValue(load.promise);
    const saved = configResponse({ installationName: "Studio" });
    vi.spyOn(configApi, "updateConfig").mockResolvedValue(saved);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    const loading = callDialogPromise(dialog, "loadAccessConfigForTarget");
    await callDialogPromise(dialog, "saveMachineAccessConfig", { installationName: "Studio" });
    load.resolve(configResponse({ installationName: "Old" }));
    await loading;
    expect(getDialogProperty(dialog, "accessConfigResponse")).toBe(saved);
    expect(getDialogProperty(dialog, "accessLoading")).toBe(false);
  });

  it("shows selected-machine file access errors with the selected target name", async () => {
    vi.spyOn(configApi, "config").mockRejectedValue(new Error("Remote machine unavailable"));
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "loadAccessConfigForTarget");

    expect(getDialogProperty(dialog, "accessError")).toBe("Failed to load file access/upload config from Lab Mac (remote machine): Remote machine unavailable");
    expect(getDialogProperty(dialog, "accessLoading")).toBe(false);
  });
});
