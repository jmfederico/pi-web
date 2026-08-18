import { api as defaultApi, type SessionInfo } from "../api";
import type { AppState } from "../appState";
import {
  applySelectedNotificationEvent,
  installSelectedNotificationSnapshot,
  loadingSelectedNotificationInbox,
  notificationTargetsEqual,
  selectedNotificationView,
  type SelectedSessionNotificationInbox,
  type SessionNotificationTarget,
} from "../sessionNotifications";
import type {
  SessionNotificationInboxEvent,
  SessionNotificationInboxSnapshot,
  SessionRef,
} from "../../../shared/apiTypes";
import type { GetState, SetState } from "./types";

export interface SessionNotificationApi {
  notificationInbox: typeof defaultApi.notificationInbox;
  dismissNotification: typeof defaultApi.dismissNotification;
  dismissAllNotifications: typeof defaultApi.dismissAllNotifications;
}

export interface SessionNotificationControllerDependencies {
  api?: SessionNotificationApi;
  onBackgroundError?: (message: string, error: unknown) => void;
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
 * Owns the browser projection of the selected session's notification inbox.
 *
 * Network and socket inputs enter through explicit methods; all transcript state
 * remains owned by SessionController/ChatTranscriptStore and is never touched.
 */
export class SessionNotificationController {
  private readonly api: SessionNotificationApi;
  private readonly onBackgroundError: (message: string, error: unknown) => void;
  private selectedTarget: SessionNotificationTarget | undefined;
  private selectedGeneration = 0;
  private selectedJoin: SelectedJoin | undefined;
  private selectedRefresh: SelectedRefreshOperation | undefined;
  private readonly dismissingNotificationIds = new Set<string>();
  private dismissAllPending = false;
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
    this.dismissingNotificationIds.clear();
    this.dismissAllPending = false;
  }

  prepareSelectedSession(session: SessionInfo, machineId: string): void {
    this.selectedGeneration += 1;
    this.selectedTarget = session.archived === true ? undefined : { machineId, sessionId: session.id, cwd: session.cwd };
    this.selectedJoin = undefined;
    this.dismissingNotificationIds.clear();
    this.dismissAllPending = false;
    if (this.selectedTarget === undefined) {
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
    if (this.disposed || target?.machineId !== machineId || target.sessionId !== session.id || target.cwd !== session.cwd) return Promise.resolve();
    if (!this.machineIsReachable(machineId)) return Promise.resolve();
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
    const target = this.selectedTarget;
    if (target?.machineId !== machineId || target.sessionId !== event.summary.sessionId || target.cwd !== event.summary.cwd) return;
    const join = this.selectedJoin;
    if (join?.generation === this.selectedGeneration) {
      join.events.push(event);
      return;
    }
    const result = applySelectedNotificationEvent(this.getState().selectedNotificationInbox, target, event);
    if (result.changed) this.setState({ selectedNotificationInbox: result.value });
    if (result.needsRefresh) this.scheduleSelectedRefresh(target);
  }

  syncEnvironment(previous: AppState, next: AppState): void {
    if (this.disposed) return;

    const environmentChanged = previous.machines !== next.machines
      || previous.machineStatuses !== next.machineStatuses;
    const selected = this.selectedTarget;
    if (!environmentChanged || selected === undefined) return;

    const wasEligible = this.machineIsReachableInState(previous, selected.machineId);
    if (!this.machineIsReachable(selected.machineId)) {
      this.markSelectedStale(selected);
      return;
    }

    this.ensureSelectedProjection(selected);
    if (!wasEligible || this.getState().selectedNotificationInbox?.status !== "fresh") {
      void this.refreshSelectedSession({ id: selected.sessionId, cwd: selected.cwd }, selected.machineId);
    }
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
        if (!this.machineIsReachable(target.machineId)) {
          this.markSelectedStale(target);
          return;
        }
        const current = this.getState().selectedNotificationInbox;
        let inbox = current === undefined || shouldInstallSelectedSnapshot(current, target, snapshot)
          ? installSelectedNotificationSnapshot(current, target, snapshot)
          : current;
        for (const event of [...join.events].sort((left, right) => left.summary.inboxRevision - right.summary.inboxRevision)) {
          const result = applySelectedNotificationEvent(inbox, target, event);
          inbox = result.value;
          if (result.needsRefresh) operation.trailing = true;
        }
        this.setState({ selectedNotificationInbox: inbox });
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

  private applyMutationSnapshot(
    target: SessionNotificationTarget,
    snapshot: SessionNotificationInboxSnapshot,
    removeOverlay: (inbox: SelectedSessionNotificationInbox) => SelectedSessionNotificationInbox,
  ): void {
    const current = this.getState().selectedNotificationInbox;
    if (current === undefined || !notificationTargetsEqual(current, target)) return;
    if (!this.machineIsReachable(target.machineId)) {
      this.setState({ selectedNotificationInbox: { ...removeOverlay(current), status: "stale" } });
      return;
    }
    const authoritative = shouldInstallSelectedSnapshot(current, target, snapshot)
      ? installSelectedNotificationSnapshot(current, target, snapshot)
      : current;
    this.setState({ selectedNotificationInbox: removeOverlay(authoritative) });
  }

  private patchSelectedOverlay(
    target: SessionNotificationTarget,
    update: (inbox: SelectedSessionNotificationInbox) => SelectedSessionNotificationInbox,
  ): void {
    const current = this.getState().selectedNotificationInbox;
    if (current === undefined || !notificationTargetsEqual(current, target)) return;
    this.setState({ selectedNotificationInbox: update(current) });
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

  private markSelectedStale(target: SessionNotificationTarget): void {
    const current = this.getState().selectedNotificationInbox;
    if (current === undefined || !notificationTargetsEqual(current, target) || current.status === "stale") return;
    this.setState({ selectedNotificationInbox: { ...current, status: "stale" } });
  }

  private isCurrentTarget(target: SessionNotificationTarget, generation: number): boolean {
    return !this.disposed
      && generation === this.selectedGeneration
      && this.selectedTarget !== undefined
      && notificationTargetsEqual(this.selectedTarget, target);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
