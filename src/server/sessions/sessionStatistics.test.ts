import { describe, expect, it, vi } from "vitest";
import { SessionStatistics, type SessionStatisticsSnapshot, type SessionStatisticsSource } from "./sessionStatistics.js";

function fixture() {
  const history = { leaf: "entry-1", count: 1 };
  let snapshot: SessionStatisticsSnapshot = {
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: 0.1,
    contextUsage: { tokens: 15, contextWindow: 1000, percent: 1.5 },
  };
  const limits: Pick<SessionStatisticsSource, "model" | "routedModel"> = {
    model: { contextWindow: 1000 }, routedModel: undefined,
  };
  const session = {
    ...limits,
    sessionId: "session-1",
    sessionFile: "/sessions/one.jsonl",
    sessionManager: {
      getLeafId: vi.fn(() => history.leaf),
      getEntryCount: vi.fn(() => history.count),
    },
    getSessionStats: vi.fn(() => snapshot),
    getContextUsage: vi.fn(() => snapshot.contextUsage),
  } satisfies SessionStatisticsSource;
  const statistics = new SessionStatistics();
  statistics.initialize(session);
  return { statistics, session, history, setSnapshot: (next: SessionStatisticsSnapshot) => { snapshot = next; } };
}

describe("SessionStatistics", () => {
  it("serves snapshots without inspecting history and reuses unchanged revisions", () => {
    const { statistics, session } = fixture();
    const initial = statistics.read(session);
    for (let i = 0; i < 100; i += 1) expect(statistics.read(session)).toBe(initial);
    expect(session.sessionManager.getLeafId).toHaveBeenCalledTimes(1);
    expect(session.sessionManager.getEntryCount).toHaveBeenCalledTimes(1);
    expect(statistics.refresh(session)).toBe(false);
    expect(session.getSessionStats).toHaveBeenCalledTimes(1);
    expect(session.getContextUsage).not.toHaveBeenCalled();
  });

  it.each(["append", "branch", "off-branch usage", "context limit", "routed context limit", "session", "file", "manager"])("refreshes after %s changes", (change) => {
    const { statistics, session, history, setSnapshot } = fixture();
    const original = statistics.read(session);
    const next = { ...original, cost: 0.5 };
    setSnapshot(next);
    switch (change) {
      case "append": history.leaf = "entry-2"; history.count += 1; break;
      case "branch": history.leaf = "other-branch"; break;
      case "off-branch usage": history.count += 1; break;
      case "context limit": session.model = { contextWindow: 2000 }; break;
      case "routed context limit": session.routedModel = { model: { contextWindow: 5000 } }; break;
      case "session": session.sessionId = "session-2"; break;
      case "file": session.sessionFile = "/sessions/two.jsonl"; break;
      case "manager": session.sessionManager = { ...session.sessionManager }; break;
    }
    // Changed source inputs never make a read perform the calculation.
    expect(statistics.read(session)).toBe(original);
    expect(statistics.refresh(session)).toBe(true);
    expect(statistics.read(session)).toEqual(next);
    expect(statistics.refresh(session)).toBe(false);
    expect(session.getSessionStats).toHaveBeenCalledTimes(2);
  });

  it("clears context usage without repeating an explicitly unavailable SDK calculation", () => {
    const { statistics, session, setSnapshot } = fixture();
    const previous = statistics.read(session);
    session.model = undefined;
    setSnapshot({ ...previous, contextUsage: undefined });
    expect(statistics.refresh(session)).toBe(true);
    expect(statistics.read(session).contextUsage).toBeUndefined();
    expect(session.getContextUsage).not.toHaveBeenCalled();
  });

  it("supports older SDKs without context-in-stats or constant-time entry counts", () => {
    const { statistics, session } = fixture();
    const legacy = {
      ...session,
      sessionManager: { getLeafId: () => "entry-1" },
      getSessionStats: vi.fn(() => ({ tokens: statistics.read(session).tokens, cost: 2 })),
    } satisfies SessionStatisticsSource;
    statistics.initialize(legacy);
    expect(statistics.read(legacy)).toMatchObject({ cost: 2, contextUsage: { tokens: 15 } });
    expect(legacy.getContextUsage).toHaveBeenCalledTimes(1);
    expect(statistics.refresh(legacy)).toBe(true);
    expect(legacy.getSessionStats).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 10; i += 1) statistics.read(legacy);
    expect(legacy.getSessionStats).toHaveBeenCalledTimes(2);
  });

  it("retains the last successful snapshot and retries after calculation failure", () => {
    const { statistics, session, history } = fixture();
    const previous = statistics.read(session);
    history.count += 1;
    session.getSessionStats.mockImplementationOnce(() => { throw new Error("metrics failed"); });
    expect(() => statistics.refresh(session)).toThrow("metrics failed");
    expect(statistics.read(session)).toBe(previous);
    expect(statistics.refresh(session)).toBe(true);
    expect(statistics.refresh(session)).toBe(false);
  });

  it("reinitializes on binding even when the revision is unchanged", () => {
    const { statistics, session, setSnapshot } = fixture();
    setSnapshot({ ...statistics.read(session), cost: 4 });
    expect(statistics.read(session).cost).toBe(0.1);
    statistics.initialize(session);
    expect(statistics.read(session).cost).toBe(4);
    expect(session.getSessionStats).toHaveBeenCalledTimes(2);
  });
});
