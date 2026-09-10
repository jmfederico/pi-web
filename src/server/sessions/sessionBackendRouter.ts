import type {
  AskUserCloseResponse,
  AskUserSubmission,
  ExtensionDialogAnswer,
  ExtensionDialogCloseResponse,
  SavedPromptAttachment,
  SessionBackend,
  SessionBulkArchiveResponse,
  SessionBulkDeleteArchivedResponse,
  SessionBulkFailure,
  SessionBulkMutationRef,
  SessionCleanupProjectSummary,
  SessionNotificationCatalogSnapshot,
  SessionNotificationDismissAllRequest,
  SessionNotificationDismissRequest,
  SessionNotificationInboxSnapshot,
  SessionModelScopeMode,
  SessionUnreadAcknowledgeRequest,
  SessionUnreadCatalogSnapshot,
} from "../../shared/apiTypes.js";
import type {
  ClientArchiveSessionsResponse,
  ClientCommand,
  ClientCommandResult,
  ClientMessagePage,
  ClientSession,
  ClientSessionCleanupExecuteResponse,
  ClientSessionCleanupPreviewResponse,
  ClientSessionModel,
  ClientSessionModelCatalogEntry,
  ClientSessionStatus,
  ClientSessionTreeForkRequest,
  ClientSessionTreeForkResult,
  ClientSessionTreeNavigateRequest,
  ClientSessionTreeNavigateResult,
  ClientThinkingLevel,
  SessionStreamSnapshot,
} from "../types.js";
import type { NormalizedSessionCleanupRequest } from "./sessionCleanup.js";
import type { SessionRouteRef, SessionRouteService } from "./sessionService.js";

const OMP_ID_PREFIX = "omp:";

function isOmpId(id: string): boolean {
  return id.startsWith(OMP_ID_PREFIX);
}

/** What PiSessionService/OmpSessionService both expose beyond the route surface: per-daemon lifecycle hooks. */
export type SessionBackendEngine = SessionRouteService & {
  activeCount(): number;
  dispose(): Promise<void>;
};

export interface SessionBackendRouterOptions {
  pi: SessionBackendEngine;
  /** Omitted when OMP is not configured for this deployment; every omp-targeted operation then rejects instead of falling back to pi. */
  omp?: SessionBackendEngine;
}

export class OmpBackendUnavailableError extends Error {
  constructor(operation: string) {
    super(`OMP backend is not configured; cannot ${operation}`);
    this.name = "OmpBackendUnavailableError";
  }
}

/**
 * Composite `SessionRouteService` that routes per-session operations to the
 * Pi or OMP engine by ref/sessionId "omp:" prefix, and merges the cwd-scoped
 * and global operations that must reflect both engines at once (list,
 * cleanupPreview/cleanup, archiveMany/deleteArchivedMany, unreadCatalog).
 * See sessionBackendRouter.test.ts for the full routing matrix. Every
 * ref-scoped method is `async` (even trivial forwards) so a missing-omp
 * rejection is always a rejected promise, never a synchronous throw, whether
 * or not the caller `await`s before attaching `.catch`.
 */
export class SessionBackendRouter implements SessionRouteService {
  private readonly pi: SessionBackendEngine;
  private readonly omp: SessionBackendEngine | undefined;

  constructor(options: SessionBackendRouterOptions) {
    this.pi = options.pi;
    this.omp = options.omp;
  }

  private engineForId(id: string, operation: string): SessionBackendEngine {
    if (!isOmpId(id)) return this.pi;
    if (this.omp === undefined) throw new OmpBackendUnavailableError(operation);
    return this.omp;
  }

  private engineForRef(ref: SessionRouteRef, operation: string): SessionBackendEngine {
    return this.engineForId(ref.id, operation);
  }

  async list(cwd: string): Promise<ClientSession[]> {
    const [piSessions, ompSessions] = await Promise.all([this.pi.list(cwd), this.omp === undefined ? Promise.resolve([]) : this.omp.list(cwd)]);
    return [...piSessions, ...ompSessions];
  }

  async start(cwd: string, options?: { startupToken?: string; backend?: SessionBackend }): Promise<ClientSession> {
    const backend: unknown = options?.backend ?? "pi";
    if (backend !== "pi" && backend !== "omp") throw new Error(`Unsupported session backend: ${String(backend)}`);
    const forwarded = options?.startupToken === undefined ? undefined : { startupToken: options.startupToken };
    if (backend === "pi") return this.pi.start(cwd, forwarded);
    if (this.omp === undefined) throw new OmpBackendUnavailableError("start an omp session");
    return this.omp.start(cwd, forwarded);
  }

