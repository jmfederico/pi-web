import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../shared/apiTypes.js";
import { validateWorkspaceDeletion, type WorkspaceDeletionValidationDependencies } from "./workspaceDeletionSafety.js";

const mainWorkspace = workspace({ id: "main", path: "/repo", isMain: true, vcsWorkspaceName: "default" });
const targetWorkspace = workspace({ id: "feature", path: "/tmp/feature", vcsWorkspaceName: "feature" });

function workspace(patch: Partial<Workspace>): Workspace {
  return {
    id: "workspace",
    projectId: "project",
    path: "/workspace",
    label: "workspace",
    vcs: "jj",
    vcsWorkspaceName: "workspace",
    isMain: false,
    isGitRepo: false,
    isGitWorktree: false,
    ...patch,
  };
}

function dependencies(paths: Record<string, string> = {}): WorkspaceDeletionValidationDependencies {
  return {
    realpath: vi.fn((path: string) => Promise.resolve(paths[path] ?? path)),
    resolveJjWorkspaceRoot: vi.fn(() => Promise.resolve("/tmp/feature")),
  };
}

describe("workspace deletion safety", () => {
  it("rejects deleting the workspace root containing a registered project subdirectory", async () => {
    await expect(validateWorkspaceDeletion({
      projectPath: "/repo/subdir",
      targetWorkspace: workspace({ path: "/repo", isMain: false }),
      commandWorkspace: workspace({ path: "/tmp/other" }),
    }, dependencies())).rejects.toThrow("containing the registered project");
  });

  it("rejects stale Jujutsu workspace path metadata", async () => {
    const deps = dependencies();
    deps.resolveJjWorkspaceRoot = vi.fn(() => Promise.resolve("/tmp/moved"));

    await expect(validateWorkspaceDeletion({ projectPath: "/repo", targetWorkspace, commandWorkspace: mainWorkspace }, deps)).rejects.toThrow("workspace path changed");
  });

  it("accepts a distinct Jujutsu workspace whose live root matches", async () => {
    await expect(validateWorkspaceDeletion({ projectPath: "/repo", targetWorkspace, commandWorkspace: mainWorkspace }, dependencies())).resolves.toBeUndefined();
  });
});
