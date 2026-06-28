import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";

export function spawnSessionsConfigPatch(enabled: boolean): PiWebConfigValues {
  return { spawnSessions: enabled };
}

export function subsessionsConfigPatch(enabled: boolean): PiWebConfigValues {
  return { subsessions: enabled };
}

export function mergeSelectedMachineSessiondConfig(base: PiWebConfigResponse, selectedMachine: PiWebConfigResponse): PiWebConfigResponse {
  return {
    ...base,
    config: { ...base.config, ...selectedMachine.config },
    effectiveConfig: { ...base.effectiveConfig, ...selectedMachine.effectiveConfig },
    envOverrides: {
      ...base.envOverrides,
      spawnSessions: selectedMachine.envOverrides.spawnSessions,
      subsessions: selectedMachine.envOverrides.subsessions,
      agentCommand: selectedMachine.envOverrides.agentCommand,
      agentDir: selectedMachine.envOverrides.agentDir,
      agentSessionDir: selectedMachine.envOverrides.agentSessionDir,
    },
  };
}
