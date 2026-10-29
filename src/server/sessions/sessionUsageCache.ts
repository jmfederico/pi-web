import type { PiAgentSession } from "./piSessionService.js";

type UsageSnapshot = Pick<ReturnType<PiAgentSession["getSessionStats"]>, "tokens" | "cost" | "contextUsage">;

interface CachedUsage {
  manager: PiAgentSession["sessionManager"];
  sessionId: string;
  sessionFile: string | undefined;
  entryCount: number;
  leafId: string | null;
  model: PiAgentSession["model"];
  limitsModel: PiAgentSession["model"];
  contextWindow: number | undefined;
  usage: UsageSnapshot;
}

/** Only persisted history feeds SDK usage; streamed partials do not. */
export class SessionUsageCache {
  private readonly snapshots = new WeakMap<PiAgentSession, CachedUsage>();

  invalidate(session: PiAgentSession): void {
    this.snapshots.delete(session);
  }

  read(session: PiAgentSession): UsageSnapshot {
    const manager = session.sessionManager;
    // Older SDKs lack the O(1) count. Do not copy all entries just to build a
    // cache key, or assume that an unchanged leaf means no off-branch appends.
    const entryCount = manager.getEntryCount?.();
    const leafId = manager.getLeafId();
    const limitsModel = session.routedModel?.model ?? session.model;
    const cached = this.snapshots.get(session);
    if (entryCount !== undefined && cached?.manager === manager && cached.sessionId === session.sessionId
      && cached.sessionFile === session.sessionFile && cached.entryCount === entryCount
      && cached.leafId === leafId && cached.model === session.model
      && cached.limitsModel === limitsModel && cached.contextWindow === limitsModel?.contextWindow) {
      return cached.usage;
    }

    const stats = session.getSessionStats();
    // Current SDK stats already compute context usage, including an explicitly
    // undefined value. Only older adapters without that field need a separate read.
    const contextUsage = "contextUsage" in stats ? stats.contextUsage : session.getContextUsage();
    const usage = { tokens: stats.tokens, cost: stats.cost, contextUsage };
    if (entryCount !== undefined) {
      this.snapshots.set(session, {
        manager, sessionId: session.sessionId, sessionFile: session.sessionFile,
        entryCount, leafId, model: session.model, limitsModel,
        contextWindow: limitsModel?.contextWindow, usage,
      });
    }
    return usage;
  }
}
