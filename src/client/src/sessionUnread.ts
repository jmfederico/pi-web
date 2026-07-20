import { sessionsApi } from "./api";
import { SESSION_UNREAD_LIMIT, type SessionRef, type SessionUnreadCatalogSnapshot, type SessionUnreadEvent, type SessionUnreadSummary } from "../../shared/apiTypes";

const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set();
const MAX_BUFFERED_NETWORK_EVENTS = SESSION_UNREAD_LIMIT + 1;

export type SessionUnreadCapabilityState = "unknown" | "supported" | "unsupported";
export type SessionUnreadProjectionStatus = "loading" | "fresh" | "stale";

export interface SessionUnreadApi {
  unreadCatalog(machineId: string): Promise<SessionUnreadCatalogSnapshot>;
  acknowledgeUnread(session: SessionRef, catalogId: string, throughCompletionOrder: number, machineId: string): Promise<SessionUnreadCatalogSnapshot>;
}

export interface SessionUnreadControllerOptions {
  api?: SessionUnreadApi | undefined;
  onChange?: ((machineId: string) => void) | undefined;
  onBackgroundError?: ((operation: "snapshot" | "acknowledge", machineId: string, error: unknown) => void) | undefined;
}

export interface SessionUnreadProjectionView extends SessionUnreadCatalogSnapshot {
  status: SessionUnreadProjectionStatus;
}

interface ProjectionData {
  catalogId: string;
  catalogRevision: number;
  summariesByIdentity: Map<string, SessionUnreadSummary>;
}

interface NetworkObserver {
  generation: number;
  projectionVersion: number;
  projectionStatus: SessionUnreadProjectionStatus;
  events: SessionUnreadEvent[];
  overflowed: boolean;
}

interface MachineUnreadState {
  readonly machineId: string;
  capability: SessionUnreadCapabilityState;
  status: SessionUnreadProjectionStatus;
  projection: ProjectionData | undefined;
  projectionVersion: number;
  generation: number;
  readonly observers: Set<NetworkObserver>;
  readonly acknowledgements: Map<string, Promise<void>>;
  refreshPromise: Promise<void> | undefined;
  refreshQueued: boolean;
}

interface ProjectionTransition {
  projection: ProjectionData;
  status: SessionUnreadProjectionStatus;
  requiresRefresh: boolean;
}

const defaultApi: SessionUnreadApi = {
  unreadCatalog: (machineId) => sessionsApi.unreadCatalog(machineId),
  acknowledgeUnread: (session, catalogId, throughCompletionOrder, machineId) => (
    sessionsApi.acknowledgeUnread(session, catalogId, throughCompletionOrder, machineId)
  ),
};

/**
 * Per-machine browser projection of the daemon-owned unread catalog.
 *
 * HTTP snapshots establish join state, while contiguous socket revisions keep
 * it current. Network responses observe socket events that race their request;
 * same-epoch events are replayed and ambiguous epoch/gap races force a trailing
 * snapshot. Read acknowledgements always carry the exact epoch and completion
 * order shown to the user, so the daemon can reject stale clears.
 */
export class SessionUnreadController {
  private readonly api: SessionUnreadApi;
  private readonly onChange: (machineId: string) => void;
  private readonly onBackgroundError: (operation: "snapshot" | "acknowledge", machineId: string, error: unknown) => void;
  private readonly machines = new Map<string, MachineUnreadState>();

  constructor(options: SessionUnreadControllerOptions = {}) {
    this.api = options.api ?? defaultApi;
    this.onChange = options.onChange ?? (() => undefined);
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
  }

  /** Remove projections and invalidate pending responses for deleted machines. */
  retainMachines(machineIds: ReadonlySet<string>): void {
    for (const [machineId, state] of this.machines) {
      if (machineIds.has(machineId)) continue;
      const changed = state.projection !== undefined;
      state.generation += 1;
      state.observers.clear();
      state.acknowledgements.clear();
      this.machines.delete(machineId);
      if (changed) this.onChange(machineId);
    }
  }

