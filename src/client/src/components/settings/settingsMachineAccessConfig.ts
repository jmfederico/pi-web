import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";

export function mergeSelectedMachineAccessConfig(base: PiWebConfigResponse, selectedMachine: PiWebConfigResponse): PiWebConfigResponse {
  return {
    ...base,
    config: mergeAccessConfig(base.config, selectedMachine.config),
    effectiveConfig: mergeAccessConfig(base.effectiveConfig, selectedMachine.effectiveConfig),
  };
}

function mergeAccessConfig(base: PiWebConfigValues, selectedMachine: PiWebConfigValues): PiWebConfigValues {
  return {
    ...base,
    ...(selectedMachine.pathAccess === undefined ? {} : { pathAccess: selectedMachine.pathAccess }),
    ...(selectedMachine.uploads === undefined ? {} : { uploads: selectedMachine.uploads }),
    ...(selectedMachine.maxUploadBytes === undefined ? {} : { maxUploadBytes: selectedMachine.maxUploadBytes }),
  };
}
