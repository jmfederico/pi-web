import { describe, expect, it, vi } from "vitest";
import type { PiPackagesResponse, PiWebConfigResponse, PiWebPluginsResponse } from "../../api";
import { loadGatewaySettingsData, loadPiPackagesData } from "./settingsDataLoading";
import type { PiPackageManagementSupport } from "./piPackageSettings";

const configResponse: PiWebConfigResponse = {
  path: "/home/test/.config/pi-web/config.json",
  exists: true,
  config: { host: "127.0.0.1" },
  effectiveConfig: { host: "127.0.0.1" },
  envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false },
};

const pluginsResponse: PiWebPluginsResponse = { plugins: [] };
const packagesResponse: PiPackagesResponse = { packages: [{ source: "npm:@acme/tools", scope: "user", filtered: false }] };

const remoteTarget = { id: "remote-a", name: "Lab Mac", kind: "remote" } as const;
const unsupportedPackageManagement: PiPackageManagementSupport = {
  state: "unsupported",
  message: "Pi package management is not available on Lab Mac. Update and restart Pi-Web on that machine, then try again.",
};

describe("settings data loading helpers", () => {
  it("loads gateway settings without depending on Pi package data", async () => {
    const result = await loadGatewaySettingsData({
      loadConfig: () => Promise.resolve(configResponse),
      loadPlugins: () => Promise.resolve(pluginsResponse),
    });

    expect(result).toEqual({ config: configResponse, plugins: pluginsResponse, error: "" });
  });

  it("keeps gateway settings errors scoped to gateway config and plugins", async () => {
    const result = await loadGatewaySettingsData({
      loadConfig: () => Promise.resolve(configResponse),
      loadPlugins: () => Promise.reject(new Error("plugin scan failed")),
    });

    expect(result.config).toBe(configResponse);
    expect(result.plugins).toBeUndefined();
    expect(result.error).toBe("Failed to load settings: PI WEB plugins: plugin scan failed");
  });

  it("loads Pi packages for the selected target with package-scoped errors", async () => {
    const requestedTargets: string[] = [];
    const success = await loadPiPackagesData(remoteTarget, (targetId) => {
      requestedTargets.push(targetId);
      return Promise.resolve(packagesResponse);
    });
    const failure = await loadPiPackagesData(remoteTarget, (targetId) => {
      requestedTargets.push(targetId);
      return Promise.reject(new Error("Remote machine unavailable"));
    });

    expect(requestedTargets).toEqual(["remote-a", "remote-a"]);
    expect(success).toEqual({ packagesResponse, error: "" });
    expect(failure.packagesResponse).toBeUndefined();
    expect(failure.error).toBe("Failed to load Pi packages from Lab Mac (remote machine): Could not reach Lab Mac for Pi package management. Check the machine connection and try again.");
  });

  it("skips package listing only when runtime data confirms package management is unsupported", async () => {
    const requestedTargets: string[] = [];
    const loadPackages = vi.fn((targetId: string) => {
      requestedTargets.push(targetId);
      return Promise.resolve(packagesResponse);
    });

    const blocked = await loadPiPackagesData(remoteTarget, loadPackages, unsupportedPackageManagement);
    const unknown = await loadPiPackagesData(remoteTarget, loadPackages, { state: "unknown" });

    expect(blocked).toEqual({ error: unsupportedPackageManagement.message, skipped: true });
    expect(unknown).toEqual({ packagesResponse, error: "" });
    expect(requestedTargets).toEqual(["remote-a"]);
  });
});
