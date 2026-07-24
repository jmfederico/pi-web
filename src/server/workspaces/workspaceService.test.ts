import { describe, expect, it, vi } from "vitest";
import type { Project } from "../types.js";
import { WorkspaceService, type WorkspaceDiscovery } from "./workspaceService.js";

const project: Project = {
  id: "p1",
  name: "Project",
  path: "/repo",
  createdAt: "2026-07-01T00:00:00.000Z",
};

function discovery(overrides: Partial<WorkspaceDiscovery> = {}): WorkspaceDiscovery {
  return {
    isGitRepository: vi.fn().mockResolvedValue(false),
    discoverGitWorkspaceRoot: vi.fn().mockResolvedValue("/repo"),
    discoverGitWorktrees: vi.fn().mockResolvedValue([]),
    isJjRepository: vi.fn().mockResolvedValue(false),
    discoverJjWorkspaces: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("WorkspaceService", () => {
  it("discovers Jujutsu workspaces before falling back to Git worktrees", async () => {
    const discoverGitWorktrees = vi.fn().mockResolvedValue([]);
    const adapters = discovery({
      isJjRepository: vi.fn().mockResolvedValue(true),
      isGitRepository: vi.fn().mockResolvedValue(true),
      discoverGitWorktrees,
      discoverJjWorkspaces: vi.fn().mockResolvedValue([
        { name: "default", path: "/repo", isCurrent: true },
        { name: "feature", path: "/tmp/feature", isCurrent: false },
      ]),
    });

    const workspaces = await new WorkspaceService(adapters).list(project);

    expect(workspaces).toEqual([
      expect.objectContaining({ path: "/repo", label: "default", vcs: "jj", vcsWorkspaceName: "default", isMain: true, isGitRepo: true, isGitWorktree: false }),
      expect.objectContaining({ path: "/tmp/feature", label: "feature", vcs: "jj", vcsWorkspaceName: "feature", isMain: false, isGitRepo: true, isGitWorktree: false }),
    ]);
    expect(discoverGitWorktrees).not.toHaveBeenCalled();
  });

  it("marks the current Jujutsu workspace main when the registered project is a subdirectory", async () => {
    const workspaces = await new WorkspaceService(discovery({
      isJjRepository: vi.fn().mockResolvedValue(true),
      discoverJjWorkspaces: vi.fn().mockResolvedValue([{ name: "default", path: "/repo", isCurrent: true }]),
    })).list({ ...project, path: "/repo/subdir" });

    expect(workspaces[0]).toMatchObject({ path: "/repo", isMain: true, vcs: "jj" });
  });

  it("marks the current Git worktree main when the registered project is a subdirectory", async () => {
    const workspaces = await new WorkspaceService(discovery({
      isGitRepository: vi.fn().mockResolvedValue(true),
      discoverGitWorkspaceRoot: vi.fn().mockResolvedValue("/repo"),
      discoverGitWorktrees: vi.fn().mockResolvedValue([{ path: "/repo", branch: "main" }, { path: "/tmp/feature", branch: "feature" }]),
    })).list({ ...project, path: "/repo/subdir" });

    expect(workspaces).toEqual([
      expect.objectContaining({ path: "/repo", isMain: true, vcs: "git" }),
      expect.objectContaining({ path: "/tmp/feature", isMain: false, vcs: "git" }),
    ]);
  });

  it("hides prunable linked Git worktrees", async () => {
    const workspaces = await new WorkspaceService(discovery({
      isGitRepository: vi.fn().mockResolvedValue(true),
      discoverGitWorktrees: vi.fn().mockResolvedValue([
        { path: "/repo", branch: "main" },
        { path: "/repo-worktrees/gone", branch: "gone", prunable: true },
        { path: "/repo-worktrees/live", branch: "live" },
      ]),
    })).list(project);

    expect(workspaces.map((workspace) => workspace.path)).toEqual(["/repo", "/repo-worktrees/live"]);
  });

  it("keeps the project's own worktree if Git marks it prunable", async () => {
    const workspaces = await new WorkspaceService(discovery({
      isGitRepository: vi.fn().mockResolvedValue(true),
      discoverGitWorktrees: vi.fn().mockResolvedValue([{ path: "/repo", branch: "main", prunable: true }]),
    })).list(project);

    expect(workspaces).toEqual([expect.objectContaining({ path: "/repo", label: "main", isMain: true, isGitWorktree: true })]);
  });

  it("falls back to the project when every linked worktree is prunable", async () => {
    const workspaces = await new WorkspaceService(discovery({
      isGitRepository: vi.fn().mockResolvedValue(true),
      discoverGitWorktrees: vi.fn().mockResolvedValue([{ path: "/repo-worktrees/gone", branch: "gone", prunable: true }]),
    })).list(project);

    expect(workspaces).toEqual([expect.objectContaining({ path: "/repo", label: "Project", vcs: "git", isMain: true, isGitRepo: true, isGitWorktree: false })]);
  });

  it("labels detached worktrees without inventing a branch", async () => {
    const workspaces = await new WorkspaceService(discovery({
      isGitRepository: vi.fn().mockResolvedValue(true),
      discoverGitWorktrees: vi.fn().mockResolvedValue([
        { path: "/repo", branch: "main" },
        { path: "/repo-worktrees/detached", detached: true },
      ]),
    })).list(project);

    expect(workspaces.map((workspace) => ({ label: workspace.label, branch: workspace.branch }))).toEqual([
      { label: "main", branch: "main" },
      { label: "detached", branch: undefined },
    ]);
  });

  it("keeps plain directories as a single workspace when neither VCS is detected", async () => {
    const workspaces = await new WorkspaceService(discovery()).list(project);

    expect(workspaces).toEqual([
      expect.objectContaining({ path: "/repo", label: "Project", isMain: true, isGitRepo: false, isGitWorktree: false }),
    ]);
  });
});
