import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./api";
import { forgetCachedNewSession, isCachedNewSessionInfo, loadCachedNewSessions, mergeCachedNewSessions, rememberCachedNewSession } from "./cachedNewSessions";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const baseSession: SessionInfo = {
  id: "session-1",
  path: "/tmp/session-1.jsonl",
  cwd: "/repo",
  created: "2026-05-15T00:00:00.000Z",
  modified: "2026-05-15T00:00:00.000Z",
  messageCount: 0,
  firstMessage: "",
};

describe("cached new sessions", () => {
  it("stores and reloads new sessions with a browser-cache marker", () => {
    const storage = new MemoryStorage();

    rememberCachedNewSession(baseSession, "local", storage);

    const cached = loadCachedNewSessions(storage);
    expect(cached).toHaveLength(1);
    expect(cached[0]?.id).toBe("session-1");
    expect(isCachedNewSessionInfo(cached[0])).toBe(true);
  });

  it("merges cached sessions for the selected cwd without duplicating server sessions", () => {
    const storage = new MemoryStorage();
    rememberCachedNewSession(baseSession, "local", storage);
    rememberCachedNewSession({ ...baseSession, id: "other", cwd: "/other" }, "local", storage);

    expect(mergeCachedNewSessions("/repo", [], "local", storage).map((session) => session.id)).toEqual(["session-1"]);
    expect(mergeCachedNewSessions("/repo", [baseSession], "local", storage).map((session) => session.id)).toEqual(["session-1"]);
    expect(isCachedNewSessionInfo(mergeCachedNewSessions("/repo", [baseSession], "local", storage)[0])).toBe(false);
    expect(loadCachedNewSessions(storage).map((session) => session.id)).toEqual(["other"]);
  });

  it("forgets cached sessions", () => {
    const storage = new MemoryStorage();
    rememberCachedNewSession(baseSession, "local", storage);

    forgetCachedNewSession("session-1", "local", storage);

    expect(loadCachedNewSessions(storage)).toEqual([]);
  });

  it("keeps browser-cached sessions scoped by machine", () => {
    const storage = new MemoryStorage();
    rememberCachedNewSession(baseSession, "local", storage);
    rememberCachedNewSession({ ...baseSession, id: "session-2" }, "remote", storage);

    expect(mergeCachedNewSessions("/repo", [], "local", storage).map((session) => session.id)).toEqual(["session-1"]);
    expect(mergeCachedNewSessions("/repo", [], "remote", storage).map((session) => session.id)).toEqual(["session-2"]);
  });
});
