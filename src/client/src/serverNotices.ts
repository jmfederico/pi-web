import { noticesApi } from "./api";
import type { ServerNotice, ServerNoticeEvent, ServerNoticeSnapshot } from "../../shared/apiTypes";
import { workspaceDeleteOperation } from "../../shared/workspaceDeletion";

const MAX_BUFFERED_NETWORK_EVENTS = 100;

export type ServerNoticeProjectionStatus = "loading" | "fresh" | "stale";

export interface ServerNoticeProjectionView {
  machineId: string;
  status: ServerNoticeProjectionStatus;
  daemonInstanceId: string;
  revision: number;
  notices: ServerNotice[];
}

/** Selected front-end namespace used to project a machine's complete notice snapshot. */
export interface ServerNoticeDisplayContext {
  projectId?: string;
  workspaceId?: string;
  sessionId?: string;
}

/**
 * Keep the server snapshot complete and scope only its front-end presentation.
 * Worktree deletion is project-owned because the operation spans two worktrees.
 */
export function visibleServerNotices(notices: readonly ServerNotice[], context: ServerNoticeDisplayContext): ServerNotice[] {
  return notices.filter((notice) => serverNoticeIsVisible(notice, context));
}

export interface ServerNoticesApi {
  snapshot(machineId: string): Promise<ServerNoticeSnapshot>;
  dismiss(machineId: string, daemonInstanceId: string, noticeId: string): Promise<ServerNoticeSnapshot>;
}

export interface ServerNoticesControllerOptions {
  api?: ServerNoticesApi;
  onChange?: (machineId: string) => void;
  onBackgroundError?: (operation: "snapshot" | "dismiss", machineId: string, error: unknown) => void;
}

interface ProjectionData {
  daemonInstanceId: string;
  revision: number;
  notices: ServerNotice[];
}

interface NetworkObserver {
  generation: number;
  projectionVersion: number;
  events: ServerNoticeEvent[];
  overflowed: boolean;
}

interface MachineServerNoticeState {
  readonly machineId: string;
  status: ServerNoticeProjectionStatus;
  projection: ProjectionData | undefined;
  projectionVersion: number;
  generation: number;
  readonly observers: Set<NetworkObserver>;
  readonly pendingDismissedIds: Set<string>;
  readonly dismissals: Map<string, Promise<void>>;
  refreshPromise: Promise<void> | undefined;
  refreshQueued: boolean;
}

const defaultApi: ServerNoticesApi = {
  snapshot: (machineId) => noticesApi.snapshot(machineId),
  dismiss: (machineId, daemonInstanceId, noticeId) => noticesApi.dismiss(machineId, daemonInstanceId, noticeId),
};

/**
 * Per-machine browser projection of sessiond's current server-owned notices.
 * Full snapshots make refresh the convergence path; revisions and daemon
 * instance ids prevent an older response or daemon from clobbering current UI.
 */
export class ServerNoticesController {
  private readonly api: ServerNoticesApi;
  private readonly onChange: (machineId: string) => void;
  private readonly onBackgroundError: (operation: "snapshot" | "dismiss", machineId: string, error: unknown) => void;
  private readonly machines = new Map<string, MachineServerNoticeState>();

  constructor(options: ServerNoticesControllerOptions = {}) {
    this.api = options.api ?? defaultApi;
    this.onChange = options.onChange ?? (() => undefined);
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
  }

  /** Drop projections and invalidate pending network responses for removed machines. */
  retainMachines(machineIds: ReadonlySet<string>): void {
    for (const [machineId, state] of this.machines) {
      if (machineIds.has(machineId)) continue;
      const changed = state.projection !== undefined;
      state.generation += 1;
      state.observers.clear();
      state.pendingDismissedIds.clear();
      state.dismissals.clear();
      this.machines.delete(machineId);
      if (changed) this.onChange(machineId);
    }
  }

  projection(machineId: string): ServerNoticeProjectionView | undefined {
    const state = this.machines.get(machineId);
    const projection = state?.projection;
    if (state === undefined || projection === undefined) return undefined;
    return {
      machineId,
      status: state.status,
      daemonInstanceId: projection.daemonInstanceId,
      revision: projection.revision,
      notices: projection.notices.filter((notice) => !state.pendingDismissedIds.has(notice.id)),
    };
  }

  hasNotice(machineId: string, matches: (notice: ServerNotice) => boolean): boolean {
    const projection = this.projection(machineId);
    return projection?.status === "fresh" && projection.notices.some(matches);
  }

