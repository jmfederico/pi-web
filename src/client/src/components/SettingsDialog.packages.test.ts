import { afterEach, describe, expect, it, vi } from "vitest";
import { piPackagesApi, pluginsApi, type PiPackageMutationResponse } from "../api";
import { SettingsDialog } from "./SettingsDialog";
import { callDialogPromise, callDialogUpdated, deferred, getDialogProperty, packageInfo, packageMutationResponse, pluginInfo, pluginsResponse, remoteMachine, runtimeWithPackageManagement, secondRemoteMachine } from "./SettingsDialog.testSupport";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("settings-dialog Pi package orchestration", () => {
  it("loads package data from the selected machine and ignores stale target responses", async () => {
    const remotePackages = { packages: [packageInfo("npm:@acme/tools")] };
    const staleLoad = deferred<typeof remotePackages>();
    const packagesSpy = vi.spyOn(piPackagesApi, "packages").mockReturnValue(staleLoad.promise);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    dialog.machineRuntime = runtimeWithPackageManagement;

    const loadPromise = callDialogPromise(dialog, "loadPackagesForTarget");
    expect(packagesSpy.mock.calls).toEqual([["remote-a"]]);
    expect(getDialogProperty(dialog, "packageLoading")).toBe(true);

    dialog.machine = secondRemoteMachine;
    callDialogUpdated(dialog, new Map([["machine", remoteMachine]]));
    staleLoad.resolve(remotePackages);
    await loadPromise;

    expect(getDialogProperty(dialog, "packagesResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "packageError")).toBe("");
    expect(getDialogProperty(dialog, "packageMessage")).toBe("");
    expect(getDialogProperty(dialog, "packageLoading")).toBe(false);
  });

  it("runs remote package mutations against the selected machine without refreshing gateway plugins", async () => {
    const installedPackages = [packageInfo("npm:@acme/new-tools")];
    const install = deferred<PiPackageMutationResponse>();
    const installSpy = vi.spyOn(piPackagesApi, "install").mockReturnValue(install.promise);
    const pluginsSpy = vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([pluginInfo("gateway", true)]));
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    dialog.machineRuntime = runtimeWithPackageManagement;

    const installPromise = callDialogPromise(dialog, "installPiPackage", "npm:@acme/new-tools");

    expect(installSpy.mock.calls).toEqual([["npm:@acme/new-tools", "remote-a"]]);
    expect(getDialogProperty(dialog, "saving")).toBe(true);
    expect(getDialogProperty(dialog, "packageOperation")).toEqual({ kind: "install", source: "npm:@acme/new-tools" });

    install.resolve(packageMutationResponse("install", installedPackages, "npm:@acme/new-tools"));
    await installPromise;

    expect(pluginsSpy).not.toHaveBeenCalled();
    expect(getDialogProperty(dialog, "packagesResponse")).toEqual({ packages: installedPackages });
    expect(getDialogProperty(dialog, "packageMessage")).toContain("Pi package installed on Lab Mac");
    expect(getDialogProperty(dialog, "packageMessage")).toContain("each idle, message-bearing PI WEB session on Lab Mac");
    expect(getDialogProperty(dialog, "packageError")).toBe("");
    expect(getDialogProperty(dialog, "packageOperation")).toBeUndefined();
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("refreshes gateway plugins after a local package mutation", async () => {
    const updatedPackages = [packageInfo("npm:@acme/tools")];
    const refreshedPlugins = pluginsResponse([pluginInfo("browser-helper", true)]);
    const updateSpy = vi.spyOn(piPackagesApi, "update").mockResolvedValue(packageMutationResponse("update", updatedPackages));
    const pluginsSpy = vi.spyOn(pluginsApi, "plugins").mockResolvedValue(refreshedPlugins);
    const dialog = new SettingsDialog();

    await callDialogPromise(dialog, "updatePiPackage");

    expect(updateSpy.mock.calls).toEqual([[undefined, "local"]]);
    expect(pluginsSpy.mock.calls).toEqual([[]]);
    expect(getDialogProperty(dialog, "packagesResponse")).toEqual({ packages: updatedPackages });
    expect(getDialogProperty(dialog, "pluginsResponse")).toBe(refreshedPlugins);
    expect(getDialogProperty(dialog, "packageMessage")).toContain("Reload the browser page separately for PI WEB browser plugin changes");
    expect(getDialogProperty(dialog, "packageError")).toBe("");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });
});
