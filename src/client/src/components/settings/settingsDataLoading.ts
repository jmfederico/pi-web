import type { PiPackagesResponse, PiWebConfigResponse, PiWebPluginsResponse } from "../../api";
import { friendlyPiPackageErrorMessage, piPackageTargetLabel, type PiPackageTargetContext } from "./piPackageSettings";

export interface GatewaySettingsLoaders {
  loadConfig: () => Promise<PiWebConfigResponse>;
  loadPlugins: () => Promise<PiWebPluginsResponse>;
}

export interface GatewaySettingsLoadResult {
  config?: PiWebConfigResponse;
  plugins?: PiWebPluginsResponse;
  error: string;
}

export interface PiPackagesLoadResult {
  packagesResponse?: PiPackagesResponse;
  error: string;
}

export async function loadGatewaySettingsData(loaders: GatewaySettingsLoaders): Promise<GatewaySettingsLoadResult> {
  const [config, plugins] = await Promise.allSettled([loaders.loadConfig(), loaders.loadPlugins()]);
  const result: GatewaySettingsLoadResult = { error: "" };
  const errors: string[] = [];

  if (config.status === "fulfilled") result.config = config.value;
  else errors.push(`config: ${errorMessage(config.reason)}`);

  if (plugins.status === "fulfilled") result.plugins = plugins.value;
  else errors.push(`PI WEB plugins: ${errorMessage(plugins.reason)}`);

  if (errors.length > 0) result.error = `Failed to load settings: ${errors.join("; ")}`;
  return result;
}

export async function loadPiPackagesData(target: PiPackageTargetContext, loadPackages: (targetId: string) => Promise<PiPackagesResponse>): Promise<PiPackagesLoadResult> {
  try {
    return { packagesResponse: await loadPackages(target.id), error: "" };
  } catch (error) {
    return { error: `Failed to load Pi packages from ${piPackageTargetLabel(target)}: ${friendlyPiPackageErrorMessage(errorMessage(error), target)}` };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