  /** Returns true when capability discovery newly makes a snapshot eligible. */
  setCapability(machineId: string, capability: SessionUnreadCapabilityState): boolean {
    const state = this.machine(machineId);
    const previous = state.capability;
    if (previous === capability) return false;

    state.capability = capability;
    if (capability === "unsupported") {
      const changed = state.projection !== undefined;
      state.generation += 1;
      state.projection = undefined;
      if (changed) state.projectionVersion += 1;
      state.status = "stale";
      state.refreshPromise = undefined;
      state.refreshQueued = false;
      state.observers.clear();
      state.acknowledgements.clear();
      if (changed) this.onChange(machineId);
      return false;
    }

    if (capability === "unknown") {
      if (state.projection !== undefined && state.status !== "stale") {
        state.status = "stale";
        this.onChange(machineId);
      }
      return false;
    }

    return previous !== "supported";
  }

  capability(machineId: string): SessionUnreadCapabilityState {
    return this.machines.get(machineId)?.capability ?? "unknown";
  }

  projection(machineId: string): SessionUnreadProjectionView | undefined {
    const state = this.machines.get(machineId);
    const projection = state?.projection;
    if (state === undefined || projection === undefined) return undefined;
    return {
      status: state.status,
      catalogId: projection.catalogId,
      catalogRevision: projection.catalogRevision,
      sessions: [...projection.summariesByIdentity.values()]
        .sort((left, right) => right.completionOrder - left.completionOrder)
        .map((summary) => ({ ...summary })),
    };
  }

  unreadSessionIds(machineId: string, sessions: readonly SessionRef[]): ReadonlySet<string> {
    const projection = this.machines.get(machineId)?.projection;
    if (projection === undefined || sessions.length === 0) return EMPTY_SESSION_IDS;
    const unread = new Set<string>();
    for (const session of sessions) {
      if (projection.summariesByIdentity.has(sessionIdentityKey(session))) unread.add(session.id);
    }
    return unread.size === 0 ? EMPTY_SESSION_IDS : unread;
  }

  isUnread(machineId: string, session: SessionRef): boolean {
    return this.machines.get(machineId)?.projection?.summariesByIdentity.has(sessionIdentityKey(session)) === true;
  }

  applyEvent(machineId: string, event: SessionUnreadEvent): void {
    const state = this.machine(machineId);
    // Events alone do not prove that the web/API hop exposes the matching HTTP
    // routes (for example, a new sessiond behind an older federated web host).
    // Only jointly negotiated support may activate this projection.
    if (state.capability !== "supported") return;
    this.recordObservedEvent(state, event);

    const transition = applyUnreadEvent(state.projection, state.status, event);
    const changed = this.installProjection(state, transition.projection, transition.status);
    if (changed) this.onChange(machineId);
    if (transition.requiresRefresh) {
      if (state.refreshPromise === undefined) void this.refresh(machineId);
      else state.refreshQueued = true;
    }
  }

