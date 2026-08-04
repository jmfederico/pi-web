import { cwdPathsEqual } from "../workingDirectory.js";
import { RegisteredProjectWorkspaceCwds, type ProjectWorkspaceCwds, type ProjectWorkspaceCwdsDeps } from "../workspaces/projectWorkspaceCwds.js";

/**
 * Decision describing whether a LLM-spawned session may target a given cwd.
 *
 * - `allowed: true` carries the canonical workspace path to start the session in
 *   (always one of the project's known workspace paths, so it is guaranteed
 *   visible in the web UI).
 * - `not-registered` means the spawning session's cwd belongs to no registered
 *   project, so spawning must be refused to preserve visibility.
 * - `out-of-project` means the requested cwd is not a workspace of the spawning
 *   session's project; `allowedCwds` lists the valid targets for the caller to
 *   surface.
 */
export type SpawnTargetDecision =
  | { allowed: true; cwd: string }
  | { allowed: false; reason: "not-registered" }
  | { allowed: false; reason: "out-of-project"; allowedCwds: string[] };

/**
 * Owns the rule that keeps LLM-spawned sessions visible: a spawned session may
 * only target a workspace (worktree, or root) of the registered project that
 * owns the spawning session. The rule is evaluated through the live provider
 * registry so a workspace the agent just created is included.
 */
export interface SpawnTargetResolver {
  /**
   * Decide whether a session spawned from `spawningCwd` may target
   * `requestedCwd` (defaulting to `spawningCwd` when omitted), returning the
   * canonical target cwd when allowed.
   */
  resolveSpawnTarget(spawningCwd: string, requestedCwd: string | undefined): Promise<SpawnTargetDecision>;
}

export type ProjectScopedSpawnTargetResolverDeps = ProjectWorkspaceCwdsDeps;

/**
 * Default resolver composing the project registry and live provider resolution.
 * It finds the registered project whose current workspace set contains the
 * spawning session's cwd, then validates the requested target against that set.
 */
export class ProjectScopedSpawnTargetResolver implements SpawnTargetResolver {
  private readonly projectWorkspaces: ProjectWorkspaceCwds;

  constructor(deps: ProjectScopedSpawnTargetResolverDeps) {
    this.projectWorkspaces = new RegisteredProjectWorkspaceCwds(deps);
  }

  async resolveSpawnTarget(spawningCwd: string, requestedCwd: string | undefined): Promise<SpawnTargetDecision> {
    const allowedCwds = await this.projectWorkspaces.forCwd(spawningCwd);
    if (allowedCwds === undefined) return { allowed: false, reason: "not-registered" };
    const target = requestedCwd === undefined || requestedCwd === "" ? spawningCwd : requestedCwd;
    const match = allowedCwds.find((path) => cwdPathsEqual(path, target));
    if (match === undefined) return { allowed: false, reason: "out-of-project", allowedCwds };
    return { allowed: true, cwd: match };
  }
}
