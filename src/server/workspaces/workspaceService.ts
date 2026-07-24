import { createHash } from "node:crypto";
import type { Project, Workspace } from "../types.js";
import { discoverGitWorkspaceRoot, discoverGitWorktrees, isGitRepository, type GitWorktreeInfo } from "./gitWorktreeDiscovery.js";
import { discoverJjWorkspaces, isJjRepository, type JjWorkspaceInfo } from "./jjWorkspaceDiscovery.js";

const idFor = (value: string) => createHash("sha1").update(value).digest("hex").slice(0, 12);

export interface WorkspaceDiscovery {
  isGitRepository(path: string): Promise<boolean>;
  discoverGitWorkspaceRoot(path: string): Promise<string>;
  discoverGitWorktrees(path: string): Promise<GitWorktreeInfo[]>;
  isJjRepository(path: string): Promise<boolean>;
  discoverJjWorkspaces(path: string): Promise<JjWorkspaceInfo[]>;
}

const defaultDiscovery: WorkspaceDiscovery = {
  isGitRepository,
  discoverGitWorkspaceRoot,
  discoverGitWorktrees,
  isJjRepository,
  discoverJjWorkspaces,
};

export class WorkspaceService {
  constructor(private readonly discovery: WorkspaceDiscovery = defaultDiscovery) {}

  async list(project: Project): Promise<Workspace[]> {
    const isJjRepo = await this.discovery.isJjRepository(project.path);
    if (isJjRepo) return this.listJjWorkspaces(project);

    const isGitRepo = await this.discovery.isGitRepository(project.path);
    if (!isGitRepo) return [this.single(project, false)];

    const [worktrees, currentRoot] = await Promise.all([
      this.discovery.discoverGitWorktrees(project.path),
      this.discovery.discoverGitWorkspaceRoot(project.path),
    ]);
    if (worktrees.length === 0) return [this.single(project, true, "git")];

    return worktrees.map((worktree) => {
      const leafName = worktree.path.split("/").filter((part) => part !== "").at(-1);
      return {
        id: idFor(`${project.id}:${worktree.path}`),
        projectId: project.id,
        path: worktree.path,
        label: worktree.branch ?? (worktree.detached === true ? "detached" : leafName ?? worktree.path),
        ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
        vcs: "git",
        isMain: worktree.path === currentRoot,
        isGitRepo: true,
        isGitWorktree: true,
      };
    });
  }

  private async listJjWorkspaces(project: Project): Promise<Workspace[]> {
    const [workspaces, isGitRepo] = await Promise.all([
      this.discovery.discoverJjWorkspaces(project.path),
      this.discovery.isGitRepository(project.path),
    ]);
    if (workspaces.length === 0) return [this.single(project, isGitRepo, "jj")];

    return workspaces.map((workspace) => ({
      id: idFor(`${project.id}:${workspace.path}`),
      projectId: project.id,
      path: workspace.path,
      label: workspace.name,
      vcs: "jj",
      vcsWorkspaceName: workspace.name,
      isMain: workspace.isCurrent,
      isGitRepo,
      isGitWorktree: false,
    }));
  }

  private single(project: Project, isGitRepo: boolean, vcs?: Workspace["vcs"]): Workspace {
    return {
      id: idFor(`${project.id}:${project.path}`),
      projectId: project.id,
      path: project.path,
      label: project.name,
      ...(vcs === undefined ? {} : { vcs }),
      isMain: true,
      isGitRepo,
      isGitWorktree: false,
    };
  }
}
