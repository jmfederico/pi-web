import { describe, expect, it, vi } from "vitest";
import type { PiAgentSession } from "./piSessionService.js";
import { SessionUsageCache } from "./sessionUsageCache.js";
import { fakeRuntime, fakeSessionManager, testModel } from "./piSessionService.testSupport.js";

function fixture() {
  let entryCount = 0;
  let leafId: string | null = null;
  const fake = fakeRuntime();
  const originalStats = fake.session.getSessionStats.bind(fake.session);
  const contextUsage = { tokens: 12, contextWindow: 100, percent: 12 };
  const getSessionStats = vi.fn<PiAgentSession["getSessionStats"]>(() => ({ ...originalStats(), cost: entryCount, contextUsage }));
  const getContextUsage = vi.fn(() => undefined);
  const session = Object.assign(fake.session, {
    sessionManager: fakeSessionManager("/workspace", {
      getEntryCount: () => entryCount,
      getLeafId: () => leafId,
    }),
    getSessionStats,
    getContextUsage,
  });
  return {
    session, getSessionStats, getContextUsage, contextUsage,
    append() { entryCount++; leafId = `entry-${String(entryCount)}`; },
    navigate(id: string | null) { leafId = id; },
  };
}

describe("SessionUsageCache", () => {
  it("reuses committed usage during streaming and observes persistence after the pre-write message_end", () => {
    const f = fixture();
    const cache = new SessionUsageCache();
    expect(cache.read(f.session)).toMatchObject({ cost: 0, contextUsage: f.contextUsage });
    // Runtime flags and partials change before message_end is persisted. None
    // changes the SDK's billed totals or projected, persisted context.
    f.session.isStreaming = true;
    for (let i = 0; i < 100; i++) cache.read(f.session);
    expect(f.getSessionStats).toHaveBeenCalledTimes(1);
    expect(f.getContextUsage).not.toHaveBeenCalled();
    f.append();
    expect(cache.read(f.session).cost).toBe(1);
    expect(f.getSessionStats).toHaveBeenCalledTimes(2);
    // An off-branch append followed by navigation back must still update billing.
    f.append();
    f.navigate("entry-1");
    expect(cache.read(f.session).cost).toBe(2);
    f.navigate(null);
    cache.read(f.session);
    expect(f.getSessionStats).toHaveBeenCalledTimes(4);
  });

  it("refreshes on model limits, runtime rebinding, and manager replacement", () => {
    const f = fixture();
    const cache = new SessionUsageCache();
    cache.read(f.session);
    f.session.model = testModel();
    cache.read(f.session);
    const routedModel = { ...testModel(), contextWindow: 123 };
    const session = Object.assign(f.session, { routedModel: { model: routedModel } });
    cache.read(session);
    routedModel.contextWindow = 456;
    cache.read(session);
    cache.invalidate(session);
    cache.read(session);
    session.sessionManager = fakeSessionManager("/workspace", { getEntryCount: () => 0, getLeafId: () => null });
    cache.read(session);
    expect(f.getSessionStats).toHaveBeenCalledTimes(6);
  });

  it("does not double-read an undefined SDK context, but supports older stats and managers", () => {
    const f = fixture();
    const cache = new SessionUsageCache();
    f.getSessionStats.mockReturnValue({ ...f.getSessionStats(), contextUsage: undefined });
    cache.read(f.session);
    expect(f.getContextUsage).not.toHaveBeenCalled();
    const legacyStats = vi.fn(() => ({
      sessionId: "session-1", totalMessages: 0, userMessages: 0, assistantMessages: 0,
      toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
    }));
    const session = Object.assign(f.session, { sessionManager: fakeSessionManager(), getSessionStats: legacyStats });
    cache.read(session);
    cache.read(session);
    expect(legacyStats).toHaveBeenCalledTimes(2);
    expect(f.getContextUsage).toHaveBeenCalledTimes(2);
  });
});
