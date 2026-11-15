import type { ClientSessionStatus } from "../types.js";

export type SessionStatisticsSnapshot = Pick<ClientSessionStatus, "tokens" | "cost"> & {
  contextUsage?: ClientSessionStatus["contextUsage"] | undefined;
};

/** Only persisted accounting and effective context limits belong in this projection. */
export interface SessionStatisticsSource {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly sessionManager: {
    getLeafId(): string | null;
    getEntryCount?(): number;
  };
  readonly model: { contextWindow: number } | undefined;
  readonly routedModel?: { model: { contextWindow: number } } | undefined;
  getSessionStats(): SessionStatisticsSnapshot;
  getContextUsage(): ClientSessionStatus["contextUsage"] | undefined;
}

interface StatisticsRevision {
  manager: SessionStatisticsSource["sessionManager"];
  sessionId: string;
  sessionFile: string | undefined;
  leafId: string | null;
  entryCount: number | undefined;
  contextWindow: number | undefined;
}

interface CachedStatistics {
  revision: StatisticsRevision;
  snapshot: SessionStatisticsSnapshot;
}

/**
 * Display statistics have a different freshness policy from operational status.
 * Seed once at runtime binding, then refresh on the service heartbeat, including
 * after a run becomes idle. Reads never scan history. The heartbeat coalesces
 * bursts and runs after message_end's not-yet-persisted SDK notification stack.
 * Calculations still run synchronously; this bounds their frequency, not duration.
 */
export class SessionStatistics {
  // Keep the last snapshot available to in-flight reads after runtime teardown.
  // Weak ownership releases it with the session; rebinding explicitly reseeds it.
  private readonly snapshots = new WeakMap<SessionStatisticsSource, CachedStatistics>();

  initialize(session: SessionStatisticsSource): void {
    this.snapshots.set(session, this.calculate(session, this.revision(session)));
  }

  read(session: SessionStatisticsSource): SessionStatisticsSnapshot {
    const cached = this.snapshots.get(session);
    if (cached === undefined) throw new Error("Session statistics must be initialized before publishing status");
    return cached.snapshot;
  }

  /** Returns whether a new snapshot needs publishing. A failed calculation keeps the old snapshot. */
  refresh(session: SessionStatisticsSource): boolean {
    const revision = this.revision(session);
    const previous = this.snapshots.get(session);
    if (previous !== undefined && this.sameRevision(previous.revision, revision)) return false;
    this.snapshots.set(session, this.calculate(session, revision));
    return true;
  }

  private revision(session: SessionStatisticsSource): StatisticsRevision {
    return {
      manager: session.sessionManager,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      leafId: session.sessionManager.getLeafId(),
      entryCount: session.sessionManager.getEntryCount?.(),
      contextWindow: (session.routedModel?.model ?? session.model)?.contextWindow,
    };
  }

  private sameRevision(a: StatisticsRevision, b: StatisticsRevision): boolean {
    // Older SDKs cannot cheaply prove that no off-branch entry was appended.
    // Refresh those on the heartbeat rather than copying history on status reads.
    return b.entryCount !== undefined && a.manager === b.manager
      && a.sessionId === b.sessionId && a.sessionFile === b.sessionFile
      && a.leafId === b.leafId && a.entryCount === b.entryCount
      && a.contextWindow === b.contextWindow;
  }

  private calculate(session: SessionStatisticsSource, revision: StatisticsRevision): CachedStatistics {
    const stats = session.getSessionStats();
    // Current Pi includes context usage in stats, including an explicit undefined
    // when no model is selected. Only older SDKs need the separate query.
    const contextUsage = "contextUsage" in stats ? stats.contextUsage : session.getContextUsage();
    return {
      revision,
      snapshot: { tokens: stats.tokens, cost: stats.cost, ...(contextUsage === undefined ? {} : { contextUsage }) },
    };
  }
}
