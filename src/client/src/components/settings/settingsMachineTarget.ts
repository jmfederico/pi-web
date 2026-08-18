import type { Machine, MachineKind, MachineRuntime } from "../../api";
import { PI_WEB_CAPABILITIES, supportsPiWebCapability } from "../../../../shared/capabilities";

export interface SettingsMachineTarget {
  id: string;
  name: string;
  kind: MachineKind;
}

export type SelectedMachineSettingsSupportState = "supported" | "unsupported" | "unknown";

export interface SelectedMachineSettingsSupport {
  state: SelectedMachineSettingsSupportState;
  message?: string;
}

export type PluginLifecycleSupport = SelectedMachineSettingsSupport;

export function settingsMachineTarget(machine: Pick<Machine, "id" | "name" | "kind"> | undefined): SettingsMachineTarget {
  if (machine !== undefined) return { id: machine.id, name: machine.name, kind: machine.kind };
  return { id: "local", name: "local", kind: "local" };
}

export function settingsMachineTargetLabel(target: SettingsMachineTarget): string {
  return target.kind === "local" ? `${target.name} (local gateway)` : `${target.name} (remote machine)`;
}

export function pluginLifecycleSupport(target: SettingsMachineTarget, runtime: Pick<MachineRuntime, "ok" | "capabilities"> | undefined): PluginLifecycleSupport {
  if (target.kind === "local") return { state: "supported" };
  if (runtime?.ok !== true) return { state: "unknown" };
  if (supportsPiWebCapability(runtime, PI_WEB_CAPABILITIES.pluginLifecycle)) return { state: "supported" };
  return { state: "unsupported", message: pluginLifecycleUnavailableMessage(target) };
}

export function selectedMachineSettingsSupportKey(support: SelectedMachineSettingsSupport): string {
  return `${support.state}:${support.message ?? ""}`;
}

export function isSelectedMachineSettingsUnsupported(support: SelectedMachineSettingsSupport | undefined): support is SelectedMachineSettingsSupport & { state: "unsupported" } {
  return support?.state === "unsupported";
}

export function pluginLifecycleUnavailableMessage(target: SettingsMachineTarget): string {
  return `Plugin lifecycle diagnostics are not available on ${target.name}. Update and restart PI WEB on that machine before loading server-backed plugins.`;
}

export function friendlySelectedMachineSettingsErrorMessage(message: string, target: SettingsMachineTarget): string {
  const normalized = message.trim();
  if (target.kind !== "remote") return normalized;
  if (normalized === "Remote machine timeout") {
    return `Timed out while contacting ${target.name} for selected-machine settings. The operation may still be running remotely; reload before retrying.`;
  }
  if (normalized === "Remote machine unavailable") {
    return `Could not reach ${target.name} for selected-machine settings. Check the machine connection and try again.`;
  }
  return normalized;
}
