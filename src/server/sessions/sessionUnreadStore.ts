import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { piWebDataDir } from "../../config.js";
import {
  SESSION_UNREAD_CATALOG_ID_MAX_LENGTH,
  SESSION_UNREAD_COMPLETED_AT_MAX_LENGTH,
  SESSION_UNREAD_CWD_MAX_LENGTH,
  SESSION_UNREAD_LIMIT,
  SESSION_UNREAD_SESSION_ID_MAX_LENGTH,
  type SessionUnreadAcknowledgeRequest,
  type SessionUnreadCatalogSnapshot,
  type SessionUnreadEvent,
  type SessionUnreadSummary,
} from "../../shared/apiTypes.js";

const SESSION_UNREAD_STATE_VERSION = 1;
const SESSION_UNREAD_FILE_MODE = 0o600;

export interface SessionUnreadPersistedState {
  version: typeof SESSION_UNREAD_STATE_VERSION;
  catalogId: string;
  catalogRevision: number;
  nextCompletionOrder: number;
  sessions: SessionUnreadSummary[];
}

export interface SessionUnreadPersistence {
  load(): Promise<unknown>;
  save(state: SessionUnreadPersistedState): Promise<void>;
}

export interface SessionUnreadStoreOptions {
  now?: (() => Date) | undefined;
  persistence?: SessionUnreadPersistence | undefined;
  createCatalogId?: (() => string) | undefined;
  onPersistenceError?: ((operation: "load" | "save", error: unknown) => void) | undefined;
}

export interface SessionUnreadMutation {
  event: SessionUnreadEvent;
}

export interface SessionUnreadAcknowledgeResult {
  mutations: SessionUnreadMutation[];
}

interface SessionUnreadIdentity {
  sessionId: string;
  cwd: string;
}

interface PendingSessionUnreadPersistence {
  generation: number;
  state: SessionUnreadPersistedState;
}

/**
 * Daemon-owned unread completion catalog.
 *
 * Completion orders are global and never reused within a catalog epoch. An
 * acknowledgement must carry both the epoch and the observed completion order,
 * so neither an old completion nor a client from reset state can clear newer
 * work.
 */
export class SessionUnreadStore {
  private readonly now: () => Date;
  private readonly persistence: SessionUnreadPersistence | undefined;
  private readonly createCatalogId: () => string;
  private readonly onPersistenceError: (operation: "load" | "save", error: unknown) => void;
  private readonly unreadByIdentity = new Map<string, SessionUnreadSummary>();
  private readonly activeByIdentity = new Map<string, SessionUnreadIdentity>();
  private readonly excludedByIdentity = new Map<string, SessionUnreadIdentity>();
  private catalogId: string;
  private catalogRevision = 0;
  private nextCompletionOrder = 0;
  private persistenceWorker: Promise<void> | undefined;
  private pendingPersistence: PendingSessionUnreadPersistence | undefined;
  private persistenceGeneration = 0;
  private durablePersistenceGeneration = 0;
  private persistenceFailure: { error: unknown } | undefined;
  private loadPromise: Promise<void> | undefined;
  private loaded: boolean;

  constructor(options: SessionUnreadStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.persistence = options.persistence;
    this.createCatalogId = options.createCatalogId ?? randomUUID;
    this.onPersistenceError = options.onPersistenceError ?? (() => undefined);
    this.loaded = this.persistence === undefined;
    // A persisted store receives its epoch from disk or creates one during
    // load; synchronous in-memory stores are ready immediately.
    this.catalogId = this.loaded ? this.freshCatalogId() : "";
  }

