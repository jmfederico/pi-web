import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../api";
import type { KeyValueStorage } from "./sessionStorageMemory";
import { InMemorySessionSelectionMemory, markSessionArchived, markSessionsArchived, selectPreferredSession, selectionAfterArchivingSession, selectionAfterArchivingSessions, SessionStorageSessionSelectionMemory, shouldDeselectAfterArchivedCollapse } from "./sessionSelection";

describe("selectPreferredSession", () => {
  it("prefers an explicit target session by id", () => {
    const sessions = [testSession("s1"), testSession("s2")];

    expect(selectPreferredSession(sessions, { targetSessionId: "s2", latestSessionId: "s1" })?.id).toBe("s2");
  });

  it.each([false, true])("rejects partial target IDs without falling back to a remembered session (archived: %s)", (archived) => {
    const session = { ...testSession("abcdef"), archived };

    for (const targetSessionId of ["abc", "abcde", "abcdefg", "ABCDEF"]) {
      expect(selectPreferredSession([session], { targetSessionId, latestSessionId: session.id })).toBeUndefined();
    }
  });

  it("selects an exact ID even when an earlier session shares that prefix", () => {
    const exact = testSession("abc");

    expect(selectPreferredSession([testSession("abcdef"), exact], { targetSessionId: "abc" })).toBe(exact);
  });

  it("remembers the latest selected session when no explicit target is provided", () => {
    const sessions = [testSession("s1"), testSession("s2")];

    expect(selectPreferredSession(sessions, { latestSessionId: "s2" })?.id).toBe("s2");
  });

  it("does not select an archived session without an explicit or remembered selection", () => {
    const sessions = [{ ...testSession("s1"), archived: true }];

    expect(selectPreferredSession(sessions)).toBeUndefined();
  });

  it("returns a remembered archived session before falling back to active sessions", () => {
    const sessions = [{ ...testSession("s1"), archived: true }, testSession("s2")];

    expect(selectPreferredSession(sessions, { latestSessionId: "s1" })?.id).toBe("s1");
  });

  it("falls back to the first active session when the remembered session no longer exists", () => {
    const sessions = [{ ...testSession("s1"), archived: true }, testSession("s2")];

    expect(selectPreferredSession(sessions, { latestSessionId: "old" })?.id).toBe("s2");
  });

  it("returns undefined for an invalid explicit target", () => {
    const sessions = [testSession("s1"), testSession("s2")];

    expect(selectPreferredSession(sessions, { targetSessionId: "old", latestSessionId: "s2" })).toBeUndefined();
  });
});

describe("InMemorySessionSelectionMemory", () => {
  it("remembers and forgets the latest selected session per cwd", () => {
    const memory = new InMemorySessionSelectionMemory();

    memory.rememberSession({ ...testSession("s1"), cwd: "/tmp/one" });
    memory.rememberSession({ ...testSession("s2"), cwd: "/tmp/two" });

    expect(memory.latestSessionId("/tmp/one")).toBe("s1");
    expect(memory.latestSessionId("/tmp/two")).toBe("s2");

    memory.forgetWorkspace("/tmp/one");

    expect(memory.latestSessionId("/tmp/one")).toBeUndefined();
    expect(memory.latestSessionId("/tmp/two")).toBe("s2");
  });
});

describe("SessionStorageSessionSelectionMemory", () => {
  it("persists the latest selected session per workspace cwd", () => {
    const storage = memoryStorage();
    const memory = new SessionStorageSessionSelectionMemory(storage);

    memory.rememberSession({ ...testSession("s1"), cwd: "local:/tmp/one" });
    memory.rememberSession({ ...testSession("s2"), cwd: "remote:/tmp/one" });

    const restored = new SessionStorageSessionSelectionMemory(storage);

    expect(restored.latestSessionId("local:/tmp/one")).toBe("s1");
    expect(restored.latestSessionId("remote:/tmp/one")).toBe("s2");

    restored.forgetWorkspace("local:/tmp/one");

    expect(new SessionStorageSessionSelectionMemory(storage).latestSessionId("local:/tmp/one")).toBeUndefined();
    expect(new SessionStorageSessionSelectionMemory(storage).latestSessionId("remote:/tmp/one")).toBe("s2");
  });
});

describe("markSessionArchived", () => {
  it("marks the matching session archived without mutating the original", () => {
    const sessions = [testSession("s1"), testSession("s2")];

    const next = markSessionArchived(sessions, "s1", "later");

    expect(next).toEqual([{ ...sessions[0], archived: true, archivedAt: "later" }, sessions[1]]);
    expect(sessions[0]?.archived).toBeUndefined();
  });

  it("marks multiple matching sessions archived", () => {
    const sessions = [testSession("s1"), testSession("s2"), testSession("s3")];

    const next = markSessionsArchived(sessions, ["s1", "s3"], "later");

    expect(next).toEqual([{ ...sessions[0], archived: true, archivedAt: "later" }, sessions[1], { ...sessions[2], archived: true, archivedAt: "later" }]);
  });
});

describe("shouldDeselectAfterArchivedCollapse", () => {
  it("deselects archived selections only when no active sessions remain", () => {
    const archived = { ...testSession("archived"), archived: true };
    const active = testSession("active");

    expect(shouldDeselectAfterArchivedCollapse([archived], archived)).toBe(true);
    expect(shouldDeselectAfterArchivedCollapse([archived, active], archived)).toBe(false);
    expect(shouldDeselectAfterArchivedCollapse([archived], undefined)).toBe(false);
    expect(shouldDeselectAfterArchivedCollapse([archived], active)).toBe(false);
  });
});

describe("selectionAfterArchivingSession", () => {
  it("leaves selection unchanged when archiving an unselected session", () => {
    expect(selectionAfterArchivingSession([testSession("s1"), testSession("s2")], "s1", "s2")).toEqual({ type: "unchanged" });
  });

  it("selects the first active session when archiving the selected session", () => {
    const s2 = testSession("s2");

    expect(selectionAfterArchivingSession([testSession("s1"), s2], "s1", "s1")).toEqual({ type: "select", session: s2 });
  });

  it("skips archived sessions when choosing the next selected session", () => {
    const s3 = testSession("s3");

    expect(selectionAfterArchivingSession([testSession("s1"), { ...testSession("s2"), archived: true }, s3], "s1", "s1")).toEqual({ type: "select", session: s3 });
  });

  it("clears selection when no active session remains", () => {
    expect(selectionAfterArchivingSession([testSession("s1")], "s1", "s1")).toEqual({ type: "clear" });
  });

  it("clears selection when archiving a selected subtree with no active sessions left", () => {
    expect(selectionAfterArchivingSessions([testSession("s1"), testSession("s2")], "s2", ["s1", "s2"])).toEqual({ type: "clear" });
  });
});

function testSession(id: string): SessionInfo {
  return { id, path: `/tmp/project/.pi/sessions/${id}`, cwd: "/tmp/project", created: "now", modified: "now", messageCount: 0, firstMessage: "" };
}

function memoryStorage(seed: Record<string, string> = {}): KeyValueStorage {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}
