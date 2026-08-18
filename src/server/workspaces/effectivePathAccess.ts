import type { PiWebPathAccessConfig } from "../../shared/apiTypes.js";
import type { PiWebConfigService } from "../configRoutes.js";
import type { WorkspaceContext } from "./workspaceContext.js";
import { loadEffectiveProjectPathAccess } from "./projectPiWebConfig.js";

export async function pathAccessForWorkspaceContext(context: WorkspaceContext, config: Pick<PiWebConfigService, "read"> | undefined): Promise<PiWebPathAccessConfig | undefined> {
  if (config === undefined) return undefined;
  const response = await config.read();
  return loadEffectiveProjectPathAccess(context.project.path, response.effectiveConfig);
}
