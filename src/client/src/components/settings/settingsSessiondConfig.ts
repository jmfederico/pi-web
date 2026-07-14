import { usesPiCodingAgentStateCompatibility } from "../../../../shared/activeAgentProfile";
import type { ActiveAgentProfileDescriptor, PiWebConfigEnvOverrides, PiWebConfigResponse, PiWebConfigValues } from "../../api";

export type AgentProfileActivationState = "active" | "restart-required" | "unavailable";

export function spawnSessionsConfigPatch(enabled: boolean): PiWebConfigValues {
  return { spawnSessions: enabled };
}

export function subsessionsConfigPatch(enabled: boolean): PiWebConfigValues {
  return { subsessions: enabled };
}

export function agentProfileActivationState(
  config: PiWebConfigResponse | undefined,
  activeProfile: ActiveAgentProfileDescriptor | undefined,
): AgentProfileActivationState {
  const desiredProfile = config?.effectiveConfig.agent;
  if (desiredProfile?.command === undefined || desiredProfile.dir === undefined || activeProfile === undefined) return "unavailable";
  const desiredSessionDirEnvKeys = [
    "PI_WEB_AGENT_SESSION_DIR",
    ...(usesPiCodingAgentStateCompatibility(desiredProfile.command) ? ["PI_CODING_AGENT_SESSION_DIR"] : []),
  ];
  return desiredProfile.command === activeProfile.command
    && desiredProfile.dir === activeProfile.dir
    && sameStrings(activeProfile.sessionDirEnvKeys, desiredSessionDirEnvKeys)
    ? "active"
    : "restart-required";
}

export function agentDirFieldOverridden(envOverrides: PiWebConfigEnvOverrides | undefined, draftCommand: string): boolean {
  if (envOverrides?.agentDirSource === "pi-web") return true;
  if (envOverrides?.agentDirSource === "pi-compatibility") return usesPiCodingAgentStateCompatibility(draftCommand.trim() || "pi");
  // Older remote responses do not identify the source. Keep their override
  // read-only rather than incorrectly treating a PI_WEB_AGENT_DIR as conditional.
  return envOverrides?.agentDir === true;
}

export function mergeSelectedMachineSessiondConfig(base: PiWebConfigResponse, selectedMachine: PiWebConfigResponse): PiWebConfigResponse {
  const envOverrides: PiWebConfigEnvOverrides = {
    ...base.envOverrides,
    spawnSessions: selectedMachine.envOverrides.spawnSessions,
    subsessions: selectedMachine.envOverrides.subsessions,
    agentCommand: selectedMachine.envOverrides.agentCommand,
    agentDir: selectedMachine.envOverrides.agentDir,
    agentSessionDir: selectedMachine.envOverrides.agentSessionDir,
  };
  if (selectedMachine.envOverrides.agentDirSource === undefined) delete envOverrides.agentDirSource;
  else envOverrides.agentDirSource = selectedMachine.envOverrides.agentDirSource;

  return {
    ...base,
    config: { ...base.config, ...selectedMachine.config },
    effectiveConfig: { ...base.effectiveConfig, ...selectedMachine.effectiveConfig },
    envOverrides,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
