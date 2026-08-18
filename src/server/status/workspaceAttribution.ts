import { isAbsolute, relative } from "node:path";
import type { Project, WorkspaceListing } from "../types.js";
import { canonicalizeStoredCwd } from "../workingDirectory.js";

/** The workspace and project a working directory belongs to. */
export interface CwdAttribution {
  projectId: string;
  workspaceId: string;
}

/**
 * Resolves active working directories to the workspace and project that own
 * them, so status roll-up happens where projects and workspaces are known.
 * A cwd that matches no known workspace is simply absent from the result.
 */
export interface WorkspaceAttribution {
  attribute(cwds: Iterable<string>): Promise<ReadonlyMap<string, CwdAttribution>>;
  /** Drop the cached topology after a mutation this process performed. */
  invalidate(): void;
}

interface WorkspaceAttributionProjectLister {
  list(): Promise<Project[]>;
}

interface WorkspaceAttributionWorkspaceLister {
  list(project: Project): Promise<WorkspaceListing[]>;
}

interface WorkspaceAttributionLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface WorkspaceAttributionDependencies {
  projects: WorkspaceAttributionProjectLister;
  workspaces: WorkspaceAttributionWorkspaceLister;
  logger: WorkspaceAttributionLogger;
  /**
   * Upper bound on how long a cached topology may be reused. Mutations this
   * daemon performs call `invalidate()`; project add/close happens in the web
   * process and worktrees can be created straight from a terminal, so those
   * are picked up on the next expiry instead.
   */
  topologyTtlMs?: number;
  now?: () => number;
}

const DEFAULT_WORKSPACE_TOPOLOGY_TTL_MS = 15_000;

interface AttributedWorkspacePath {
  path: string;
  /** Segment count, so the deepest containing workspace wins a nested match. */
  depth: number;
  attribution: CwdAttribution;
}

interface TopologyCacheEntry {
  loadedAt: number;
  workspaces: Promise<readonly AttributedWorkspacePath[]>;
}

/**
 * Caches the project/workspace topology so status recomputation never triggers
 * one workspace provider listing per status change. Listing runs at most once
 * per cache window, and one in-flight load is shared by concurrent callers.
 */
export class CachedWorkspaceAttribution implements WorkspaceAttribution {
  private readonly topologyTtlMs: number;
  private readonly now: () => number;
  private cache: TopologyCacheEntry | undefined;

  constructor(private readonly dependencies: WorkspaceAttributionDependencies) {
    this.topologyTtlMs = dependencies.topologyTtlMs ?? DEFAULT_WORKSPACE_TOPOLOGY_TTL_MS;
    this.now = dependencies.now ?? (() => Date.now());
  }

  async attribute(cwds: Iterable<string>): Promise<ReadonlyMap<string, CwdAttribution>> {
    const requested = [...new Set(cwds)].filter((cwd) => cwd !== "");
    if (requested.length === 0) return new Map();

    const workspaces = await this.topology();
    const attributions = new Map<string, CwdAttribution>();
    for (const cwd of requested) {
      const canonical = canonicalizeStoredCwd(cwd);
      const owner = workspaces.find((workspace) => containsCwd(workspace.path, canonical));
      if (owner !== undefined) attributions.set(cwd, owner.attribution);
    }
    return attributions;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private topology(): Promise<readonly AttributedWorkspacePath[]> {
    const cached = this.cache;
    if (cached !== undefined && this.now() - cached.loadedAt < this.topologyTtlMs) return cached.workspaces;
    const entry: TopologyCacheEntry = { loadedAt: this.now(), workspaces: this.loadTopology() };
    this.cache = entry;
    return entry.workspaces;
  }

  /**
   * Never rejects: a listing failure is logged and leaves the affected project
   * without workspaces for this window, so its cwds fall to the unattributed
   * bucket instead of failing the whole status projection.
   */
  private async loadTopology(): Promise<readonly AttributedWorkspacePath[]> {
    let projects: Project[];
    try {
      projects = await this.dependencies.projects.list();
    } catch (error) {
      this.dependencies.logger.warn({ err: error }, "workspace attribution could not list projects");
      return [];
    }

    const listed = await Promise.all(projects.map((project) => this.listWorkspaces(project)));
    // Deepest first, so a cwd inside a nested workspace is attributed to that
    // workspace rather than to the workspace containing it.
    return listed.flat().sort((left, right) => right.depth - left.depth);
  }

  private async listWorkspaces(project: Project): Promise<AttributedWorkspacePath[]> {
    try {
      const workspaces = await this.dependencies.workspaces.list(project);
      return workspaces.map((workspace) => attributedWorkspacePath(workspace));
    } catch (error) {
      this.dependencies.logger.warn(
        { err: error, projectId: project.id },
        "workspace attribution could not list workspaces for a project",
      );
      return [];
    }
  }
}

function attributedWorkspacePath(workspace: WorkspaceListing): AttributedWorkspacePath {
  const path = canonicalizeStoredCwd(workspace.path);
  return {
    path,
    depth: path.split(/[\\/]+/).filter((segment) => segment !== "").length,
    // A workspace carries its own project id, so a worktree outside the
    // project directory is still attributed to its project.
    attribution: { projectId: workspace.projectId, workspaceId: workspace.id },
  };
}

/** Segment-aware containment, so `/srv/wt1` never claims `/srv/wt10`. */
function containsCwd(workspacePath: string, cwd: string): boolean {
  if (workspacePath === cwd) return true;
  const rel = relative(workspacePath, cwd);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
