import { api as defaultApi, type Machine, type SessionInfo } from "../api";
import type { AppState } from "../appState";
import {
  applyNotificationCatalogEvent,
  applySelectedNotificationEvent,
  freshNotificationCatalog,
  installSelectedNotificationSnapshot,
  loadingSelectedNotificationInbox,
  notificationSummaryIsEmpty,
  notificationTargetsEqual,
  selectedNotificationView,
  type SelectedSessionNotificationInbox,
  type SessionNotificationCatalogProjection,
  type SessionNotificationTarget,
} from "../sessionNotifications";
import { PI_WEB_CAPABILITIES, supportsPiWebCapability } from "../../../shared/capabilities";
import type {
  SessionNotificationInboxEvent,
  SessionNotificationInboxSnapshot,
  SessionNotificationSummaryEvent,
  SessionRef,
} from "../../../shared/apiTypes";
import { selectedMachineId, type GetState, type SetState } from "./types";

const WORKSPACE_HYDRATION_CONCURRENCY = 3;

export interface SessionNotificationApi {
  notificationCatalog: typeof defaultApi.notificationCatalog;
  notificationInbox: typeof defaultApi.notificationInbox;
  dismissNotification: typeof defaultApi.dismissNotification;
  dismissAllNotifications: typeof defaultApi.dismissAllNotifications;
  workspaces: typeof defaultApi.workspaces;
}

export interface SessionNotificationControllerDependencies {
  api?: SessionNotificationApi;
  onBackgroundError?: (message: string, error: unknown) => void;
}

interface CatalogJoin {
  events: SessionNotificationSummaryEvent[];
}

interface CatalogRefreshOperation {
  promise: Promise<void>;
  trailing: boolean;
}

interface SelectedJoin {
  generation: number;
  events: SessionNotificationInboxEvent[];
}

interface SelectedRefreshOperation {
  generation: number;
  promise: Promise<void>;
  trailing: boolean;
}

/**
 * Owns browser projections of daemon notification state.
 *
 * Network and socket inputs enter through explicit methods; all transcript state
 * remains owned by SessionController/ChatTranscriptStore and is never touched.
 */
