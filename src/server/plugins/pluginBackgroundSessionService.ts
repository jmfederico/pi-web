import type {
  BackgroundSessionCreateRequest,
  BackgroundSessionLease,
  BackgroundSessionPromptResult,
  BackgroundSessionService,
  BackgroundSessionSnapshot,
  BackgroundSessionUsage,
} from "../../server-plugin-api.js";
import type { WorkspaceProviderAuthorityResolution } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import type { PiSessionService } from "../sessions/piSessionService.js";

interface BackgroundProjectReader {
  requireProject(projectId: string): Promise<Project>;
}

interface BackgroundWorkspaceAuthority {
  resolve(project: Project): Promise<WorkspaceProviderAuthorityResolution>;
}

type BackgroundSessionHost = Pick<PiSessionService,
  | "backgroundSessionModels"
  | "startBackgroundSession"
  | "promptBackgroundSession"
  | "backgroundSessionStatus"
  | "abortBackgroundSession"
  | "forceStopBackgroundSession"
  | "releaseBackgroundSession"
>;

export class PluginBackgroundSessionRegistry {
  private readonly leases = new Map<string, Set<HostBackgroundSessionLease>>();
  private readonly pendingCreates = new Map<string, Set<Promise<BackgroundSessionLease>>>();
  private readonly quiescedPlugins = new Set<string>();
  private quiescing = false;

  constructor(
    private readonly projects: BackgroundProjectReader,
    private readonly workspaces: BackgroundWorkspaceAuthority,
    private readonly sessions: BackgroundSessionHost,
    private readonly pendingCreateDrainMs = 10_000,
  ) {}

  forPlugin(pluginId: string): BackgroundSessionService {
    return Object.freeze({
      listModels: () => this.sessions.backgroundSessionModels(),
      create: (request: BackgroundSessionCreateRequest) => this.create(pluginId, request),
    });
  }

  async quiescePlugin(pluginId: string): Promise<void> {
    this.quiescedPlugins.add(pluginId);
    await this.quiesceOwned(pluginId, pluginId, () => this.leases.get(pluginId) ?? []);
  }

  async quiesceAll(): Promise<void> {
    this.quiescing = true;
    await this.quiesceOwned("all plugins", undefined, () => [...this.leases.values()].flatMap((owned) => [...owned]));
  }

  private create(pluginId: string, request: BackgroundSessionCreateRequest): Promise<BackgroundSessionLease> {
    if (this.quiescing || this.quiescedPlugins.has(pluginId)) {
      return Promise.reject(new Error(`Background sessions are quiescing for plugin ${pluginId}`));
    }
    const pending = this.createLease(pluginId, request);
    const ownedPending = this.pendingCreates.get(pluginId) ?? new Set<Promise<BackgroundSessionLease>>();
    ownedPending.add(pending);
    this.pendingCreates.set(pluginId, ownedPending);
    return pending.finally(() => {
      ownedPending.delete(pending);
      if (ownedPending.size === 0) this.pendingCreates.delete(pluginId);
    });
  }

  private async createLease(pluginId: string, request: BackgroundSessionCreateRequest): Promise<BackgroundSessionLease> {
    const project = await this.projects.requireProject(requireId(request.projectId, "projectId"));
    const resolution = await this.workspaces.resolve(project);
    if (resolution.status === "degraded") throw new Error(`Workspace authority is degraded for project ${project.id}`);
    const workspace = resolution.workspaces.find(({ id }) => id === requireId(request.workspaceId, "workspaceId"));
    if (workspace === undefined) throw new Error("Workspace not found");
    const created = await this.sessions.startBackgroundSession(pluginId, workspace.path, {
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
    });
    const ref = { id: created.session.id, cwd: workspace.path };
    const lease = new HostBackgroundSessionLease(pluginId, ref, this.sessions, created.status, () => {
      const owned = this.leases.get(pluginId);
      owned?.delete(lease);
      if (owned?.size === 0) this.leases.delete(pluginId);
    });
    const owned = this.leases.get(pluginId) ?? new Set<HostBackgroundSessionLease>();
    owned.add(lease);
    this.leases.set(pluginId, owned);
    if (this.quiescing || this.quiescedPlugins.has(pluginId)) {
      try {
        await lease.forceStop();
      } catch (error) {
        throw new AggregateError(
          [error],
          `Failed to clean up a late background session create for plugin ${pluginId}`,
          { cause: error },
        );
      }
      throw new Error(`Background sessions are quiescing for plugin ${pluginId}`);
    }
    return lease.publicHandle();
  }

  private async quiesceOwned(
    owner: string,
    pluginId: string | undefined,
    leases: () => Iterable<HostBackgroundSessionLease>,
  ): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.awaitPendingCreates(pluginId);
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.forceStopLeases(owner, leases());
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `Background session cleanup failed for ${owner}`);
  }

  private async awaitPendingCreates(pluginId?: string): Promise<void> {
    const pending = pluginId === undefined
      ? [...this.pendingCreates.values()].flatMap((owned) => [...owned])
      : [...(this.pendingCreates.get(pluginId) ?? [])];
    if (pending.length === 0) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Timed out after ${String(this.pendingCreateDrainMs)}ms waiting for pending background session creates`));
      }, this.pendingCreateDrainMs);
      timeout.unref();
    });
    try {
      await Promise.race([Promise.allSettled(pending), timedOut]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async forceStopLeases(owner: string, leases: Iterable<HostBackgroundSessionLease>): Promise<void> {
    const results = await Promise.allSettled([...leases].map((lease) => lease.forceStop()));
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        const failure: unknown = result.reason;
        failures.push(failure);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to force-stop ${String(failures.length)} background session lease(s) for ${owner}`);
    }
  }
}

interface ActivePrompt {
  readonly generation: number;
  aborted: boolean;
}