  load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loadPromise !== undefined) return this.loadPromise;
    const loadPromise = this.loadPersistedState();
    this.loadPromise = loadPromise;
    return loadPromise;
  }

  /** Current in-memory state. Transport boundaries should use `durableCatalogSnapshot`. */
  catalogSnapshot(): SessionUnreadCatalogSnapshot {
    this.requireLoaded();
    return {
      catalogId: this.catalogId,
      catalogRevision: this.catalogRevision,
      sessions: [...this.unreadByIdentity.values()]
        .sort((left, right) => right.completionOrder - left.completionOrder)
        .map((summary) => ({ ...summary })),
    };
  }

  observeActivityState(sessionId: string, cwd: string, active: boolean): SessionUnreadMutation[] {
    this.requireLoaded();
    const identity = requireIdentity(sessionId, cwd);
    const key = sessionIdentityKey(identity);
    if (this.excludedByIdentity.has(key)) {
      this.activeByIdentity.delete(key);
      return [];
    }
    if (active) {
      this.activeByIdentity.set(key, identity);
      return [];
    }
    if (!this.activeByIdentity.has(key)) return [];

    const completionOrder = incrementSafe(this.nextCompletionOrder, "Session unread completion order exhausted");
    const willExceedLimit = !this.unreadByIdentity.has(key) && this.unreadByIdentity.size >= SESSION_UNREAD_LIMIT;
    this.assertRevisionCapacity(willExceedLimit ? 2 : 1);
    const completedAt = this.now().toISOString();

    this.activeByIdentity.delete(key);
    this.nextCompletionOrder = completionOrder;
    const summary: SessionUnreadSummary = {
      sessionId,
      cwd,
      completionOrder,
      completedAt,
    };
    // Reinsert existing identities so map order remains completion order.
    this.unreadByIdentity.delete(key);
    this.unreadByIdentity.set(key, summary);
    const mutations = [this.mutation(identity, summary), ...this.trimToLimit()];
    this.schedulePersist();
    return mutations;
  }

  /** Clear only the transient active latch for a runtime that is closing or rebinding. */
  forgetActivity(sessionId: string, cwd: string): void {
    this.requireLoaded();
    const identity = requireIdentity(sessionId, cwd);
    this.activeByIdentity.delete(sessionIdentityKey(identity));
  }

  /**
   * Suppress unread tracking until this identity is explicitly forgotten and
   * remove state recorded before it was verified as a tracked sub-session.
   */
  excludeSession(sessionId: string, cwd: string): SessionUnreadMutation[] {
    this.requireLoaded();
    const identity = requireIdentity(sessionId, cwd);
    const key = sessionIdentityKey(identity);
    const current = this.unreadByIdentity.get(key);
    this.assertRevisionCapacity(current === undefined ? 0 : 1);

    this.excludedByIdentity.set(key, identity);
    this.activeByIdentity.delete(key);
    if (current === undefined) return [];

    this.unreadByIdentity.delete(key);
    const mutations = [this.mutation(identity, null)];
    this.schedulePersist();
    return mutations;
  }

  acknowledge(sessionId: string, request: SessionUnreadAcknowledgeRequest): SessionUnreadAcknowledgeResult {
    this.requireLoaded();
    const identity = requireIdentity(sessionId, request.cwd);
    requireCatalogId(request.catalogId);
    requirePositiveSafeInteger(request.throughCompletionOrder, "throughCompletionOrder");
    if (request.catalogId !== this.catalogId) return { mutations: [] };

    const key = sessionIdentityKey(identity);
    const current = this.unreadByIdentity.get(key);
    if (current === undefined || current.completionOrder > request.throughCompletionOrder) {
      return { mutations: [] };
    }

    this.assertRevisionCapacity(1);
    this.unreadByIdentity.delete(key);
    const mutations = [this.mutation(identity, null)];
    this.schedulePersist();
    return { mutations };
  }

  /** Remove durable unread and all transient lifecycle state for one identity. */
  forgetSession(sessionId: string, cwd: string): SessionUnreadMutation[] {
    this.requireLoaded();
    const identity = requireIdentity(sessionId, cwd);
    const key = sessionIdentityKey(identity);
    const current = this.unreadByIdentity.get(key);
    this.assertRevisionCapacity(current === undefined ? 0 : 1);

    this.activeByIdentity.delete(key);
    this.excludedByIdentity.delete(key);
    if (current === undefined) return [];

    this.unreadByIdentity.delete(key);
    const mutations = [this.mutation(identity, null)];
    this.schedulePersist();
    return mutations;
  }

  reconcileCwd(cwd: string, sessionIds: Iterable<string>): SessionUnreadMutation[] {
    this.requireLoaded();
    const boundedCwd = requireBoundedNonEmptyString(cwd, "cwd", SESSION_UNREAD_CWD_MAX_LENGTH);
    const retained = new Set(sessionIds);
    const removed = [...this.unreadByIdentity.entries()]
      .filter(([, summary]) => summary.cwd === boundedCwd && !retained.has(summary.sessionId));
    this.assertRevisionCapacity(removed.length);

    for (const [key, identity] of this.activeByIdentity) {
      if (identity.cwd === boundedCwd && !retained.has(identity.sessionId)) this.activeByIdentity.delete(key);
    }
    for (const [key, identity] of this.excludedByIdentity) {
      if (identity.cwd === boundedCwd && !retained.has(identity.sessionId)) this.excludedByIdentity.delete(key);
    }

    const mutations: SessionUnreadMutation[] = [];
    for (const [key, summary] of removed) {
      this.unreadByIdentity.delete(key);
      mutations.push(this.mutation(summary, null));
    }
    if (mutations.length > 0) this.schedulePersist();
    return mutations;
  }

  /** Wait until all currently queued state is durably represented or throw. */
  async flush(): Promise<void> {
    this.requireLoaded();
    await this.waitForPersistenceWorker();
    if (this.persistenceFailure === undefined
      && this.persistenceGeneration === this.durablePersistenceGeneration) return;

    // Retry the latest complete snapshot once. Failed/intermediate snapshots
    // are coalesced because completion orders and revisions are cumulative.
    this.ensurePersistenceWorker();
    await this.waitForPersistenceWorker();
    this.throwIfPersistenceFailed();
  }

  /** Snapshot safe to expose to a client that may subsequently acknowledge it. */
  async durableCatalogSnapshot(): Promise<SessionUnreadCatalogSnapshot> {
    let snapshot: SessionUnreadCatalogSnapshot;
    do {
      await this.flush();
      snapshot = this.catalogSnapshot();
    } while (this.persistenceGeneration !== this.durablePersistenceGeneration);
    return snapshot;
  }

  private async loadPersistedState(): Promise<void> {
    const persistence = this.persistence;
    if (persistence === undefined) {
      this.loaded = true;
      return;
    }

    let value: unknown;
    let resetState = false;
    try {
      value = await persistence.load();
    } catch (error: unknown) {
      this.reportPersistenceError("load", error);
      if (!(error instanceof SessionUnreadPersistenceCorruptionError)) throw error;
      resetState = true;
    }

    if (!resetState && value !== undefined) {
      try {
        this.installPersistedState(parsePersistedState(value));
      } catch (error: unknown) {
        this.reportPersistenceError("load", error);
        resetState = true;
      }
    } else if (value === undefined) {
      resetState = true;
    }

    if (resetState) {
      this.resetInMemoryState();
      // Persist even an empty epoch so the catalog identity itself survives a
      // clean daemon restart and a corrupt file is repaired once.
      this.schedulePersist();
      await this.waitForPersistenceWorker();
      try {
        this.throwIfPersistenceFailed();
      } catch (error: unknown) {
        this.loaded = false;
        throw error;
      }
    }
    this.loaded = true;
  }

  private resetInMemoryState(): void {
    this.catalogId = this.freshCatalogId();
    this.catalogRevision = 0;
    this.nextCompletionOrder = 0;
    this.unreadByIdentity.clear();
    this.activeByIdentity.clear();
    this.excludedByIdentity.clear();
  }

  private mutation(identity: SessionUnreadIdentity, unread: SessionUnreadSummary | null): SessionUnreadMutation {
    this.catalogRevision = incrementSafe(this.catalogRevision, "Session unread catalog revision exhausted");
    return {
      event: {
        type: "sessions.unread",
        catalogId: this.catalogId,
        catalogRevision: this.catalogRevision,
        sessionId: identity.sessionId,
        cwd: identity.cwd,
        unread: unread === null ? null : { ...unread },
      },
    };
  }

  private trimToLimit(): SessionUnreadMutation[] {
    const mutations: SessionUnreadMutation[] = [];
    while (this.unreadByIdentity.size > SESSION_UNREAD_LIMIT) {
      let oldestKey: string | undefined;
      let oldest: SessionUnreadSummary | undefined;
      for (const [key, summary] of this.unreadByIdentity) {
        if (oldest === undefined || summary.completionOrder < oldest.completionOrder) {
          oldestKey = key;
          oldest = summary;
        }
      }
      if (oldestKey === undefined || oldest === undefined) break;
      this.unreadByIdentity.delete(oldestKey);
      mutations.push(this.mutation(oldest, null));
    }
    return mutations;
  }

  private assertRevisionCapacity(count: number): void {
    if (!Number.isSafeInteger(this.catalogRevision + count)) {
      throw new Error("Session unread catalog revision exhausted");
    }
  }

  private schedulePersist(): void {
    if (this.persistence === undefined) return;
    const generation = incrementSafe(this.persistenceGeneration, "Session unread persistence generation exhausted");
    this.persistenceGeneration = generation;
    this.pendingPersistence = { generation, state: this.persistedState() };
    // Once a save fails, mutations continue replacing the one pending snapshot
    // but do not hammer storage; the service's backoff (or an explicit flush)
    // owns the next retry attempt.
    if (this.persistenceFailure === undefined) this.ensurePersistenceWorker();
  }

  private ensurePersistenceWorker(): void {
    if (this.persistence === undefined || this.persistenceWorker !== undefined || this.pendingPersistence === undefined) return;
    const worker = this.runPersistenceWorker();
    this.persistenceWorker = worker;
    void worker.finally(() => {
      if (this.persistenceWorker === worker) this.persistenceWorker = undefined;
    });
  }

  private async runPersistenceWorker(): Promise<void> {
    const persistence = this.persistence;
    if (persistence === undefined) return;
    while (this.pendingPersistence !== undefined) {
      const pending = this.pendingPersistence;
      this.pendingPersistence = undefined;
      try {
        await persistence.save(pending.state);
        this.durablePersistenceGeneration = pending.generation;
        this.persistenceFailure = undefined;
      } catch (error: unknown) {
        // A newer pending snapshot subsumes this failed one. Otherwise retain
        // this exact snapshot so a later flush can retry without a new mutation.
        this.pendingPersistence ??= pending;
        this.persistenceFailure = { error };
        this.reportPersistenceError("save", error);
        return;
      }
    }
  }

  private async waitForPersistenceWorker(): Promise<void> {
    let worker = this.persistenceWorker;
    while (worker !== undefined) {
      await worker;
      worker = this.persistenceWorker;
    }
  }

  private throwIfPersistenceFailed(): void {
    const failure = this.persistenceFailure;
    if (failure !== undefined) throw failure.error;
  }

  private persistedState(): SessionUnreadPersistedState {
    return {
      version: SESSION_UNREAD_STATE_VERSION,
      catalogId: this.catalogId,
      catalogRevision: this.catalogRevision,
      nextCompletionOrder: this.nextCompletionOrder,
      sessions: [...this.unreadByIdentity.values()].map((summary) => ({ ...summary })),
    };
  }

  private installPersistedState(state: SessionUnreadPersistedState): void {
    this.catalogId = state.catalogId;
    this.catalogRevision = state.catalogRevision;
    this.nextCompletionOrder = state.nextCompletionOrder;
    this.unreadByIdentity.clear();
    for (const summary of [...state.sessions].sort((left, right) => left.completionOrder - right.completionOrder)) {
      this.unreadByIdentity.set(sessionIdentityKey(summary), { ...summary });
    }
  }

  private freshCatalogId(): string {
    return requireCatalogId(this.createCatalogId());
  }

  private requireLoaded(): void {
    if (!this.loaded) throw new Error("Session unread store must be loaded before use");
  }

  private reportPersistenceError(operation: "load" | "save", error: unknown): void {
    try {
      this.onPersistenceError(operation, error);
    } catch {
      // Error reporting must not poison future serialized persistence work.
    }
  }
}