  async messages(ref: SessionRouteRef, page?: { before?: number; limit?: number }): Promise<ClientMessagePage> {
    return this.engineForRef(ref, "read messages").messages(ref, page);
  }

  async status(ref: SessionRouteRef): Promise<ClientSessionStatus> {
    return this.engineForRef(ref, "read status").status(ref);
  }

  async streamSnapshot(ref: SessionRouteRef): Promise<SessionStreamSnapshot> {
    return this.engineForRef(ref, "read stream snapshot").streamSnapshot(ref);
  }

  notificationCatalog(): SessionNotificationCatalogSnapshot | Promise<SessionNotificationCatalogSnapshot> {
    // Pi's notificationCatalog() is a synchronous read of in-memory store
    // state with no per-engine flush to coordinate (unlike unreadCatalog()
    // below), so a second read through omp would be redundant.
    return this.pi.notificationCatalog();
  }

  async unreadCatalog(): Promise<SessionUnreadCatalogSnapshot> {
    // Mirrors PiSessionService's own publishUnreadMutations([]) drain: flush
    // omp's pending writes to the shared store first, then read the durable
    // snapshot through pi. Short-circuits (never reads through pi) if the
    // flush fails, so a failed flush is never silently presented as current.
    if (this.omp !== undefined) await this.omp.unreadCatalog();
    return this.pi.unreadCatalog();
  }

  async acknowledgeUnread(sessionId: string, request: SessionUnreadAcknowledgeRequest): Promise<SessionUnreadCatalogSnapshot> {
    return this.engineForId(sessionId, "acknowledge unread").acknowledgeUnread(sessionId, request);
  }

  async notificationInbox(ref: SessionRouteRef): Promise<SessionNotificationInboxSnapshot> {
    return this.engineForRef(ref, "read notification inbox").notificationInbox(ref);
  }

  async dismissNotification(ref: SessionRouteRef, request: Omit<SessionNotificationDismissRequest, "cwd">): Promise<SessionNotificationInboxSnapshot> {
    return this.engineForRef(ref, "dismiss notification").dismissNotification(ref, request);
  }

  async dismissAllNotifications(ref: SessionRouteRef, request: Omit<SessionNotificationDismissAllRequest, "cwd">): Promise<SessionNotificationInboxSnapshot> {
    return this.engineForRef(ref, "dismiss all notifications").dismissAllNotifications(ref, request);
  }

  async clearQueue(ref: SessionRouteRef): Promise<ClientSessionStatus> {
    return this.engineForRef(ref, "clear queue").clearQueue(ref);
  }

  async submitAsk(ref: SessionRouteRef, askId: string, submission: AskUserSubmission): Promise<AskUserCloseResponse> {
    return this.engineForRef(ref, "submit ask").submitAsk(ref, askId, submission);
  }

  async cancelAsk(ref: SessionRouteRef, askId: string): Promise<AskUserCloseResponse> {
    return this.engineForRef(ref, "cancel ask").cancelAsk(ref, askId);
  }

  async answerDialog(ref: SessionRouteRef, dialogId: string, value: ExtensionDialogAnswer): Promise<ExtensionDialogCloseResponse> {
    return this.engineForRef(ref, "answer dialog").answerDialog(ref, dialogId, value);
  }

  async cancelDialog(ref: SessionRouteRef, dialogId: string): Promise<ExtensionDialogCloseResponse> {
    return this.engineForRef(ref, "cancel dialog").cancelDialog(ref, dialogId);
  }

  async dismissWarning(ref: SessionRouteRef, dismissId: string): Promise<ClientSessionStatus> {
    return this.engineForRef(ref, "dismiss warning").dismissWarning(ref, dismissId);
  }

  async availableModels(ref: SessionRouteRef): Promise<ClientSessionModel[]> {
    return this.engineForRef(ref, "read available models").availableModels(ref);
  }

  async modelCatalog(ref: SessionRouteRef): Promise<ClientSessionModelCatalogEntry[]> {
    return this.engineForRef(ref, "read model catalog").modelCatalog(ref);
  }

  async setModel(ref: SessionRouteRef, provider: string, modelId: string): Promise<ClientSessionStatus> {
    return this.engineForRef(ref, "set model").setModel(ref, provider, modelId);
  }

  async setModelEnabled(ref: SessionRouteRef, provider: string, modelId: string, enabled: boolean): Promise<ClientSessionModelCatalogEntry[]> {
    return this.engineForRef(ref, "set model enabled").setModelEnabled(ref, provider, modelId, enabled);
  }

  async setModelScope(ref: SessionRouteRef, mode: SessionModelScopeMode): Promise<ClientSessionModelCatalogEntry[]> {
    return this.engineForRef(ref, "set model scope").setModelScope(ref, mode);
  }