class HostBackgroundSessionLease {
  private released = false;
  private activePrompt: ActivePrompt | undefined;
  private promptCompletion: Promise<void> | undefined;
  private completePrompt: (() => void) | undefined;
  private promptGeneration = 0;
  private releaseOperation: Promise<void> | undefined;
  private forceStopOperation: Promise<void> | undefined;
  private lastSnapshot: BackgroundSessionSnapshot;

  constructor(
    private readonly pluginId: string,
    private readonly ref: { id: string; cwd: string },
    private readonly sessions: BackgroundSessionHost,
    initialStatus: Awaited<ReturnType<PiSessionService["status"]>>,
    private readonly onReleased: () => void,
  ) {
    this.lastSnapshot = snapshotFromStatus(initialStatus);
  }

  publicHandle(): BackgroundSessionLease {
    return Object.freeze({
      sessionId: this.ref.id,
      prompt: (text: string) => this.prompt(text),
      snapshot: () => this.snapshot(),
      abort: () => this.abort(),
      forceStop: () => this.forceStop(),
      release: () => this.release(),
    });
  }

  private async prompt(text: string): Promise<BackgroundSessionPromptResult> {
    this.requireActive();
    if (this.activePrompt !== undefined) throw new Error("Background session lease already has an active prompt");
    const prompt = { generation: ++this.promptGeneration, aborted: false };
    this.activePrompt = prompt;
    this.promptCompletion = new Promise((resolve) => { this.completePrompt = resolve; });
    try {
      const status = await this.sessions.promptBackgroundSession(this.pluginId, this.ref, text);
      this.lastSnapshot = snapshotFromStatus(status);
      return { status: prompt.aborted ? "aborted" : "completed", usage: this.lastSnapshot.usage };
    } catch (error) {
      const snapshot = await this.captureSnapshot();
      return {
        status: prompt.aborted ? "aborted" : "failed",
        usage: snapshot.usage,
        ...(prompt.aborted ? {} : { error: errorMessage(error) }),
      };
    } finally {
      if (this.activePrompt === prompt) this.activePrompt = undefined;
      this.completePrompt?.();
      this.completePrompt = undefined;
      await this.releaseNow();
      this.promptCompletion = undefined;
    }
  }

  private async snapshot(): Promise<BackgroundSessionSnapshot> {
    if (this.released) return this.lastSnapshot;
    return this.captureSnapshot();
  }

  private async captureSnapshot(): Promise<BackgroundSessionSnapshot> {
    if (this.released) return this.lastSnapshot;
    try {
      this.lastSnapshot = snapshotFromStatus(await this.sessions.backgroundSessionStatus(this.pluginId, this.ref));
    } catch {
      // The last host-observed usage remains the minimal terminal snapshot.
    }
    return this.lastSnapshot;
  }

  private async abort(): Promise<void> {
    if (this.released) return;
    const prompt = this.activePrompt;
    if (prompt !== undefined) prompt.aborted = true;
    try {
      await this.sessions.abortBackgroundSession(this.pluginId, this.ref);
    } catch (error) {
      if (prompt !== undefined && this.activePrompt?.generation === prompt.generation) prompt.aborted = false;
      throw error;
    }
  }

  async forceStop(): Promise<void> {
    if (this.released) return;
    if (this.forceStopOperation !== undefined) return this.forceStopOperation;
    const prompt = this.activePrompt;
    if (prompt !== undefined) prompt.aborted = true;
    const operation = this.sessions.forceStopBackgroundSession(this.pluginId, this.ref).then(
      () => {
        this.markReleased();
      },
      (error: unknown) => {
        if (prompt !== undefined && this.activePrompt?.generation === prompt.generation) prompt.aborted = false;
        this.forceStopOperation = undefined;
        throw error;
      },
    );
    this.forceStopOperation = operation;
    await operation;
  }

  private async release(): Promise<void> {
    if (this.released) return;
    const completion = this.promptCompletion;
    if (completion !== undefined) await completion;
    await this.releaseNow();
  }

  private async releaseNow(): Promise<void> {
    if (this.released) return;
    if (this.releaseOperation !== undefined) return this.releaseOperation;
    const operation = Promise.resolve()
      .then(() => {
        this.sessions.releaseBackgroundSession(this.pluginId, this.ref);
        this.markReleased();
      })
      .catch((error: unknown) => {
        this.releaseOperation = undefined;
        throw error;
      });
    this.releaseOperation = operation;
    await operation;
  }

  private markReleased(): void {
    if (this.released) return;
    this.released = true;
    this.onReleased();
  }

  private requireActive(): void {
    if (this.released || this.releaseOperation !== undefined || this.forceStopOperation !== undefined) {
      throw new Error("Background session lease is released");
    }
  }
}

function snapshotFromStatus(status: Awaited<ReturnType<PiSessionService["status"]>>): BackgroundSessionSnapshot {
  return Object.freeze({
    sessionId: status.sessionId,
    status: status.isStreaming || status.isCompacting || status.isBashRunning || status.pendingMessageCount > 0 ? "running" : "idle",
    ...(status.model?.provider === undefined || status.model.id === undefined || status.model.name === undefined
      ? {}
      : { model: Object.freeze({ provider: status.model.provider, id: status.model.id, name: status.model.name }) }),
    thinkingLevel: status.thinkingLevel ?? "off",
    usage: usageFromStatus(status),
  });
}

function usageFromStatus(status: Awaited<ReturnType<PiSessionService["status"]>>): BackgroundSessionUsage {
  return Object.freeze({
    ...status.tokens,
    ...(Number.isFinite(status.cost) ? { estimatedCostUsd: Math.max(0, status.cost) } : {}),
  });
}

function requireId(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${name} is required`);
  return normalized;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