export class SessionNotificationController {
  private readonly api: SessionNotificationApi;
  private readonly onBackgroundError: (message: string, error: unknown) => void;
  private readonly acceptedSupportByMachine = new Set<string>();
  private readonly catalogJoins = new Map<string, CatalogJoin>();
  private readonly catalogRefreshes = new Map<string, CatalogRefreshOperation>();
  private selectedTarget: SessionNotificationTarget | undefined;
  private selectedGeneration = 0;
  private selectedJoin: SelectedJoin | undefined;
  private selectedRefresh: SelectedRefreshOperation | undefined;
  private readonly dismissingNotificationIds = new Set<string>();
  private dismissAllPending = false;
  private workspaceHydrationKey = "";
  private readonly workspaceHydrationsInFlight = new Set<string>();
  private disposed = false;

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    dependencies: SessionNotificationControllerDependencies = {},
  ) {
    this.api = dependencies.api ?? defaultApi;
    this.onBackgroundError = dependencies.onBackgroundError ?? ((message, error) => { console.warn(message, error); });
  }

  dispose(): void {
    this.disposed = true;
    this.selectedGeneration += 1;
    this.selectedTarget = undefined;
    this.selectedJoin = undefined;
    this.catalogJoins.clear();
    this.catalogRefreshes.clear();
    this.dismissingNotificationIds.clear();
    this.dismissAllPending = false;
    this.workspaceHydrationsInFlight.clear();
  }

  prepareSelectedSession(session: SessionInfo, machineId: string): void {
    this.selectedGeneration += 1;
    this.selectedTarget = session.archived === true ? undefined : { machineId, sessionId: session.id, cwd: session.cwd };
    this.selectedJoin = undefined;
    this.dismissingNotificationIds.clear();
    this.dismissAllPending = false;
    if (this.selectedTarget === undefined || !this.machineSupportsNotifications(machineId)) {
      this.setState({ selectedNotificationInbox: undefined });
      return;
    }
    this.setState({ selectedNotificationInbox: loadingSelectedNotificationInbox(this.selectedTarget) });
  }

  clearSelectedSession(): void {
    this.selectedGeneration += 1;
    this.selectedTarget = undefined;
    this.selectedJoin = undefined;
    this.dismissingNotificationIds.clear();
    this.dismissAllPending = false;
    this.setState({ selectedNotificationInbox: undefined });
  }

  refreshSelectedSession(session: SessionRef, machineId: string): Promise<void> {
    const target = this.selectedTarget;
    if (target?.machineId !== machineId || target.sessionId !== session.id || target.cwd !== session.cwd) return Promise.resolve();
    if (!this.machineSupportsNotifications(machineId) || !this.machineIsReachable(machineId)) return Promise.resolve();
    const generation = this.selectedGeneration;
    const existing = this.selectedRefresh;
    if (existing?.generation === generation) {
      existing.trailing = true;
      return existing.promise;
    }

    this.ensureSelectedProjection(target);
    const operation: SelectedRefreshOperation = { generation, promise: Promise.resolve(), trailing: false };
    operation.promise = this.runSelectedRefresh(operation, target).finally(() => {
      if (this.selectedRefresh === operation) this.selectedRefresh = undefined;
    });
    this.selectedRefresh = operation;
    return operation.promise;
  }

  applyInboxEvent(machineId: string, event: SessionNotificationInboxEvent): void {
    this.acceptedSupportByMachine.add(machineId);
    const target = this.selectedTarget;
    if (target?.machineId !== machineId || target.sessionId !== event.summary.sessionId || target.cwd !== event.summary.cwd) {
      this.applyCatalogSummary(machineId, inboxSummaryEvent(event));
      return;
    }
    const join = this.selectedJoin;
    if (join?.generation === this.selectedGeneration) {
      join.events.push(event);
      return;
    }
    const result = applySelectedNotificationEvent(this.getState().selectedNotificationInbox, target, event);
    if (result.changed) this.setState({ selectedNotificationInbox: result.value });
    this.applyCatalogSummary(machineId, inboxSummaryEvent(event));
    if (result.needsRefresh) this.scheduleSelectedRefresh(target);
  }

  applySummaryEvent(machineId: string, event: SessionNotificationSummaryEvent): void {
    this.acceptedSupportByMachine.add(machineId);
    const join = this.catalogJoins.get(machineId);
    if (join !== undefined) {
      join.events.push(event);
      return;
    }
    // The matching per-session event carries the notification text and must win
    // the live-announcement race. Initial-open and reconnect snapshots still
    // reconcile selected state through the catalog join.
    this.applyCatalogSummary(machineId, event, false);
    this.ensureSelectedSupport(machineId);
  }

  globalSocketOpened(machineId: string): void {
    if (machineId === selectedMachineId(this.getState())) this.workspaceHydrationKey = "";
    if (this.machineSupportsNotifications(machineId) && this.machineIsReachable(machineId)) void this.refreshCatalog(machineId);
  }

  async refreshAfterBrowserResume(): Promise<void> {
    this.workspaceHydrationKey = "";
    const machineIds = this.notificationMachineIds().filter((machineId) => this.machineSupportsNotifications(machineId) && this.machineIsReachable(machineId));
    await Promise.all(machineIds.map((machineId) => this.refreshCatalog(machineId)));
  }

  syncEnvironment(previous: AppState, next: AppState): void {
    if (this.disposed) return;
    if (previous.machines !== next.machines) this.pruneRemovedMachines(next.machines);

    const environmentChanged = previous.machines !== next.machines
      || previous.machineStatuses !== next.machineStatuses
      || previous.machineRuntimes !== next.machineRuntimes;
    if (environmentChanged) {
      for (const machineId of this.notificationMachineIds()) {
        const wasEligible = this.machineSupportsNotificationsInState(previous, machineId) && this.machineIsReachableInState(previous, machineId);
        const isEligible = this.machineSupportsNotificationsInState(next, machineId) && this.machineIsReachableInState(next, machineId);
        if (!isEligible) this.markCatalogStale(machineId);
        else if (!wasEligible || next.notificationCatalogsByMachine[machineId]?.status !== "fresh") void this.refreshCatalog(machineId);
      }
      const selected = this.selectedTarget;
      if (selected !== undefined) {
        if (!this.machineSupportsNotifications(selected.machineId) || !this.machineIsReachable(selected.machineId)) {
          this.markSelectedStale(selected);
        } else {
          this.ensureSelectedProjection(selected);
          if (!this.machineSupportsNotificationsInState(previous, selected.machineId) || next.selectedNotificationInbox?.status !== "fresh") {
            void this.refreshSelectedSession({ id: selected.sessionId, cwd: selected.cwd }, selected.machineId);
          }
        }
      }
    }

    if (environmentChanged
      || previous.projects !== next.projects
      || previous.workspacesByProjectId !== next.workspacesByProjectId
      || previous.selectedMachine !== next.selectedMachine
      || previous.notificationCatalogsByMachine !== next.notificationCatalogsByMachine) {
      this.scheduleWorkspaceHydration();
    }
  }

  shouldFilterLegacyNotification(machineId: string, notificationId: string | undefined): boolean {
    return notificationId !== undefined && notificationId !== "" && this.machineSupportsNotifications(machineId);
  }

  async dismissNotification(notificationId: string): Promise<void> {
    const inbox = this.getState().selectedNotificationInbox;
    const view = selectedNotificationView(inbox);
    if (inbox === undefined || view === undefined || this.dismissAllPending || this.dismissingNotificationIds.has(notificationId)) return;
    if (!view.notifications.some((notification) => notification.id === notificationId)) return;
    const target = targetFromInbox(inbox);
    const generation = this.selectedGeneration;
    this.dismissingNotificationIds.add(notificationId);
    this.patchSelectedOverlay(target, (current) => ({
      ...current,
      optimisticDismissedIds: [...new Set([...current.optimisticDismissedIds, notificationId])],
    }));
    try {
      const snapshot = await this.api.dismissNotification({ id: target.sessionId, cwd: target.cwd }, view.daemonInstanceId, notificationId, target.machineId);
      if (this.isCurrentTarget(target, generation)) this.applyMutationSnapshot(target, snapshot, (current) => ({
        ...current,
        optimisticDismissedIds: current.optimisticDismissedIds.filter((id) => id !== notificationId),
      }));
    } catch (error) {
      if (this.isCurrentTarget(target, generation)) {
        this.patchSelectedOverlay(target, (current) => ({
          ...current,
          optimisticDismissedIds: current.optimisticDismissedIds.filter((id) => id !== notificationId),
        }));
        this.setState({ error: `Failed to dismiss notification: ${errorMessage(error)}` });
        await this.refreshSelectedSession({ id: target.sessionId, cwd: target.cwd }, target.machineId);
      }
    } finally {
      this.dismissingNotificationIds.delete(notificationId);
    }
  }

  async dismissAll(): Promise<void> {
    const inbox = this.getState().selectedNotificationInbox;
    const view = selectedNotificationView(inbox);
    if (inbox === undefined || view === undefined || this.dismissAllPending || view.retainedCount + view.discardedCount === 0) return;
    const target = targetFromInbox(inbox);
    const generation = this.selectedGeneration;
    const through = { ...inbox.dismissThrough };
    this.dismissAllPending = true;
    this.patchSelectedOverlay(target, (current) => ({ ...current, optimisticDismissAllThrough: through }));
    try {
      const snapshot = await this.api.dismissAllNotifications({ id: target.sessionId, cwd: target.cwd }, view.daemonInstanceId, through, target.machineId);
      if (this.isCurrentTarget(target, generation)) this.applyMutationSnapshot(target, snapshot, (current) => {
        const next = { ...current };
        delete next.optimisticDismissAllThrough;
        return next;
      });
    } catch (error) {
      if (this.isCurrentTarget(target, generation)) {
        this.patchSelectedOverlay(target, (current) => {
          const next = { ...current };
          delete next.optimisticDismissAllThrough;
          return next;
        });
        this.setState({ error: `Failed to dismiss session notifications: ${errorMessage(error)}` });
        await this.refreshSelectedSession({ id: target.sessionId, cwd: target.cwd }, target.machineId);
      }
    } finally {
      if (generation === this.selectedGeneration) this.dismissAllPending = false;
    }
  }

  private async runSelectedRefresh(operation: SelectedRefreshOperation, target: SessionNotificationTarget): Promise<void> {
    do {
      operation.trailing = false;
      const join: SelectedJoin = { generation: operation.generation, events: [] };
      this.selectedJoin = join;
      try {
        const snapshot = await this.api.notificationInbox({ id: target.sessionId, cwd: target.cwd }, target.machineId);
        if (!this.isCurrentTarget(target, operation.generation)) return;
        if (!this.machineSupportsNotifications(target.machineId) || !this.machineIsReachable(target.machineId)) {
          this.markSelectedStale(target);
          return;
        }
        this.acceptedSupportByMachine.add(target.machineId);
        const current = this.getState().selectedNotificationInbox;
        let inbox = current === undefined || shouldInstallSelectedSnapshot(current, target, snapshot)
          ? installSelectedNotificationSnapshot(current, target, snapshot)
          : current;
        const catalogEvents = [snapshotSummaryEvent(snapshot)];
        for (const event of [...join.events].sort((left, right) => left.summary.inboxRevision - right.summary.inboxRevision)) {
          const result = applySelectedNotificationEvent(inbox, target, event);
          inbox = result.value;
          catalogEvents.push(inboxSummaryEvent(event));
          if (result.needsRefresh) operation.trailing = true;
        }
        this.setState({ selectedNotificationInbox: inbox });
        for (const event of catalogEvents) this.applyCatalogSummary(target.machineId, event);
      } catch (error) {
        if (this.isCurrentTarget(target, operation.generation)) {
          const current = this.getState().selectedNotificationInbox;
          if (current !== undefined && notificationTargetsEqual(current, target) && current.status !== "stale") this.setState({ selectedNotificationInbox: { ...current, status: "stale" } });
          this.onBackgroundError(`Failed to refresh notifications for session ${target.sessionId}`, error);
        }
        return;
      } finally {
        if (this.selectedJoin === join) this.selectedJoin = undefined;
      }
    } while (operation.trailing && this.isCurrentTarget(target, operation.generation) && this.machineIsReachable(target.machineId));
  }

  private refreshCatalog(machineId: string): Promise<void> {
    if (this.disposed || !this.machineIsKnown(machineId) || !this.machineSupportsNotifications(machineId) || !this.machineIsReachable(machineId)) return Promise.resolve();
    const existing = this.catalogRefreshes.get(machineId);
    if (existing !== undefined) {
      existing.trailing = true;
      return existing.promise;
    }
    const operation: CatalogRefreshOperation = { promise: Promise.resolve(), trailing: false };
    operation.promise = this.runCatalogRefresh(machineId, operation).finally(() => {
      if (this.catalogRefreshes.get(machineId) === operation) this.catalogRefreshes.delete(machineId);
    });
    this.catalogRefreshes.set(machineId, operation);
    return operation.promise;
  }

  private async runCatalogRefresh(machineId: string, operation: CatalogRefreshOperation): Promise<void> {
    do {
      operation.trailing = false;
      const join: CatalogJoin = { events: [] };
      this.catalogJoins.set(machineId, join);
      try {
        const snapshot = await this.api.notificationCatalog(machineId);
        if (this.disposed || !this.machineIsKnown(machineId) || !this.machineIsReachable(machineId)) return;
        this.acceptedSupportByMachine.add(machineId);
        let projection = freshNotificationCatalog(machineId, snapshot);
        for (const event of [...join.events].sort((left, right) => left.catalogRevision - right.catalogRevision)) {
          const result = applyNotificationCatalogEvent(projection, machineId, event);
          projection = result.value;
          if (result.needsRefresh) operation.trailing = true;
        }
        this.setCatalog(machineId, projection);
      } catch (error) {
        if (this.disposed) return;
        this.markCatalogStale(machineId);
        this.onBackgroundError(`Failed to refresh notification catalog for machine ${machineId}`, error);
        return;
      } finally {
        if (this.catalogJoins.get(machineId) === join) this.catalogJoins.delete(machineId);
      }
    } while (operation.trailing && this.machineIsKnown(machineId) && this.machineIsReachable(machineId));
  }

  private applyCatalogSummary(machineId: string, event: SessionNotificationSummaryEvent, reconcileSelected = true): void {
    const join = this.catalogJoins.get(machineId);
    if (join !== undefined) {
      join.events.push(event);
      return;
    }
    const current = this.getState().notificationCatalogsByMachine[machineId];
    const result = applyNotificationCatalogEvent(current, machineId, event);
    if (result.changed) this.setCatalog(machineId, result.value, reconcileSelected);
    if (result.needsRefresh) this.scheduleCatalogRefresh(machineId);
  }

  private applyMutationSnapshot(
    target: SessionNotificationTarget,
    snapshot: SessionNotificationInboxSnapshot,
    removeOverlay: (inbox: SelectedSessionNotificationInbox) => SelectedSessionNotificationInbox,
  ): void {
    const current = this.getState().selectedNotificationInbox;
    if (current === undefined || !notificationTargetsEqual(current, target)) return;
    if (!this.machineSupportsNotifications(target.machineId) || !this.machineIsReachable(target.machineId)) {
      this.setState({ selectedNotificationInbox: { ...removeOverlay(current), status: "stale" } });
      return;
    }
    const authoritative = shouldInstallSelectedSnapshot(current, target, snapshot)
      ? installSelectedNotificationSnapshot(current, target, snapshot)
      : current;
    this.setState({ selectedNotificationInbox: removeOverlay(authoritative) });
    this.applyCatalogSummary(target.machineId, snapshotSummaryEvent(snapshot));
  }

  private patchSelectedOverlay(
    target: SessionNotificationTarget,
    update: (inbox: SelectedSessionNotificationInbox) => SelectedSessionNotificationInbox,
  ): void {
    const current = this.getState().selectedNotificationInbox;
    if (current === undefined || !notificationTargetsEqual(current, target)) return;
    this.setState({ selectedNotificationInbox: update(current) });
  }

  private ensureSelectedSupport(machineId: string): void {
    const target = this.selectedTarget;
    if (target?.machineId !== machineId) return;
    const current = this.getState().selectedNotificationInbox;
    if (current !== undefined && notificationTargetsEqual(current, target) && current.status === "fresh") return;
    this.ensureSelectedProjection(target);
    void this.refreshSelectedSession({ id: target.sessionId, cwd: target.cwd }, machineId);
  }

  private ensureSelectedProjection(target: SessionNotificationTarget): void {
    const current = this.getState().selectedNotificationInbox;
    if (current === undefined || !notificationTargetsEqual(current, target)) this.setState({ selectedNotificationInbox: loadingSelectedNotificationInbox(target) });
  }

  private scheduleSelectedRefresh(target: SessionNotificationTarget): void {
    queueMicrotask(() => {
      if (!this.disposed && this.selectedTarget !== undefined && notificationTargetsEqual(this.selectedTarget, target)) {
        void this.refreshSelectedSession({ id: target.sessionId, cwd: target.cwd }, target.machineId);
      }
    });
  }

  private scheduleCatalogRefresh(machineId: string): void {
    queueMicrotask(() => {
      if (!this.disposed) void this.refreshCatalog(machineId);
    });
  }

  private setCatalog(machineId: string, projection: SessionNotificationCatalogProjection, reconcileSelected = true): void {
    const current = this.getState().notificationCatalogsByMachine;
    if (current[machineId] === projection) return;
    this.setState({ notificationCatalogsByMachine: { ...current, [machineId]: projection } });
    if (reconcileSelected) this.reconcileSelectedWithCatalog(projection);
  }

  private reconcileSelectedWithCatalog(catalog: SessionNotificationCatalogProjection): void {
    if (catalog.status !== "fresh" || catalog.daemonInstanceId === undefined) return;
    const target = this.selectedTarget;
    if (target?.machineId !== catalog.machineId || !this.machineIsReachable(target.machineId)) return;
    const inbox = this.getState().selectedNotificationInbox;
    if (inbox === undefined || !notificationTargetsEqual(inbox, target) || inbox.status !== "fresh" || inbox.daemonInstanceId === undefined || inbox.summary === undefined) {
      this.scheduleSelectedRefresh(target);
      return;
    }
    if (inbox.daemonInstanceId !== catalog.daemonInstanceId) {
      this.scheduleSelectedRefresh(target);
      return;
    }
    const catalogSummary = catalog.summariesBySessionId[target.sessionId];
    if (catalogSummary === undefined) {
      if (!notificationSummaryIsEmpty(inbox.summary)) this.scheduleSelectedRefresh(target);
      return;
    }
    if (catalogSummary.cwd !== target.cwd
      || catalogSummary.inboxRevision > inbox.summary.inboxRevision
      || (catalogSummary.inboxRevision === inbox.summary.inboxRevision && !notificationSummariesEqual(catalogSummary, inbox.summary))) {
      this.scheduleSelectedRefresh(target);
    }
  }

  private markCatalogStale(machineId: string): void {
    const current = this.getState().notificationCatalogsByMachine[machineId];
    if (current === undefined || current.status === "stale") return;
    this.setCatalog(machineId, { ...current, status: "stale" });
  }

  private markSelectedStale(target: SessionNotificationTarget): void {
    const current = this.getState().selectedNotificationInbox;
    if (current === undefined || !notificationTargetsEqual(current, target) || current.status === "stale") return;
    this.setState({ selectedNotificationInbox: { ...current, status: "stale" } });
  }

  private pruneRemovedMachines(machines: readonly Machine[]): void {
    const machineIds = new Set(machines.map((machine) => machine.id));
    if (machineIds.size === 0) machineIds.add("local");
    const catalogs = Object.fromEntries(Object.entries(this.getState().notificationCatalogsByMachine).filter(([machineId]) => machineIds.has(machineId)));
    if (Object.keys(catalogs).length !== Object.keys(this.getState().notificationCatalogsByMachine).length) this.setState({ notificationCatalogsByMachine: catalogs });
    for (const machineId of [...this.acceptedSupportByMachine]) if (!machineIds.has(machineId)) this.acceptedSupportByMachine.delete(machineId);
  }

  private scheduleWorkspaceHydration(): void {
    const state = this.getState();
    const machineId = selectedMachineId(state);
    const catalog = state.notificationCatalogsByMachine[machineId];
    if (catalog?.status !== "fresh" || Object.keys(catalog.summariesBySessionId).length === 0 || state.projects.length === 0) return;
    const missingProjectIds = state.projects
      .map((project) => project.id)
      .filter((projectId) => !Object.hasOwn(state.workspacesByProjectId, projectId))
      .filter((projectId) => !this.workspaceHydrationsInFlight.has(workspaceHydrationId(machineId, projectId)));
    if (missingProjectIds.length === 0) return;
    const key = JSON.stringify([machineId, catalog.daemonInstanceId, missingProjectIds]);
    if (key === this.workspaceHydrationKey) return;
    this.workspaceHydrationKey = key;
    void this.hydrateProjectWorkspaces(machineId, missingProjectIds);
  }

  private async hydrateProjectWorkspaces(machineId: string, projectIds: readonly string[]): Promise<void> {
    for (const projectId of projectIds) this.workspaceHydrationsInFlight.add(workspaceHydrationId(machineId, projectId));
    await forEachWithConcurrency(projectIds, WORKSPACE_HYDRATION_CONCURRENCY, async (projectId) => {
      try {
        const workspaces = await this.api.workspaces(projectId, machineId);
        const state = this.getState();
        if (this.disposed || selectedMachineId(state) !== machineId || !state.projects.some((project) => project.id === projectId)) return;
        this.setState({ workspacesByProjectId: { ...state.workspacesByProjectId, [projectId]: workspaces } });
      } catch (error) {
        this.onBackgroundError(`Failed to index workspaces for notification badges on machine ${machineId}`, error);
      } finally {
        this.workspaceHydrationsInFlight.delete(workspaceHydrationId(machineId, projectId));
      }
    });
  }

  private isCurrentTarget(target: SessionNotificationTarget, generation: number): boolean {
    return !this.disposed
      && generation === this.selectedGeneration
      && this.selectedTarget !== undefined
      && notificationTargetsEqual(this.selectedTarget, target);
  }

  private machineSupportsNotifications(machineId: string): boolean {
    return this.machineSupportsNotificationsInState(this.getState(), machineId);
  }

  private machineSupportsNotificationsInState(state: AppState, machineId: string): boolean {
    return this.acceptedSupportByMachine.has(machineId)
      || (state.machineRuntimes[machineId]?.ok === true && supportsPiWebCapability(state.machineRuntimes[machineId], PI_WEB_CAPABILITIES.sessionsNotifications));
  }

  private machineIsReachable(machineId: string): boolean {
    return this.machineIsReachableInState(this.getState(), machineId);
  }

  private machineIsReachableInState(state: AppState, machineId: string): boolean {
    const machine = state.machines.find((candidate) => candidate.id === machineId);
    if (machineId === "local" || machine?.kind === "local") return true;
    const status = state.machineStatuses[machineId]?.status ?? machine?.status;
    return status === undefined || status === "unknown" || status === "online";
  }

  private machineIsKnown(machineId: string): boolean {
    const machines = this.getState().machines;
    return machines.length === 0 ? machineId === "local" : machines.some((machine) => machine.id === machineId);
  }

  private notificationMachineIds(): string[] {
    const machines = this.getState().machines;
    return machines.length === 0 ? ["local"] : machines.map((machine) => machine.id);
  }
}