  async cycleModel(ref: SessionRouteRef, direction: "forward" | "backward"): Promise<ClientSessionStatus> {
    return this.engineForRef(ref, "cycle model").cycleModel(ref, direction);
  }

  async availableThinkingLevels(ref: SessionRouteRef): Promise<ClientThinkingLevel[]> {
    return this.engineForRef(ref, "read available thinking levels").availableThinkingLevels(ref);
  }

  async setThinkingLevel(ref: SessionRouteRef, level: string): Promise<ClientSessionStatus> {
    return this.engineForRef(ref, "set thinking level").setThinkingLevel(ref, level);
  }

  async cycleThinkingLevel(ref: SessionRouteRef): Promise<ClientSessionStatus> {
    return this.engineForRef(ref, "cycle thinking level").cycleThinkingLevel(ref);
  }

  async commands(ref: SessionRouteRef): Promise<ClientCommand[]> {
    return this.engineForRef(ref, "read commands").commands(ref);
  }

  async prompt(ref: SessionRouteRef, text: unknown, streamingBehavior?: unknown, attachments?: unknown): Promise<void> {
    return this.engineForRef(ref, "prompt").prompt(ref, text, streamingBehavior, attachments);
  }

  async saveAttachments(ref: SessionRouteRef, attachments: unknown, folder?: string): Promise<SavedPromptAttachment[]> {
    return this.engineForRef(ref, "save attachments").saveAttachments(ref, attachments, folder);
  }

  private splitBulkRefs(refs: readonly SessionBulkMutationRef[]): { piRefs: SessionBulkMutationRef[]; ompRefs: SessionBulkMutationRef[] } {
    const piRefs: SessionBulkMutationRef[] = [];
    const ompRefs: SessionBulkMutationRef[] = [];
    for (const ref of refs) (isOmpId(ref.id) ? ompRefs : piRefs).push(ref);
    return { piRefs, ompRefs };
  }

  private unavailableOmpFailures(ompRefs: readonly SessionBulkMutationRef[], operation: string): SessionBulkFailure[] {
    if (ompRefs.length === 0 || this.omp !== undefined) return [];
    return ompRefs.map((ref) => ({ sessionId: ref.id, error: `OMP backend is not configured; cannot ${operation} ${ref.id}` }));
  }

  async archiveMany(refs: readonly SessionBulkMutationRef[]): Promise<SessionBulkArchiveResponse> {
    const { piRefs, ompRefs } = this.splitBulkRefs(refs);
    const [piResult, ompResult] = await Promise.all([
      piRefs.length === 0 ? undefined : this.pi.archiveMany(piRefs),
      ompRefs.length === 0 ? undefined : this.omp?.archiveMany(ompRefs),
    ]);
    return {
      archived: true,
      archivedSessionIds: [...(piResult?.archivedSessionIds ?? []), ...(ompResult?.archivedSessionIds ?? [])],
      failures: [...(piResult?.failures ?? []), ...(ompResult?.failures ?? []), ...this.unavailableOmpFailures(ompRefs, "archive")],
      generatedAt: new Date().toISOString(),
    };
  }

  async deleteArchivedMany(refs: readonly SessionBulkMutationRef[]): Promise<SessionBulkDeleteArchivedResponse> {
    const { piRefs, ompRefs } = this.splitBulkRefs(refs);
    const [piResult, ompResult] = await Promise.all([
      piRefs.length === 0 ? undefined : this.pi.deleteArchivedMany(piRefs),
      ompRefs.length === 0 ? undefined : this.omp?.deleteArchivedMany(ompRefs),
    ]);
    return {
      deleted: true,
      deletedSessionIds: [...(piResult?.deletedSessionIds ?? []), ...(ompResult?.deletedSessionIds ?? [])],
      failures: [...(piResult?.failures ?? []), ...(ompResult?.failures ?? []), ...this.unavailableOmpFailures(ompRefs, "delete")],
      generatedAt: new Date().toISOString(),
    };
  }

  async shell(ref: SessionRouteRef, text: string): Promise<void> {
    return this.engineForRef(ref, "run shell").shell(ref, text);
  }

  async runCommand(ref: SessionRouteRef, text: string): Promise<ClientCommandResult> {
    return this.engineForRef(ref, "run command").runCommand(ref, text);
  }

  async respondToCommand(ref: SessionRouteRef, requestId: string, value: string): Promise<ClientCommandResult> {
    return this.engineForRef(ref, "respond to command").respondToCommand(ref, requestId, value);
  }

