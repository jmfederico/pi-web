import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { PiWebConfigResponse, Project, ProjectSettings } from "../../shared/apiTypes.js";

export const DEFAULT_WORKTREE_FOLDER_SETTING = "/defaultWorktreeFolder";

/** Resolve on the project machine, never on the gateway of a remote machine or in the browser. */
export function resolveProjectWorktreeFolder(
  project: Project,
  config: Pick<PiWebConfigResponse, "effectiveConfig" | "enforcedSettings" | "configSources">,
): ProjectSettings["worktreeFolder"] {
  const { path: root, worktreeFolder: override } = project;
  const enforcedBy = config.enforcedSettings?.[DEFAULT_WORKTREE_FOLDER_SETTING];
  const machineFolder = config.effectiveConfig.defaultWorktreeFolder;
  if (enforcedBy === undefined && override !== undefined) {
    return { path: resolve(root, override), source: "project" };
  }
  const folderName = basename(root) || "root";
  if (machineFolder === undefined) {
    return { path: resolve(dirname(root), `${folderName}-worktrees`), source: "suggested" };
  }
  const path = isAbsolute(machineFolder) ? resolve(root, machineFolder, folderName) : resolve(root, machineFolder);
  if (enforcedBy !== undefined) return { path, source: "environment", enforcedBy };
  return { path, source: config.configSources?.[DEFAULT_WORKTREE_FOLDER_SETTING] === "defaults" ? "deployment" : "machine" };
}
