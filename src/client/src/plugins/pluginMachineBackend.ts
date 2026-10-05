import type { PluginBackend } from "../../../shared/pluginApiTypes";
import { requestMachinePluginBackend } from "../api/pluginBackends";

/** Package identity and machine are captured, never read from later selection. */
export function createPluginMachineBackend(
  pluginId: string,
  machineId: string,
  lifetime: AbortSignal,
): PluginBackend {
  return Object.freeze<PluginBackend>({
    version: 1,
    request: async (operation, input, options = {}) => {
      lifetime.throwIfAborted();
      const signal = options.signal === undefined ? lifetime : AbortSignal.any([lifetime, options.signal]);
      return await requestMachinePluginBackend({ pluginId, machineId }, operation, input, { signal });
    },
  });
}
