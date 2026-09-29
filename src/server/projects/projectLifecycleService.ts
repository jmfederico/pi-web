import type { ProjectService } from "./projectService.js";
import type { Project, WorkspaceProviderAuthorityResolution } from "../../shared/apiTypes.js";

interface ProjectLifecycleDependencies {
  projects: Pick<ProjectService, "list" | "add" | "close">;
  workspaces: { resolve(project: Project): Promise<WorkspaceProviderAuthorityResolution> };
  hasUnread(): boolean;
  reconcileUnreadWorkspaces(cwds: Iterable<string>): Promise<void>;
  onProjectsChanged(): void;
  logger: { warn(details: Record<string, unknown>, message: string): void };
}

const UNREAD_CLEANUP_DELAY_MS = 60_000;

/** Project mutations plus eventual garbage collection of orphan unread entries. */
export class ProjectLifecycleService {
  private queue: Promise<unknown> = Promise.resolve();
  private cleanupTimer: NodeJS.Timeout | undefined;
  private stopping = false;

  constructor(private readonly dependencies: ProjectLifecycleDependencies) {}

  /** Called for existing startup unread, new completions, and removals—not reads. */
  scheduleCleanup(): void {
    if (this.stopping || this.cleanupTimer !== undefined || !this.dependencies.hasUnread()) return;
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = undefined;
      void this.serialized(() => this.cleanupUnread()).catch((error: unknown) => {
        this.dependencies.logger.warn({ err: error }, "orphan unread cleanup failed; will retry");
        this.scheduleCleanup();
      });
    }, UNREAD_CLEANUP_DELAY_MS);
    this.cleanupTimer.unref();
  }

  add(input: Parameters<ProjectService["add"]>[0]): Promise<Project> {
    return this.serialized(async () => {
      // Admission is the one synchronous cleanup boundary: do not make an old
      // orphan cwd valid again before its historical unread has been removed.
      this.clearCleanupTimer();
      try {
        await this.cleanupUnread();
      } catch (error) {
        this.scheduleCleanup();
        throw error;
      }
      const project = await this.dependencies.projects.add(input);
      this.dependencies.onProjectsChanged();
      return project;
    });
  }

  close(id: string): Promise<void> {
    return this.serialized(async () => {
      await this.dependencies.projects.close(id);
      this.dependencies.onProjectsChanged();
      this.scheduleCleanup();
    });
  }

  /** Stop the timer and drain admitted work before sessions/persistence shut down. */
  async closeAll(): Promise<void> {
    this.stopping = true;
    this.clearCleanupTimer();
    await this.queue;
  }

  private async cleanupUnread(): Promise<void> {
    // Re-check at execution time: the user may have read everything while the
    // timer was pending. Empty catalogs never require workspace discovery.
    if (!this.dependencies.hasUnread()) return;
    const projects = await this.dependencies.projects.list();
    const resolutions = await Promise.all(projects.map((project) => this.dependencies.workspaces.resolve(project)));
    // A failed lookup is not an authoritative empty workspace list.
    for (const resolution of resolutions) {
      if (resolution.status === "degraded" || resolution.diagnostics.length > 0) {
        throw new Error(`Cannot clean up unread state: workspace resolution incomplete for ${resolution.projectId}`);
      }
    }
    await this.dependencies.reconcileUnreadWorkspaces(
      resolutions.flatMap((resolution) => resolution.workspaces.map((workspace) => workspace.path)),
    );
  }

  private clearCleanupTimer(): void {
    if (this.cleanupTimer !== undefined) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error("Project lifecycle is shutting down"));
    const result = this.queue.then(operation);
    // Errors reach their caller without poisoning later mutations or retries.
    this.queue = result.catch(() => undefined);
    return result;
  }
}