class SessionUnreadPersistenceCorruptionError extends Error {
  constructor(cause: unknown) {
    super("Session unread persistence contains invalid JSON", { cause });
  }
}

export class FileSessionUnreadPersistence implements SessionUnreadPersistence {
  constructor(readonly filePath = defaultSessionUnreadFilePath()) {}

  async load(): Promise<unknown> {
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const value: unknown = JSON.parse(source);
      return value;
    } catch (error: unknown) {
      throw new SessionUnreadPersistenceCorruptionError(error);
    }
  }

  async save(state: SessionUnreadPersistedState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid.toString()}-${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: SESSION_UNREAD_FILE_MODE,
        flag: "wx",
      });
      await rename(tempPath, this.filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

export function defaultSessionUnreadFilePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebDataDir(env, cwd), "session-unread.json");
}

function parsePersistedState(value: unknown): SessionUnreadPersistedState {
  const record = requireRecord(value, "Session unread state must be an object");
  if (record["version"] !== SESSION_UNREAD_STATE_VERSION) throw new Error("Unsupported session unread state version");
  const catalogId = requireCatalogId(record["catalogId"]);
  const catalogRevision = requireNonNegativeSafeInteger(record["catalogRevision"], "catalogRevision");
  const nextCompletionOrder = requireNonNegativeSafeInteger(record["nextCompletionOrder"], "nextCompletionOrder");
  const rawSessions = record["sessions"];
  if (!Array.isArray(rawSessions)) throw new Error("Session unread sessions must be an array");
  if (rawSessions.length > SESSION_UNREAD_LIMIT) throw new Error("Session unread state exceeds its session limit");

  const sessions = rawSessions.map(parseSummary);
  const identities = new Set<string>();
  const orders = new Set<number>();
  for (const summary of sessions) {
    const key = sessionIdentityKey(summary);
    if (identities.has(key)) throw new Error("Duplicate session unread identity");
    if (orders.has(summary.completionOrder)) throw new Error("Duplicate session unread completion order");
    identities.add(key);
    orders.add(summary.completionOrder);
  }
  const maxOrder = sessions.reduce((maximum, summary) => Math.max(maximum, summary.completionOrder), 0);
  if (nextCompletionOrder < maxOrder) throw new Error("Session unread completion order is inconsistent");
  if (catalogRevision < nextCompletionOrder) throw new Error("Session unread catalog revision is inconsistent");
  return {
    version: SESSION_UNREAD_STATE_VERSION,
    catalogId,
    catalogRevision,
    nextCompletionOrder,
    sessions,
  };
}

