import { describe, expect, it } from "vitest";
import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";
import { mergeSelectedMachineSessiondConfig, spawnSessionsConfigPatch, subsessionsConfigPatch } from "./settingsSessiondConfig";

describe("session daemon settings config helpers", () => {
  it("builds daemon-only save patches for the sessiond toggles", () => {
    expect(spawnSessionsConfigPatch(false)).toEqual({ spawnSessions: false });
    expect(Object.keys(spawnSessionsConfigPatch(false))).toEqual(["spawnSessions"]);
    expect(subsessionsConfigPatch(true)).toEqual({ subsessions: true });
    expect(Object.keys(subsessionsConfigPatch(true))).toEqual(["subsessions"]);
  });

  it("merges local selected-machine daemon config into gateway config without dropping gateway-only values", () => {
    const gateway = configResponse({
      host: "127.0.0.1",
      port: 8504,
      allowedHosts: ["gateway.local"],
      shortcuts: { "core:view.chat": "mod+1" },
      plugins: { info: { enabled: true } },
      spawnSessions: false,
      subsessions: false,
    });
    const selectedMachine = configResponse({ spawnSessions: true, subsessions: true }, { spawnSessions: true, subsessions: false });

    expect(mergeSelectedMachineSessiondConfig(gateway, selectedMachine)).toEqual({
      ...gateway,
      config: {
        host: "127.0.0.1",
        port: 8504,
        allowedHosts: ["gateway.local"],
        shortcuts: { "core:view.chat": "mod+1" },
        plugins: { info: { enabled: true } },
        spawnSessions: true,
        subsessions: true,
      },
      effectiveConfig: {
        host: "127.0.0.1",
        port: 8504,
        allowedHosts: ["gateway.local"],
        shortcuts: { "core:view.chat": "mod+1" },
        plugins: { info: { enabled: true } },
        spawnSessions: true,
        subsessions: true,
      },
      envOverrides: {
        host: false,
        port: false,
        allowedHosts: false,
        spawnSessions: true,
        subsessions: false,
      },
    });
  });
});

function configResponse(config: PiWebConfigValues, overrides: Partial<PiWebConfigResponse["envOverrides"]> = {}): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, ...overrides },
  };
}
