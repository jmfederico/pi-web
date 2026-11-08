import type { PiWebConfigValues } from "../../api";
import { hostnameAllowedByPolicy } from "../../../../shared/hostAccess";
import type { SettingsConfigUpdate } from "./settingsConfigUpdate";

/** Inspect the filtered write, not the draft: locked settings are not changes. */
export function hostAccessChangeBlocksHostname(update: SettingsConfigUpdate, defaults: PiWebConfigValues | undefined, hostname: string): boolean {
  const resetting = update.unset?.includes("/hostAccess") === true;
  if (update.set?.hostAccess === undefined && !resetting) return false;
  const policy = resetting ? defaults?.hostAccess : update.set?.hostAccess;
  return !hostnameAllowedByPolicy(hostname, policy);
}