  applyEvent(machineId: string, event: ServerNoticeEvent): void {
    const state = this.machine(machineId);
    this.recordObservedEvent(state, event);

    const current = state.projection;
    if (current === undefined) {
      if (this.installProjection(state, projectionFromSnapshot(event.snapshot), "fresh")) this.onChange(machineId);
      return;
    }
    if (current.daemonInstanceId !== event.snapshot.daemonInstanceId) {
      const changed = state.status !== "stale";
      state.status = "stale";
      if (changed) this.onChange(machineId);
      if (state.refreshPromise === undefined) void this.refresh(machineId);
      else state.refreshQueued = true;
      return;
    }
    if (event.snapshot.revision <= current.revision) {
      if (state.status === "stale") {
        if (state.refreshPromise === undefined) void this.refresh(machineId);
        else state.refreshQueued = true;
      }
      return;
    }

    if (this.installProjection(state, projectionFromSnapshot(event.snapshot), "fresh")) this.onChange(machineId);
  }

  refresh(machineId: string): Promise<void> {
    const state = this.machine(machineId);
    if (state.refreshPromise !== undefined) {
      state.refreshQueued = true;
      return state.refreshPromise;
    }

    const generation = state.generation;
    const refreshPromise = this.runRefreshLoop(state, generation);
    state.refreshPromise = refreshPromise;
    void refreshPromise.finally(() => {
      if (!this.isCurrent(state, generation) || state.refreshPromise !== refreshPromise) return;
      state.refreshPromise = undefined;
      const refreshAgain = state.refreshQueued;
      state.refreshQueued = false;
      if (refreshAgain) void this.refresh(state.machineId);
    });
    return refreshPromise;
  }

  async refreshAll(): Promise<void> {
    await Promise.all([...this.machines.values()].map(async (state) => { await this.refresh(state.machineId); }));
  }

  dismiss(machineId: string, noticeId: string): Promise<void> {
    const state = this.machines.get(machineId);
    const projection = state?.projection;
    if (state === undefined || projection === undefined) return Promise.resolve();
    const notice = projection.notices.find((candidate) => candidate.id === noticeId);
    if (notice === undefined || state.pendingDismissedIds.has(noticeId)) return Promise.resolve();

    const dismissalKey = `${projection.daemonInstanceId}:${noticeId}`;
    const existing = state.dismissals.get(dismissalKey);
    if (existing !== undefined) return existing;

    const generation = state.generation;
    const observer = this.beginNetworkObservation(state, generation);
    state.pendingDismissedIds.add(noticeId);
    this.onChange(machineId);
    const dismissal = this.runDismissal(state, generation, observer, projection.daemonInstanceId, noticeId);
    state.dismissals.set(dismissalKey, dismissal);
    void dismissal.finally(() => {
      if (state.dismissals.get(dismissalKey) === dismissal) state.dismissals.delete(dismissalKey);
    });
    return dismissal;
  }

  private async runRefreshLoop(state: MachineServerNoticeState, generation: number): Promise<void> {
    do {
      state.refreshQueued = false;
      if (!this.isCurrent(state, generation)) return;
      const changed = this.markRefreshStarted(state);
      if (changed) this.onChange(state.machineId);

      const observer = this.beginNetworkObservation(state, generation);
      try {
        const snapshot = await this.api.snapshot(state.machineId);
        if (!this.isCurrent(state, generation)) return;
        const requiresRefresh = this.applyNetworkSnapshot(state, snapshot, observer);
        if (requiresRefresh) state.refreshQueued = true;
      } catch (error: unknown) {
        if (this.isCurrent(state, generation)) {
          const becameStale = state.status !== "stale";
          state.status = "stale";
          if (becameStale) this.onChange(state.machineId);
          this.onBackgroundError("snapshot", state.machineId, error);
        }
      } finally {
        state.observers.delete(observer);
      }
    } while (state.refreshQueued && this.isCurrent(state, generation));
  }

  private async runDismissal(
    state: MachineServerNoticeState,
    generation: number,
    observer: NetworkObserver,
    daemonInstanceId: string,
    noticeId: string,
  ): Promise<void> {
    try {
      const snapshot = await this.api.dismiss(state.machineId, daemonInstanceId, noticeId);
      if (!this.isCurrent(state, generation)) return;
      const requiresRefresh = this.applyNetworkSnapshot(state, snapshot, observer);
      state.pendingDismissedIds.delete(noticeId);
      if (requiresRefresh) void this.refresh(state.machineId);
    } catch (error: unknown) {
      if (this.isCurrent(state, generation)) this.onBackgroundError("dismiss", state.machineId, error);
    } finally {
      state.observers.delete(observer);
      if (this.isCurrent(state, generation)) {
        state.pendingDismissedIds.delete(noticeId);
        this.onChange(state.machineId);
      }
    }
  }

