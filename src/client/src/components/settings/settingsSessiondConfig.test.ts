import { describe, expect, it } from "vitest";
import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";
import { mergeSelectedMachineSessiondConfig } from "./settingsSessiondConfig";

describe("session daemon settings config helpers", () => {
  it("merges local selected-machine daemon config into gateway config without dropping gateway-only values", () => {
    const gateway = configResponse({
      host: "127.0.0.1",
      port: 8504,
      allowedHosts: ["gateway.local"],
      shortcuts: { "core:view.chat": "mod+1" },
      plugins: { info: { enabled: true } },
      spawnSessions: false,
      subsessions: false,
      agent: { command: "gateway-agent", dir: "/srv/gateway-agent" },
    });
    const selectedMachine = configResponse(
      { spawnSessions: true, subsessions: true, agent: { command: "machine-agent", dir: "/srv/machine-agent" } },
      { spawnSessions: true, subsessions: false },
      { spawnSessions: true, subsessions: true, agent: { command: "env-agent", dir: "/srv/machine-agent" } },
    );

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
        agent: { command: "machine-agent", dir: "/srv/machine-agent" },
      },
      effectiveConfig: {
        host: "127.0.0.1",
        port: 8504,
        allowedHosts: ["gateway.local"],
        shortcuts: { "core:view.chat": "mod+1" },
        plugins: { info: { enabled: true } },
        spawnSessions: true,
        subsessions: true,
        agent: { command: "env-agent", dir: "/srv/machine-agent" },
      },
      envOverrides: {
        host: false,
        port: false,
        allowedHosts: false,
        spawnSessions: true,
        subsessions: false,
        sessionMessages: false,
        askUser: false,
      },
    });
  });

  it("replaces selected-machine messaging values and metadata without leaking gateway overrides", () => {
    const gateway = configResponse({ host: "gateway", sessionMessages: false });
    gateway.defaultsConfig = { sessionMessages: false };
    gateway.configSources = { "/host": "config", "/sessionMessages": "environment" };
    gateway.enforcedSettings = { "/sessionMessages": "PI_WEB_SESSION_MESSAGES" };
    const selected = configResponse({ sessionMessages: true }, { sessionMessages: true }, { sessionMessages: false });
    selected.defaultsConfig = { sessionMessages: true };
    selected.configSources = { "/sessionMessages": "environment" };
    selected.enforcedSettings = { "/sessionMessages": "PI_WEB_SESSION_MESSAGES" };
    const merged = mergeSelectedMachineSessiondConfig(gateway, selected);
    expect(merged.config).toEqual({ host: "gateway", sessionMessages: true });
    expect(merged.effectiveConfig.sessionMessages).toBe(false);
    expect(merged.defaultsConfig?.sessionMessages).toBe(true);
    expect(merged.envOverrides.sessionMessages).toBe(true);
    expect(merged.enforcedSettings).toEqual(selected.enforcedSettings);
    expect(merged.configSources).toEqual({ "/host": "config", "/sessionMessages": "environment" });

    const cleared = mergeSelectedMachineSessiondConfig(gateway, configResponse({}));
    expect(cleared.config).not.toHaveProperty("sessionMessages");
    expect(cleared.effectiveConfig).not.toHaveProperty("sessionMessages");
    expect(cleared.defaultsConfig).not.toHaveProperty("sessionMessages");
    expect(cleared.enforcedSettings).not.toHaveProperty("/sessionMessages");
    expect(cleared.configSources).not.toHaveProperty("/sessionMessages");
    expect(cleared.envOverrides.sessionMessages).toBe(false);
  });
});

function configResponse(
  config: PiWebConfigValues,
  overrides: Partial<PiWebConfigResponse["envOverrides"]> = {},
  effectiveConfig: PiWebConfigValues = config,
): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists: true,
    config,
    effectiveConfig,
    envOverrides: {
      host: false,
      port: false,
      allowedHosts: false,
      spawnSessions: false,
      subsessions: false,
      sessionMessages: false,
      askUser: false,
      ...overrides,
    },
  };
}
