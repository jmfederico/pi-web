import { describe, expect, it } from "vitest";
import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";
import { mergeSelectedMachineAccessConfig } from "./settingsMachineAccessConfig";

describe("selected-machine access config helpers", () => {
  it("replaces base roots and their defaults, source and enforcement metadata", () => {
    const gateway: PiWebConfigResponse = {
      ...configResponse({ host: "gateway.local", basePaths: ["/old"] }),
      defaultsConfig: { host: "default.local", basePaths: ["/old-default"] },
      enforcedSettings: { "/host": "PI_WEB_HOST", "/basePaths": "OLD_BASE_PATHS" },
      configSources: { "/host": "environment", "/basePaths": "old source" },
    };
    const selected: PiWebConfigResponse = {
      ...configResponse({ basePaths: ["/new"] }),
      effectiveConfig: { basePaths: ["/enforced"] },
      defaultsConfig: { basePaths: ["/new-default"] },
      enforcedSettings: { "/basePaths": "NEW_BASE_PATHS" },
      configSources: { "/basePaths": "new source" },
    };
    const merged = mergeSelectedMachineAccessConfig(gateway, selected);
    expect(merged.config.basePaths).toEqual(["/new"]);
    expect(merged.effectiveConfig.basePaths).toEqual(["/enforced"]);
    expect(merged.defaultsConfig).toEqual({ host: "default.local", basePaths: ["/new-default"] });
    expect(merged.enforcedSettings).toEqual({ "/host": "PI_WEB_HOST", "/basePaths": "NEW_BASE_PATHS" });
    expect(merged.configSources).toEqual({ "/host": "environment", "/basePaths": "new source" });

    const reset = mergeSelectedMachineAccessConfig(merged, configResponse({}));
    expect(reset.config).toEqual({ host: "gateway.local" });
    expect(reset.effectiveConfig).toEqual({ host: "gateway.local" });
    expect(reset.defaultsConfig).toEqual({ host: "default.local" });
    expect(reset.enforcedSettings).toEqual({ "/host": "PI_WEB_HOST" });
    expect(reset.configSources).toEqual({ "/host": "environment" });
  });

  it("preserves explicitly empty base roots instead of restoring old roots", () => {
    const merged = mergeSelectedMachineAccessConfig(configResponse({ basePaths: ["/old"] }), configResponse({ basePaths: [] }));
    expect(merged.config.basePaths).toEqual([]);
    expect(merged.effectiveConfig.basePaths).toEqual([]);
  });

  it("replaces and clears the installation name so later gateway saves cannot restore it", () => {
    const gateway = configResponse({ host: "gateway.local", installationName: "Old name" });
    const renamed = mergeSelectedMachineAccessConfig(gateway, configResponse({ installationName: "New name" }));
    expect(renamed.config.installationName).toBe("New name");
    const cleared = mergeSelectedMachineAccessConfig(renamed, configResponse({}));
    expect(cleared.config).not.toHaveProperty("installationName");
    expect(cleared.effectiveConfig).not.toHaveProperty("installationName");
    expect(cleared.config.host).toBe("gateway.local");
  });

  it("merges local selected-machine file/upload config into gateway config without dropping gateway-only values", () => {
    const gateway = configResponse({
      host: "127.0.0.1",
      port: 8504,
      allowedHosts: ["gateway.local"],
      shortcuts: { "core:view.chat": "mod+1" },
      plugins: { info: { enabled: true } },
      spawnSessions: false,
      pathAccess: { allowedPaths: ["/old"] },
      uploads: { defaultFolder: "old/uploads" },
      attachments: { defaultFolder: "old/attachments" },
      maxUploadBytes: 1234,
    });
    const selectedMachine = configResponse({
      pathAccess: { allowedPaths: ["~/SDKs"] },
      uploads: { defaultFolder: "manual/uploads" },
      attachments: { defaultFolder: "manual/attachments" },
      maxUploadBytes: 5678,
    });

    expect(mergeSelectedMachineAccessConfig(gateway, selectedMachine)).toEqual({
      ...gateway,
      config: {
        host: "127.0.0.1",
        port: 8504,
        allowedHosts: ["gateway.local"],
        shortcuts: { "core:view.chat": "mod+1" },
        plugins: { info: { enabled: true } },
        spawnSessions: false,
        pathAccess: { allowedPaths: ["~/SDKs"] },
        uploads: { defaultFolder: "manual/uploads" },
        attachments: { defaultFolder: "manual/attachments" },
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
        uploads: { defaultFolder: "manual/uploads" },
        attachments: { defaultFolder: "manual/attachments" },
        maxUploadBytes: 5678,
      },
    });
  });

  it("merges cleared selected-machine access/upload defaults without clearing gateway-only values", () => {
    const gateway = configResponse({
      host: "127.0.0.1",
      shortcuts: { "core:view.chat": "mod+1" },
      pathAccess: { allowedPaths: ["/old"] },
      uploads: { defaultFolder: "old/uploads" },
      attachments: { defaultFolder: "old/attachments" },
    });
    const selectedMachine = configResponse({ pathAccess: { allowedPaths: [] }, uploads: {}, attachments: {} });

    expect(mergeSelectedMachineAccessConfig(gateway, selectedMachine)).toEqual({
      ...gateway,
      config: {
        host: "127.0.0.1",
        shortcuts: { "core:view.chat": "mod+1" },
        pathAccess: { allowedPaths: [] },
        uploads: {},
        attachments: {},
      },
      effectiveConfig: {
        host: "127.0.0.1",
        shortcuts: { "core:view.chat": "mod+1" },
        pathAccess: { allowedPaths: [] },
        uploads: {},
        attachments: {},
      },
    });
  });
});

function configResponse(config: PiWebConfigValues): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, sessionMessages: false, askUser: false },
  };
}