  private applyNetworkSnapshot(
    state: MachineServerNoticeState,
    snapshot: ServerNoticeSnapshot,
    observer: NetworkObserver,
  ): boolean {
    if (observer.overflowed) return this.markStale(state);

    let candidate = snapshot;
    for (const event of observer.events) {
      if (event.snapshot.daemonInstanceId !== candidate.daemonInstanceId) return this.markStale(state);
      if (event.snapshot.revision > candidate.revision) candidate = event.snapshot;
    }

    const current = state.projection;
    if (current !== undefined && state.projectionVersion !== observer.projectionVersion) {
      if (current.daemonInstanceId !== candidate.daemonInstanceId) return this.markStale(state);
      if (current.revision > candidate.revision) candidate = {
        daemonInstanceId: current.daemonInstanceId,
        revision: current.revision,
        notices: current.notices,
      };
    }

    const changed = this.installProjection(state, projectionFromSnapshot(candidate), "fresh");
    if (changed) this.onChange(state.machineId);
    return false;
  }

  private beginNetworkObservation(state: MachineServerNoticeState, generation: number): NetworkObserver {
    const observer: NetworkObserver = {
      generation,
      projectionVersion: state.projectionVersion,
      events: [],
      overflowed: false,
    };
    state.observers.add(observer);
    return observer;
  }

  private recordObservedEvent(state: MachineServerNoticeState, event: ServerNoticeEvent): void {
    for (const observer of state.observers) {
      if (observer.generation !== state.generation || observer.overflowed) continue;
      if (observer.events.length >= MAX_BUFFERED_NETWORK_EVENTS) {
        observer.events.length = 0;
        observer.overflowed = true;
      } else {
        observer.events.push(event);
      }
    }
  }

  private markRefreshStarted(state: MachineServerNoticeState): boolean {
    const status: ServerNoticeProjectionStatus = state.projection === undefined ? "loading" : "stale";
    if (state.status === status) return false;
    state.status = status;
    return true;
  }

  private markStale(state: MachineServerNoticeState): boolean {
    const changed = state.status !== "stale";
    state.status = "stale";
    if (changed) this.onChange(state.machineId);
    return true;
  }

  private installProjection(state: MachineServerNoticeState, projection: ProjectionData, status: ServerNoticeProjectionStatus): boolean {
    const projectionChanged = !projectionsEqual(state.projection, projection);
    if (state.status === status && !projectionChanged) return false;
    if (projectionChanged) {
      state.projection = projection;
      state.projectionVersion += 1;
    }
    state.status = status;
    return true;
  }

  private machine(machineId: string): MachineServerNoticeState {
    const existing = this.machines.get(machineId);
    if (existing !== undefined) return existing;
    const state: MachineServerNoticeState = {
      machineId,
      status: "stale",
      projection: undefined,
      projectionVersion: 0,
      generation: 0,
      observers: new Set(),
      pendingDismissedIds: new Set(),
      dismissals: new Map(),
      refreshPromise: undefined,
      refreshQueued: false,
    };
    this.machines.set(machineId, state);
    return state;
  }

  private isCurrent(state: MachineServerNoticeState, generation: number): boolean {
    return this.machines.get(state.machineId) === state && state.generation === generation;
  }
}

function serverNoticeIsVisible(notice: ServerNotice, context: ServerNoticeDisplayContext): boolean {
  const noticeContext = notice.context;
  if (notice.source === workspaceDeleteOperation) {
    const projectId = contextValue(noticeContext, "projectId");
    return projectId === undefined || projectId === context.projectId;
  }

  const projectId = contextValue(noticeContext, "projectId");
  const workspaceId = contextValue(noticeContext, "workspaceId");
  const sessionId = contextValue(noticeContext, "sessionId");
  if (projectId === undefined && workspaceId === undefined && sessionId === undefined) return true;
  return (projectId === undefined || projectId === context.projectId)
    && (workspaceId === undefined || workspaceId === context.workspaceId)
    && (sessionId === undefined || sessionId === context.sessionId);
}

function contextValue(context: ServerNotice["context"], key: string): string | undefined {
  const value = context?.[key];
  return typeof value === "string" ? value : undefined;
}

function projectionFromSnapshot(snapshot: ServerNoticeSnapshot): ProjectionData {
  return {
    daemonInstanceId: snapshot.daemonInstanceId,
    revision: snapshot.revision,
    notices: snapshot.notices.map((notice) => ({
      ...notice,
      ...(notice.context === undefined ? {} : { context: { ...notice.context } }),
    })),
  };
}

function projectionsEqual(left: ProjectionData | undefined, right: ProjectionData): boolean {
  if (left?.daemonInstanceId !== right.daemonInstanceId || left.revision !== right.revision) return false;
  if (left.notices.length !== right.notices.length) return false;
  return left.notices.every((notice, index) => JSON.stringify(notice) === JSON.stringify(right.notices[index]));
}
