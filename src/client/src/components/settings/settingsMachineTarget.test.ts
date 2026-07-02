import { describe, expect, it } from "vitest";
import type { Machine, MachineRuntime } from "../../api";
import { PI_WEB_CAPABILITIES } from "../../../../shared/capabilities";
import { friendlySelectedMachineSettingsErrorMessage, isSelectedMachineSettingsUnsupported, selectedMachineSettingsSupport, selectedMachineSettingsSupportKey, selectedMachineSettingsUnavailableMessage, settingsMachineTarget, settingsMachineTargetLabel } from "./settingsMachineTarget";

const remoteMachine: Machine = {
  id: "remote-a",
  name: "Lab Mac",
  kind: "remote",
  baseUrl: "https://lab.example.test",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

describe("selected-machine settings target helpers", () => {
  it("uses the selected machine when present and falls back to the local gateway", () => {
    expect(settingsMachineTarget(undefined)).toEqual({ id: "local", name: "local", kind: "local" });
    expect(settingsMachineTarget(remoteMachine)).toEqual({ id: "remote-a", name: "Lab Mac", kind: "remote" });
  });

  it("labels local and remote settings targets factually", () => {
    expect(settingsMachineTargetLabel({ id: "local", name: "local", kind: "local" })).toBe("local (local gateway)");
    expect(settingsMachineTargetLabel(settingsMachineTarget(remoteMachine))).toBe("Lab Mac (remote machine)");
  });

  it("gates remote selected-machine settings on advertised runtime support", () => {
    const target = settingsMachineTarget(remoteMachine);
    const supportedRuntime: MachineRuntime = { machineId: "remote-a", ok: true, checkedAt: "now", capabilities: [PI_WEB_CAPABILITIES.selectedMachineSettings] };
    const unsupportedRuntime: MachineRuntime = { machineId: "remote-a", ok: true, checkedAt: "now", capabilities: [PI_WEB_CAPABILITIES.piPackagesManage] };

    expect(selectedMachineSettingsSupport({ id: "local", name: "local", kind: "local" }, undefined)).toEqual({ state: "supported" });
    expect(selectedMachineSettingsSupport(target, undefined)).toEqual({ state: "unknown" });
    expect(selectedMachineSettingsSupport(target, { ok: false })).toEqual({ state: "unknown" });
    expect(selectedMachineSettingsSupport(target, supportedRuntime)).toEqual({ state: "supported" });

    const unsupported = selectedMachineSettingsSupport(target, unsupportedRuntime);
    expect(isSelectedMachineSettingsUnsupported(unsupported)).toBe(true);
    expect(unsupported.message).toBe(selectedMachineSettingsUnavailableMessage(target));
    expect(selectedMachineSettingsSupportKey(unsupported)).toBe(`unsupported:${selectedMachineSettingsUnavailableMessage(target)}`);
  });

  it("turns older remote config route failures into selected-machine compatibility guidance", () => {
    const target = settingsMachineTarget(remoteMachine);

    expect(selectedMachineSettingsUnavailableMessage(target)).toBe("Selected-machine settings are not available on Lab Mac. Update and restart PI WEB on that machine, then try again.");
    expect(friendlySelectedMachineSettingsErrorMessage("Not Found", target)).toBe(selectedMachineSettingsUnavailableMessage(target));
    expect(friendlySelectedMachineSettingsErrorMessage("route GET:/api/config not found", target)).toBe(selectedMachineSettingsUnavailableMessage(target));
    expect(friendlySelectedMachineSettingsErrorMessage("Cannot PUT /api/config", target)).toBe(selectedMachineSettingsUnavailableMessage(target));
    expect(friendlySelectedMachineSettingsErrorMessage("route GET:/api/plugins not found", target)).toBe(selectedMachineSettingsUnavailableMessage(target));
    expect(friendlySelectedMachineSettingsErrorMessage("Cannot GET /api/plugins", target)).toBe(selectedMachineSettingsUnavailableMessage(target));
  });

  it("scopes remote reachability errors to selected-machine settings", () => {
    const target = settingsMachineTarget(remoteMachine);

    expect(friendlySelectedMachineSettingsErrorMessage("Remote machine unavailable", target)).toBe("Could not reach Lab Mac for selected-machine settings. Check the machine connection and try again.");
    expect(friendlySelectedMachineSettingsErrorMessage("Remote machine timeout", target)).toBe("Timed out while contacting Lab Mac for selected-machine settings. The operation may still be running remotely; reload before retrying.");
    expect(friendlySelectedMachineSettingsErrorMessage("Not Found", { id: "local", name: "local", kind: "local" })).toBe("Not Found");
  });
});
