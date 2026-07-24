import { realpath } from "node:fs/promises";
import { isAbsolute, parse, relative } from "node:path";
import type { Workspace } from "../../shared/apiTypes.js";
import { resolveJjWorkspaceRoot } from "./jjWorkspaceDiscovery.js";

export interface WorkspaceDeletionValidationInput {
  projectPath: string;
  targetWorkspace: Workspace;
  commandWorkspace: Workspace;
}

export interface WorkspaceDeletionValidationDependencies {
  realpath(path: string): Promise<string>;
  resolveJjWorkspaceRoot(repositoryPath: string, workspaceName: string): Promise<string>;
}

const defaultDependencies: WorkspaceDeletionValidationDependencies = {
  realpath,
  resolveJjWorkspaceRoot,
};

export async function validateWorkspaceDeletion(input: WorkspaceDeletionValidationInput, dependencies: WorkspaceDeletionValidationDependencies = defaultDependencies): Promise<void> {
  const [projectPath, targetPath, commandPath] = await Promise.all([
    dependencies.realpath(input.projectPath),
    dependencies.realpath(input.targetWorkspace.path),
    dependencies.realpath(input.commandWorkspace.path),
  ]);

  if (input.targetWorkspace.isMain) throw new Error("The current project workspace cannot be deleted");
  if (targetPath === parse(targetPath).root) throw new Error("Refusing to delete a filesystem root");
  if (targetPath === commandPath) throw new Error("The command workspace cannot delete itself");
  if (isEqualOrAncestor(targetPath, projectPath)) throw new Error("The workspace containing the registered project cannot be deleted");

  if (input.targetWorkspace.vcs === "jj") {
    const workspaceName = input.targetWorkspace.vcsWorkspaceName;
    if (workspaceName === undefined) throw new Error("Jujutsu workspace name is missing");
    const recordedRoot = await dependencies.resolveJjWorkspaceRoot(commandPath, workspaceName);
    const resolvedRoot = await dependencies.realpath(recordedRoot);
    if (resolvedRoot !== targetPath) throw new Error("Jujutsu workspace path changed; refresh workspaces and try again");
  }
}

function isEqualOrAncestor(ancestor: string, path: string): boolean {
  const rel = relative(ancestor, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
