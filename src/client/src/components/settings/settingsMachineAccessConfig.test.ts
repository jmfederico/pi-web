import { describe, expect, it } from "vitest";
import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";
import { mergeSelectedMachineAccessConfig } from "./settingsMachineAccessConfig";

describe("selected-machine access config helpers", () => {
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
      maxUploadBytes: 1234,
    });
    const selectedMachine = configResponse({
      pathAccess: { allowedPaths: ["~/SDKs"] },
      uploads: { defaultFolder: "manual/uploads" },
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
    });
    const selectedMachine = configResponse({ pathAccess: { allowedPaths: [] }, uploads: {} });

    expect(mergeSelectedMachineAccessConfig(gateway, selectedMachine)).toEqual({
      ...gateway,
      config: {
        host: "127.0.0.1",
        shortcuts: { "core:view.chat": "mod+1" },
        pathAccess: { allowedPaths: [] },
        uploads: {},
      },
      effectiveConfig: {
        host: "127.0.0.1",
        shortcuts: { "core:view.chat": "mod+1" },
        pathAccess: { allowedPaths: [] },
        uploads: {},
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
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false },
  };
}
