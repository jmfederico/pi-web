import type { SafeTunnelBridgeService } from "./safeTunnelBridgeService.js";
import type {
  SafeTunnelProductionOptions,
} from "./safeTunnelProduction.js";

export interface SafeTunnelProductionModule {
  createSafeTunnelProduction(
    options: SafeTunnelProductionOptions,
  ): SafeTunnelBridgeService;
}

export type SafeTunnelProductionModuleLoader = () => Promise<SafeTunnelProductionModule>;

const importSafeTunnelProduction: SafeTunnelProductionModuleLoader = () => (
  import("./safeTunnelProduction.js")
);

/**
 * Keeps the production Safe Tunnel graph outside the default web startup path.
 * In particular, an unavailable process never imports manifest validation or
 * constructs filesystem, network, timer, or child-process collaborators.
 */
export async function loadSafeTunnelBridge(
  available: boolean,
  options: SafeTunnelProductionOptions,
  loadModule: SafeTunnelProductionModuleLoader = importSafeTunnelProduction,
): Promise<SafeTunnelBridgeService | undefined> {
  if (!available) return undefined;
  const production = await loadModule();
  return production.createSafeTunnelProduction(options);
}
