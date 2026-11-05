import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";
import { mergeSelectedSettingsResponse } from "./settingsConfigUpdate";

export function spawnSessionsConfigPatch(enabled: boolean): PiWebConfigValues {
  return { spawnSessions: enabled };
}

export function subsessionsConfigPatch(enabled: boolean): PiWebConfigValues {
  return { subsessions: enabled };
}

export function sessionMessagesConfigPatch(enabled: boolean): PiWebConfigValues {
  return { sessionMessages: enabled };
}

export function askUserConfigPatch(enabled: boolean): PiWebConfigValues {
  return { askUser: enabled };
}

export function mergeSelectedMachineSessiondConfig(base: PiWebConfigResponse, selectedMachine: PiWebConfigResponse): PiWebConfigResponse {
  return mergeSelectedSettingsResponse(base, selectedMachine, ["spawnSessions", "subsessions", "sessionMessages", "askUser", "agent"]);
}