function inboxSummaryEvent(event: SessionNotificationInboxEvent): SessionNotificationSummaryEvent {
  return {
    type: "notifications.summary",
    daemonInstanceId: event.daemonInstanceId,
    catalogRevision: event.catalogRevision,
    summary: event.summary,
  };
}

function snapshotSummaryEvent(snapshot: SessionNotificationInboxSnapshot): SessionNotificationSummaryEvent {
  return {
    type: "notifications.summary",
    daemonInstanceId: snapshot.daemonInstanceId,
    catalogRevision: snapshot.catalogRevision,
    summary: snapshot.summary,
  };
}

function targetFromInbox(inbox: SelectedSessionNotificationInbox): SessionNotificationTarget {
  return { machineId: inbox.machineId, sessionId: inbox.sessionId, cwd: inbox.cwd };
}

function shouldInstallSelectedSnapshot(
  current: SelectedSessionNotificationInbox,
  target: SessionNotificationTarget,
  snapshot: SessionNotificationInboxSnapshot,
): boolean {
  return !notificationTargetsEqual(current, target)
    || current.daemonInstanceId !== snapshot.daemonInstanceId
    || current.summary === undefined
    || snapshot.summary.inboxRevision >= current.summary.inboxRevision;
}

async function forEachWithConcurrency<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  async function run(): Promise<void> {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item !== undefined) await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
}

function workspaceHydrationId(machineId: string, projectId: string): string {
  return JSON.stringify([machineId, projectId]);
}

function notificationSummariesEqual(
  left: SessionNotificationInboxSnapshot["summary"],
  right: SessionNotificationInboxSnapshot["summary"],
): boolean {
  return left.sessionId === right.sessionId
    && left.cwd === right.cwd
    && left.inboxRevision === right.inboxRevision
    && left.retainedCount === right.retainedCount
    && left.discardedCount === right.discardedCount
    && left.highestSeverity === right.highestSeverity;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
