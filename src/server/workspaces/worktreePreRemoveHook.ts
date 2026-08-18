import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { isNodeErrorWithCode } from "./pathSafety.js";

/**
 * Relative path, from the workspace the removal command runs in, of the optional
 * repo-provided hook that runs before a provider's workspace removal command.
 */
const WORKTREE_PRE_REMOVE_HOOK_RELATIVE_PATH = ".pi-web/hooks/worktree-pre-remove";

/** Executability probe for the pre-remove hook; injectable so removal stays testable without a real filesystem. */
export interface WorktreePreRemoveHookProbe {
  isExecutable(path: string): Promise<boolean>;
}

export const realWorktreePreRemoveHookProbe: WorktreePreRemoveHookProbe = {
  async isExecutable(path) {
    try {
      await access(path, constants.X_OK);
      return true;
    } catch (error) {
      if (
        isNodeErrorWithCode(error, "ENOENT")
        || isNodeErrorWithCode(error, "ENOTDIR")
        || isNodeErrorWithCode(error, "EACCES")
        || isNodeErrorWithCode(error, "EPERM")
      ) return false;
      throw error;
    }
  },
};

/** Absolute hook path for the workspace a removal command runs from. */
export function worktreePreRemoveHookPath(commandWorkspacePath: string): string {
  return join(commandWorkspacePath, WORKTREE_PRE_REMOVE_HOOK_RELATIVE_PATH);
}

/**
 * Compose the hook and the provider's removal command into one command. `&&` is
 * the fail-closed guarantee: a non-zero hook exit prevents the removal.
 */
export function composeWorktreePreRemoveCommand(hookPath: string, targetPath: string, removalCommand: string): string {
  return `${shellQuote(hookPath)} ${shellQuote(targetPath)} && ${removalCommand}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
