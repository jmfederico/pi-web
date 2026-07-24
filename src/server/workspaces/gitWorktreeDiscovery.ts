import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sanitizedGitEnv } from "../git/gitEnv.js";

const execFileAsync = promisify(execFile);

export interface GitWorktreeInfo {
  path: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
}

export async function isGitRepository(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], { env: sanitizedGitEnv() });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function discoverGitWorkspaceRoot(path: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", path, "rev-parse", "--show-toplevel"], { env: sanitizedGitEnv() });
  return stdout.trim();
}

export async function discoverGitWorktrees(path: string): Promise<GitWorktreeInfo[]> {
  const { stdout } = await execFileAsync("git", ["-C", path, "worktree", "list", "--porcelain"], { env: sanitizedGitEnv() });
  const chunks = stdout.trim().split(/\n\s*\n/).filter(Boolean);

  return chunks.map((chunk) => {
    const info: GitWorktreeInfo = { path: "" };
    for (const line of chunk.split("\n")) {
      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      if (key === "worktree") info.path = value;
      if (key === "branch") info.branch = value.replace(/^refs\/heads\//, "");
      if (key === "bare") info.bare = true;
      if (key === "detached") info.detached = true;
    }
    return info;
  }).filter((w) => w.path);
}