  async navigateTree(ref: SessionRouteRef, request: ClientSessionTreeNavigateRequest): Promise<ClientSessionTreeNavigateResult> {
    return this.engineForRef(ref, "navigate tree").navigateTree(ref, request);
  }

  async forkFromTree(ref: SessionRouteRef, request: ClientSessionTreeForkRequest): Promise<ClientSessionTreeForkResult> {
    return this.engineForRef(ref, "fork from tree").forkFromTree(ref, request);
  }

  async abort(ref: SessionRouteRef): Promise<void> {
    return this.engineForRef(ref, "abort").abort(ref);
  }

  async stop(ref: SessionRouteRef): Promise<void> {
    await this.engineForRef(ref, "stop").stop(ref);
  }

  async archive(ref: SessionRouteRef): Promise<void> {
    return this.engineForRef(ref, "archive").archive(ref);
  }

  async archiveTree(ref: SessionRouteRef): Promise<ClientArchiveSessionsResponse> {
    return this.engineForRef(ref, "archive tree").archiveTree(ref);
  }

  async restore(ref: SessionRouteRef): Promise<void> {
    return this.engineForRef(ref, "restore").restore(ref);
  }

  async reload(ref: SessionRouteRef): Promise<void> {
    return this.engineForRef(ref, "reload").reload(ref);
  }

  async detachParent(ref: SessionRouteRef): Promise<void> {
    return this.engineForRef(ref, "detach parent").detachParent(ref);
  }

  private mergeProjects(a: readonly SessionCleanupProjectSummary[], b: readonly SessionCleanupProjectSummary[]): SessionCleanupProjectSummary[] {
    const byCwd = new Map<string, SessionCleanupProjectSummary>();
    for (const project of [...a, ...b]) {
      const existing = byCwd.get(project.cwd);
      byCwd.set(project.cwd, existing === undefined
        ? project
        : { cwd: project.cwd, archiveCount: existing.archiveCount + project.archiveCount, deleteCount: existing.deleteCount + project.deleteCount });
    }
    return [...byCwd.values()];
  }

  private mergeCleanupPreview(pi: ClientSessionCleanupPreviewResponse, omp: ClientSessionCleanupPreviewResponse | undefined): ClientSessionCleanupPreviewResponse {
    if (omp === undefined) return pi;
    const skippedBusySessionIds = [...(pi.skippedBusySessionIds ?? []), ...(omp.skippedBusySessionIds ?? [])];
    return {
      generatedAt: pi.generatedAt > omp.generatedAt ? pi.generatedAt : omp.generatedAt,
      thresholds: pi.thresholds,
      projects: this.mergeProjects(pi.projects, omp.projects),
      totals: { archiveCount: pi.totals.archiveCount + omp.totals.archiveCount, deleteCount: pi.totals.deleteCount + omp.totals.deleteCount },
      ...(skippedBusySessionIds.length === 0 ? {} : { skippedBusySessionIds }),
    };
  }

  async cleanupPreview(request: NormalizedSessionCleanupRequest): Promise<ClientSessionCleanupPreviewResponse> {
    const [piResult, ompResult] = await Promise.all([this.pi.cleanupPreview(request), this.omp === undefined ? undefined : this.omp.cleanupPreview(request)]);
    return this.mergeCleanupPreview(piResult, ompResult);
  }

  async cleanup(request: NormalizedSessionCleanupRequest): Promise<ClientSessionCleanupExecuteResponse> {
    const [piResult, ompResult] = await Promise.all([this.pi.cleanup(request), this.omp === undefined ? undefined : this.omp.cleanup(request)]);
    return {
      ...this.mergeCleanupPreview(piResult, ompResult),
      archivedSessionIds: [...piResult.archivedSessionIds, ...(ompResult?.archivedSessionIds ?? [])],
      deletedSessionIds: [...piResult.deletedSessionIds, ...(ompResult?.deletedSessionIds ?? [])],
    };
  }

  activeCount(): number {
    return this.pi.activeCount() + (this.omp?.activeCount() ?? 0);
  }

  async dispose(): Promise<void> {
    // Each call is wrapped in its own async closure so a synchronous throw
    // from either engine's dispose() still yields a promise immediately,
    // rather than aborting the Promise.allSettled argument list before the
    // other engine's dispose() is ever invoked (the disposal guarantee is
    // "both are attempted", not "attempted only if the first didn't throw").
    const disposePi = async (): Promise<void> => { await this.pi.dispose(); };
    const disposeOmp = async (): Promise<void> => { if (this.omp !== undefined) await this.omp.dispose(); };
    const settled = await Promise.allSettled([disposePi(), disposeOmp()]);
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure !== undefined) throw failure.reason;
  }
}
