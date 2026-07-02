import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";

export function pluginEnabledConfigPatch(baseConfig: PiWebConfigValues, pluginId: string, enabled: boolean): PiWebConfigValues {
  const currentPlugins = baseConfig.plugins ?? {};
  const currentPluginConfig = currentPlugins[pluginId] ?? {};
  return {
    plugins: {
      ...currentPlugins,
      [pluginId]: { ...currentPluginConfig, enabled },
    },
  };
}

export function mergeSelectedMachinePluginConfig(base: PiWebConfigResponse, selectedMachine: PiWebConfigResponse): PiWebConfigResponse {
  return {
    ...base,
    config: mergePluginConfig(base.config, selectedMachine.config),
    effectiveConfig: mergePluginConfig(base.effectiveConfig, selectedMachine.effectiveConfig),
  };
}

function mergePluginConfig(base: PiWebConfigValues, selectedMachine: PiWebConfigValues): PiWebConfigValues {
  if (selectedMachine.plugins === undefined) return base;
  return { ...base, plugins: selectedMachine.plugins };
}