function parseSummary(value: unknown): SessionUnreadSummary {
  const record = requireRecord(value, "Session unread summary must be an object");
  const completedAt = requireBoundedNonEmptyString(
    record["completedAt"],
    "completedAt",
    SESSION_UNREAD_COMPLETED_AT_MAX_LENGTH,
  );
  const completedDate = new Date(completedAt);
  if (!Number.isFinite(completedDate.getTime()) || completedDate.toISOString() !== completedAt) {
    throw new Error("Session unread completedAt must be a canonical ISO timestamp");
  }
  return {
    sessionId: requireBoundedNonEmptyString(
      record["sessionId"],
      "sessionId",
      SESSION_UNREAD_SESSION_ID_MAX_LENGTH,
    ),
    cwd: requireBoundedNonEmptyString(record["cwd"], "cwd", SESSION_UNREAD_CWD_MAX_LENGTH),
    completionOrder: requirePositiveSafeInteger(record["completionOrder"], "completionOrder"),
    completedAt,
  };
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`Session unread ${field} must be a non-empty string`);
  return value;
}

function requireBoundedNonEmptyString(value: unknown, field: string, maxLength: number): string {
  const parsed = requireNonEmptyString(value, field);
  if (parsed.length > maxLength) throw new Error(`Session unread ${field} exceeds its length limit`);
  return parsed;
}

function requireCatalogId(value: unknown): string {
  return requireBoundedNonEmptyString(value, "catalogId", SESSION_UNREAD_CATALOG_ID_MAX_LENGTH);
}

function requireNonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Session unread ${field} must be a non-negative safe integer`);
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, field: string): number {
  const parsed = requireNonNegativeSafeInteger(value, field);
  if (parsed === 0) throw new Error(`Session unread ${field} must be positive`);
  return parsed;
}

function requireIdentity(sessionId: string, cwd: string): SessionUnreadIdentity {
  return {
    sessionId: requireBoundedNonEmptyString(sessionId, "sessionId", SESSION_UNREAD_SESSION_ID_MAX_LENGTH),
    cwd: requireBoundedNonEmptyString(cwd, "cwd", SESSION_UNREAD_CWD_MAX_LENGTH),
  };
}

function sessionIdentityKey(identity: SessionUnreadIdentity): string {
  return JSON.stringify([identity.sessionId, identity.cwd]);
}

function incrementSafe(value: number, message: string): number {
  const next = value + 1;
  if (!Number.isSafeInteger(next)) throw new Error(message);
  return next;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
