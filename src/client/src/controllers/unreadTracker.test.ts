import { describe, expect, it, beforeEach } from "vitest";
import { UnreadTracker } from "./unreadTracker";
import type { KeyValueStorage } from "./sessionStorageMemory";

function createStorage(): { storage: KeyValueStorage } {
  const data: Record<string, string> = {};
  const storage: KeyValueStorage = {
    getItem(key: string) { return data[key] ?? null; },
    setItem(key: string, value: string) { data[key] = value; },
    removeItem(key: string) { data[key] = ""; },
  };
  return { storage };
}

describe("UnreadTracker", () => {
  let tracker: UnreadTracker;

  beforeEach(() => {
    tracker = new UnreadTracker(createStorage().storage);
  });

  it("treats sessions with no read record and messages as unread", () => {
    expect(tracker.hasUnread("session-1", 5)).toBe(true);
  });

  it("treats sessions with no read record and zero messages as read", () => {
    expect(tracker.hasUnread("session-1", 0)).toBe(false);
  });

  it("marks a session as read and reports no unread at the same count", () => {
    tracker.markAsRead("session-1", 5);
    expect(tracker.hasUnread("session-1", 5)).toBe(false);
  });

  it("reports unread when message count exceeds last-read count", () => {
    tracker.markAsRead("session-1", 3);
    expect(tracker.hasUnread("session-1", 5)).toBe(true);
  });

  it("updates last-read count on successive markAsRead calls", () => {
    tracker.markAsRead("session-1", 3);
    tracker.markAsRead("session-1", 5);
    expect(tracker.hasUnread("session-1", 5)).toBe(false);
    expect(tracker.hasUnread("session-1", 7)).toBe(true);
  });

  it("ignores negative message counts in markAsRead", () => {
    tracker.markAsRead("session-1", -1);
    expect(tracker.hasUnread("session-1", 5)).toBe(true);
  });

  it("clears tracking for a specific session", () => {
    tracker.markAsRead("session-1", 10);
    tracker.clearForSession("session-1");
    expect(tracker.hasUnread("session-1", 10)).toBe(true); // no record → treated as unread
    expect(tracker.hasUnread("session-1", 0)).toBe(false);
  });

  it("tracks multiple sessions independently", () => {
    tracker.markAsRead("s1", 3);
    tracker.markAsRead("s2", 10);
    expect(tracker.hasUnread("s1", 5)).toBe(true);
    expect(tracker.hasUnread("s2", 10)).toBe(false);
  });

  it("persists across instances via sessionStorage", () => {
    const { storage } = createStorage();
    const t1 = new UnreadTracker(storage);
    t1.markAsRead("session-1", 5);

    const t2 = new UnreadTracker(storage);
    expect(t2.hasUnread("session-1", 5)).toBe(false);
    expect(t2.hasUnread("session-1", 7)).toBe(true);
  });
});