import type { PiWebPluginRecoveryCommands } from "./apiTypes.js";
import { isPiWebPluginId } from "./pluginIds.js";

/** Secret-free commands accepted by the offline recovery CLI. */
export const PI_WEB_PLUGIN_RECOVERY_COMMANDS: Readonly<PiWebPluginRecoveryCommands> = Object.freeze({
  showSafeStart: "pi-web plugins safe-start show",
  bundledOnly: "pi-web plugins safe-start set bundled-only --restart",
  noServerPlugins: "pi-web plugins safe-start set none --restart",
  clearSafeStart: "pi-web plugins safe-start clear --restart",
});

export function pluginDisableRecoveryCommand(pluginId: string): string {
  if (!isPiWebPluginId(pluginId)) throw new Error(`Invalid PI WEB plugin id: ${pluginId}`);
  return `pi-web plugins disable ${pluginId} --restart`;
}
