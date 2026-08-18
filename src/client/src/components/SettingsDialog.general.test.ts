import { afterEach, describe, expect, it, vi } from "vitest";
import { configApi, type PiWebConfigResponse } from "../api";
import { activeSettingsPanelTag, SettingsDialog } from "./SettingsDialog";
import { callDialogPromise, callDialogUpdated, configResponse, deferred, getDialogProperty, remoteMachine, secondRemoteMachine, setDialogProperty, stubWindowTimers } from "./SettingsDialog.testSupport";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("settings-dialog general settings machine targeting", () => {
  it("routes each section to a single settings panel with no per-tab scope-note wrapper", () => {
    // The old global "scope-note"/"This tab edits:" wrapper is gone: each section
    // now maps to exactly one panel element. Assert that public routing contract
    // (`activeSettingsPanelTag`) instead of scraping the rendered template markup.
    expect(activeSettingsPanelTag("general")).toBe("settings-general-panel");
    expect(activeSettingsPanelTag("sessiond")).toBe("settings-sessiond-panel");
    expect(activeSettingsPanelTag("packages")).toBe("settings-packages-panel");
    expect(activeSettingsPanelTag("plugins")).toBe("settings-plugins-panel");
    expect(activeSettingsPanelTag("shortcuts")).toBe("settings-shortcuts-panel");
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