  refresh(machineId: string): Promise<void> {
    const state = this.machine(machineId);
    if (state.capability !== "supported") return Promise.resolve();
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
      const refreshAgain = state.refreshQueued && state.capability === "supported";
      state.refreshQueued = false;
      if (refreshAgain) void this.refresh(state.machineId);
    });
    return refreshPromise;
  }

  async refreshAll(): Promise<void> {
    await Promise.all([...this.machines.values()]
      .filter((state) => state.capability === "supported")
      .map(async (state) => { await this.refresh(state.machineId); }));
  }

  acknowledge(machineId: string, session: SessionRef): Promise<void> {
    const state = this.machines.get(machineId);
    const projection = state?.projection;
    if (state?.capability !== "supported" || projection === undefined) return Promise.resolve();
    const summary = projection.summariesByIdentity.get(sessionIdentityKey(session));
    if (summary === undefined) return Promise.resolve();

    const key = acknowledgementKey(projection.catalogId, summary);
    const pending = state.acknowledgements.get(key);
    if (pending !== undefined) return pending;

    const generation = state.generation;
    const acknowledgement = this.runAcknowledgement(state, generation, session, projection.catalogId, summary.completionOrder);
    state.acknowledgements.set(key, acknowledgement);
    void acknowledgement.finally(() => {
      if (state.acknowledgements.get(key) === acknowledgement) state.acknowledgements.delete(key);
    });
    return acknowledgement;
  }

  private async runRefreshLoop(state: MachineUnreadState, generation: number): Promise<void> {
    do {
      state.refreshQueued = false;
      if (!this.isCurrentSupported(state, generation)) return;
      const projectionStatus = state.status;
      const changed = this.markRefreshStarted(state);
      if (changed) this.onChange(state.machineId);

      const observer = this.beginNetworkObservation(state, generation, projectionStatus);
      try {
        const snapshot = await this.api.unreadCatalog(state.machineId);
        if (!this.isCurrentSupported(state, generation)) return;
        const requiresRefresh = this.applyNetworkSnapshot(state, snapshot, observer);
        if (requiresRefresh) state.refreshQueued = true;
      } catch (error: unknown) {
        if (this.isCurrent(state, generation)) {
          const becameStale = state.status !== "stale";
          state.status = "stale";
          if (becameStale) this.onChange(state.machineId);
          this.reportError("snapshot", state.machineId, error);
        }
      } finally {
        state.observers.delete(observer);
      }
    } while (state.refreshQueued && this.isCurrentSupported(state, generation));
  }

  private async runAcknowledgement(
    state: MachineUnreadState,
    generation: number,
    session: SessionRef,
    catalogId: string,
    throughCompletionOrder: number,
  ): Promise<void> {
    const observer = this.beginNetworkObservation(state, generation);
    try {
      const snapshot = await this.api.acknowledgeUnread(
        session,
        catalogId,
        throughCompletionOrder,
        state.machineId,
      );
      if (!this.isCurrentSupported(state, generation)) return;
      if (this.applyNetworkSnapshot(state, snapshot, observer)) void this.refresh(state.machineId);
    } catch (error: unknown) {
      if (this.isCurrent(state, generation)) this.reportError("acknowledge", state.machineId, error);
    } finally {
      state.observers.delete(observer);
    }
  }

  private applyNetworkSnapshot(
    state: MachineUnreadState,
    snapshot: SessionUnreadCatalogSnapshot,
    observer: NetworkObserver,
  ): boolean {
    const current = state.projection;
    const ambiguousConcurrentEpoch = state.projectionVersion !== observer.projectionVersion
      && current !== undefined
      && current.catalogId !== snapshot.catalogId;
    if (ambiguousConcurrentEpoch
      || observer.overflowed
      || observer.events.some((event) => event.catalogId !== snapshot.catalogId)) {
      const changed = state.status !== "stale";
      state.status = "stale";
      if (changed) this.onChange(state.machineId);
      return true;
    }

    let candidate = projectionFromSnapshot(snapshot);
    let candidateStatus: SessionUnreadProjectionStatus = "fresh";
    let requiresRefresh = false;
    for (const event of observer.events) {
      const transition = applyUnreadEvent(candidate, candidateStatus, event);
      candidate = transition.projection;
      candidateStatus = transition.status;
      requiresRefresh ||= transition.requiresRefresh;
    }

    if (current?.catalogId === candidate.catalogId
      && current.catalogRevision > candidate.catalogRevision) {
      if (state.projectionVersion === observer.projectionVersion && observer.projectionStatus === "fresh") {
        const changed = state.status !== "fresh";
        state.status = "fresh";
        if (changed) this.onChange(state.machineId);
      }
      requiresRefresh ||= state.status === "stale";
    } else {
      const changed = this.installProjection(state, candidate, candidateStatus);
      if (changed) this.onChange(state.machineId);
    }
    return requiresRefresh;
  }

  private beginNetworkObservation(
    state: MachineUnreadState,
    generation: number,
    projectionStatus = state.status,
  ): NetworkObserver {
    const observer: NetworkObserver = {
      generation,
      projectionVersion: state.projectionVersion,
      projectionStatus,
      events: [],
      overflowed: false,
    };
    state.observers.add(observer);
    return observer;
  }

  private recordObservedEvent(state: MachineUnreadState, event: SessionUnreadEvent): void {
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

  private markRefreshStarted(state: MachineUnreadState): boolean {
    const status: SessionUnreadProjectionStatus = state.projection === undefined ? "loading" : "stale";
    if (state.status === status) return false;
    state.status = status;
    return true;
  }

  private installProjection(
    state: MachineUnreadState,
    projection: ProjectionData,
    status: SessionUnreadProjectionStatus,
  ): boolean {
    const projectionChanged = !projectionsEqual(state.projection, projection);
    if (state.status === status && !projectionChanged) return false;
    if (projectionChanged) {
      state.projection = projection;
      state.projectionVersion += 1;
    }
    state.status = status;
    return true;
  }

  private machine(machineId: string): MachineUnreadState {
    const existing = this.machines.get(machineId);
    if (existing !== undefined) return existing;
    const state: MachineUnreadState = {
      machineId,
      capability: "unknown",
      status: "stale",
      projection: undefined,
      projectionVersion: 0,
      generation: 0,
      observers: new Set(),
      acknowledgements: new Map(),
      refreshPromise: undefined,
      refreshQueued: false,
    };
    this.machines.set(machineId, state);
    return state;
  }

  private isCurrent(state: MachineUnreadState, generation: number): boolean {
    return this.machines.get(state.machineId) === state && state.generation === generation;
  }

  private isCurrentSupported(state: MachineUnreadState, generation: number): boolean {
    return this.isCurrent(state, generation) && state.capability === "supported";
  }

  private reportError(operation: "snapshot" | "acknowledge", machineId: string, error: unknown): void {
    this.onBackgroundError(operation, machineId, error);
  }
}

