import type { Workspace } from "./apiTypes.js";

export function isDeletableWorkspace(workspace: Pick<Workspace, "isMain" | "isGitWorktree" | "vcs" | "vcsWorkspaceName"> | undefined): boolean {
  if (workspace === undefined || workspace.isMain) return false;
  return workspace.isGitWorktree || (workspace.vcs === "jj" && workspace.vcsWorkspaceName !== undefined);
}
