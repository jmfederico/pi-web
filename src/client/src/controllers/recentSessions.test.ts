import { describe, expect, it, beforeEach } from "vitest";
import { RecentSessionsStore } from "./recentSessions";
import type { KeyValueStorage } from "./sessionStorageMemory";

function createStorage(): { storage: KeyValueStorage; data: Record<string, string> } {
  const data: Record<string, string> = {};
  const storage: KeyValueStorage = {
    getItem(key: string) { return data[key] ?? null; },
    setItem(key: string, value: string) { data[key] = value; },
    removeItem(key: string) { data[key] = ""; },
  };
  return { storage, data };
}

describe("RecentSessionsStore", () => {
  let store: RecentSessionsStore;
  const cwd = "machine1:/workspace";
  const otherCwd = "machine1:/other";

  beforeEach(() => {
    store = new RecentSessionsStore(3, createStorage().storage);
  });

  it("starts empty", () => {
    expect(store.getRecent(cwd)).toEqual([]);
  });

  it("records a session access and returns it as most recent", () => {
    store.recordAccess(cwd, "session-1");
    const recent = store.getRecent(cwd);
    expect(recent.length).toBe(1);
    const [entry] = recent;
    if (entry === undefined) throw new Error("Expected an entry");
    expect(entry.sessionId).toBe("session-1");
    expect(typeof entry.accessedAt).toBe("number");
  });

  it("records multiple accesses in recency order (most recent first)", () => {
    store.recordAccess(cwd, "session-1");
    store.recordAccess(cwd, "session-2");
    store.recordAccess(cwd, "session-3");
    expect(store.getRecent(cwd).map((e) => e.sessionId)).toEqual(["session-3", "session-2", "session-1"]);
  });

  it("moves re-accessed sessions to the front", () => {
    store.recordAccess(cwd, "session-1");
    store.recordAccess(cwd, "session-2");
    store.recordAccess(cwd, "session-1");
    expect(store.getRecent(cwd).map((e) => e.sessionId)).toEqual(["session-1", "session-2"]);
  });

  it("caps at maxEntries", () => {
    store.recordAccess(cwd, "session-1");
    store.recordAccess(cwd, "session-2");
    store.recordAccess(cwd, "session-3");
    store.recordAccess(cwd, "session-4");
    expect(store.getRecent(cwd).map((e) => e.sessionId)).toEqual(["session-4", "session-3", "session-2"]);
  });

  it("scopes entries by cwd", () => {
    store.recordAccess(cwd, "session-1");
    store.recordAccess(otherCwd, "session-2");
    expect(store.getRecent(cwd).map((e) => e.sessionId)).toEqual(["session-1"]);
    expect(store.getRecent(otherCwd).map((e) => e.sessionId)).toEqual(["session-2"]);
  });

  it("removes a specific session", () => {
    store.recordAccess(cwd, "session-1");
    store.recordAccess(cwd, "session-2");
    store.removeSession(cwd, "session-1");
    expect(store.getRecent(cwd).map((e) => e.sessionId)).toEqual(["session-2"]);
  });

  it("removing the last session clears the entry", () => {
    store.recordAccess(cwd, "session-1");
    store.removeSession(cwd, "session-1");
    expect(store.getRecent(cwd)).toEqual([]);
  });

  it("removeSession is a no-op for unknown session ids", () => {
    store.recordAccess(cwd, "session-1");
    store.removeSession(cwd, "unknown");
    expect(store.getRecent(cwd).map((e) => e.sessionId)).toEqual(["session-1"]);
  });

  it("forgets an entire workspace", () => {
    store.recordAccess(cwd, "session-1");
    store.recordAccess(otherCwd, "session-2");
    store.forgetWorkspace(cwd);
    expect(store.getRecent(cwd)).toEqual([]);
    expect(store.getRecent(otherCwd).map((e) => e.sessionId)).toEqual(["session-2"]);
  });

  it("persists across store instances via sessionStorage", () => {
    const { storage } = createStorage();
    const store1 = new RecentSessionsStore(3, storage);
    store1.recordAccess(cwd, "session-1");

    const store2 = new RecentSessionsStore(3, storage);
    expect(store2.getRecent(cwd).map((e) => e.sessionId)).toEqual(["session-1"]);
  });

  it("respects custom maxEntries", () => {
    const store5 = new RecentSessionsStore(5, createStorage().storage);
    store5.recordAccess(cwd, "s1");
    store5.recordAccess(cwd, "s2");
    store5.recordAccess(cwd, "s3");
    store5.recordAccess(cwd, "s4");
    store5.recordAccess(cwd, "s5");
    expect(store5.getRecent(cwd).length).toBe(5);
  });
});