function applyUnreadEvent(
  projection: ProjectionData | undefined,
  status: SessionUnreadProjectionStatus,
  event: SessionUnreadEvent,
): ProjectionTransition {
  if (projection === undefined) {
    const empty = emptyProjection(event.catalogId);
    if (event.catalogRevision !== 1) return { projection: empty, status: "stale", requiresRefresh: true };
    return applyContiguousEvent(empty, "fresh", event);
  }
  if (projection.catalogId !== event.catalogId) {
    const empty = emptyProjection(event.catalogId);
    if (event.catalogRevision !== 1) return { projection: empty, status: "stale", requiresRefresh: true };
    return applyContiguousEvent(empty, "stale", event);
  }

  if (event.catalogRevision <= projection.catalogRevision) {
    return { projection, status, requiresRefresh: status === "stale" };
  }
  if (event.catalogRevision !== projection.catalogRevision + 1) {
    return { projection, status: "stale", requiresRefresh: true };
  }
  return applyContiguousEvent(projection, status, event);
}

function applyContiguousEvent(
  projection: ProjectionData,
  status: SessionUnreadProjectionStatus,
  event: SessionUnreadEvent,
): ProjectionTransition {
  const summariesByIdentity = new Map(projection.summariesByIdentity);
  const key = sessionIdentityKey(event);
  if (event.unread === null) summariesByIdentity.delete(key);
  else summariesByIdentity.set(key, { ...event.unread });
  const nextStatus: SessionUnreadProjectionStatus = status === "stale" ? "stale" : "fresh";
  return {
    projection: {
      catalogId: event.catalogId,
      catalogRevision: event.catalogRevision,
      summariesByIdentity,
    },
    status: nextStatus,
    requiresRefresh: nextStatus === "stale",
  };
}

function projectionFromSnapshot(snapshot: SessionUnreadCatalogSnapshot): ProjectionData {
  return {
    catalogId: snapshot.catalogId,
    catalogRevision: snapshot.catalogRevision,
    summariesByIdentity: new Map(snapshot.sessions.map((summary) => [sessionIdentityKey(summary), { ...summary }])),
  };
}

function emptyProjection(catalogId: string): ProjectionData {
  return { catalogId, catalogRevision: 0, summariesByIdentity: new Map() };
}

function projectionsEqual(left: ProjectionData | undefined, right: ProjectionData): boolean {
  if (left?.catalogId !== right.catalogId || left.catalogRevision !== right.catalogRevision) return false;
  if (left.summariesByIdentity.size !== right.summariesByIdentity.size) return false;
  for (const [key, summary] of left.summariesByIdentity) {
    const candidate = right.summariesByIdentity.get(key);
    if (candidate?.completionOrder !== summary.completionOrder
      || candidate.completedAt !== summary.completedAt) return false;
  }
  return true;
}

function sessionIdentityKey(session: Pick<SessionRef, "id" | "cwd"> | Pick<SessionUnreadSummary, "sessionId" | "cwd"> | Pick<SessionUnreadEvent, "sessionId" | "cwd">): string {
  const sessionId = "id" in session ? session.id : session.sessionId;
  return JSON.stringify([sessionId, session.cwd]);
}

function acknowledgementKey(catalogId: string, summary: SessionUnreadSummary): string {
  return JSON.stringify([catalogId, summary.sessionId, summary.cwd, summary.completionOrder]);
}
