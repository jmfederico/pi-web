import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canMergeHistorySnapshot, isHistoryTailSlice, mergeChatHistory, readChatHistoryCache, writeChatHistoryCache, type RawMessagePage } from "./chatHistoryCache";
import { ChatTranscriptStore } from "./chatTranscriptStore";

function page(start: number, total: number, messages: unknown[]): RawMessagePage {
  return { start, total, messages };
}

describe("persisted chat history", () => {
  beforeEach(() => {
    const entries = new Map<string, string>();
    const storage: Storage = {
      get length() { return entries.size; },
      clear: () => { entries.clear(); },
      getItem: (key) => entries.get(key) ?? null,
      key: (index) => [...entries.keys()][index] ?? null,
      removeItem: (key) => { entries.delete(key); },
      setItem: (key, value) => { entries.set(key, value); },
    };
    vi.stubGlobal("sessionStorage", storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("persists a recent suffix without truncating the in-memory older reading range", () => {
    const store = new ChatTranscriptStore();
    const messages = Array.from({ length: 125 }, (_, index) => ({ role: "user", content: String(index) }));
    store.mergeHistory("s1", page(50, 200, messages));

    expect(readChatHistoryCache("s1")).toEqual(page(75, 200, messages.slice(25)));
    expect(store.rawHistoryPage("s1")).toEqual(page(50, 200, messages));
    expect(store.cachedView("s1").messages).toHaveLength(125);
  });

  it("bounds bytes as well as message count and removes stale data when the newest message cannot fit", () => {
    const large = { role: "user", content: "x".repeat(70_000) };
    writeChatHistoryCache("s1", page(5, 7, [large, large]));
    expect(readChatHistoryCache("s1")).toEqual(page(6, 7, [large]));
    expect((sessionStorage.getItem(sessionStorage.key(0) ?? "")?.length ?? 0) * 2).toBeLessThanOrEqual(256 * 1024);

    writeChatHistoryCache("s1", page(6, 7, [{ role: "user", content: "x".repeat(140_000) }]));
    expect(readChatHistoryCache("s1")).toBeUndefined();
    expect(sessionStorage.length).toBe(0);
  });

  it("retains only eight recently written sessions without touching unrelated storage", () => {
    vi.useFakeTimers();
    sessionStorage.setItem("unrelated", "keep");
    for (let index = 0; index < 8; index += 1) {
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, index));
      writeChatHistoryCache(String(index), page(0, 1, ["message"]));
    }
    vi.setSystemTime(new Date(2026, 0, 1, 0, 1));
    writeChatHistoryCache("0", page(0, 1, ["refreshed"]));
    writeChatHistoryCache("8", page(0, 1, ["new"]));

    expect(readChatHistoryCache("1")).toBeUndefined();
    expect(readChatHistoryCache("0")?.messages).toEqual(["refreshed"]);
    expect(sessionStorage.length).toBe(9);
    expect(sessionStorage.getItem("unrelated")).toBe("keep");
  });

  it("treats oversized legacy entries and expired entries as cache misses", () => {
    vi.useFakeTimers();
    writeChatHistoryCache("s1", page(0, 1, ["old"]));
    const key = sessionStorage.key(0) ?? "";
    sessionStorage.setItem(key, JSON.stringify({ start: 0, total: 1, messages: ["x".repeat(140_000)], savedAt: Date.now() }));
    expect(readChatHistoryCache("s1")).toBeUndefined();
    expect(sessionStorage.length).toBe(0);

    writeChatHistoryCache("s1", page(0, 1, ["old"]));
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(readChatHistoryCache("s1")).toBeUndefined();
  });
});

describe("mergeChatHistory", () => {
  it("merges adjacent cached and incoming pages", () => {
    const merged = mergeChatHistory(page(2, 5, ["c", "d", "e"]), page(0, 5, ["a", "b"]));

    expect(merged).toEqual(page(0, 5, ["a", "b", "c", "d", "e"]));
  });

  it("keeps cached history when new messages were appended", () => {
    const existing = page(0, 3, ["a", "b", "c"]);
    const incoming = page(1, 4, ["b", "c", "d"]);

    expect(mergeChatHistory(existing, incoming)).toEqual(page(0, 4, ["a", "b", "c", "d"]));
  });

  it("uses incoming history when a complete cached history shrinks", () => {
    const incoming = page(0, 2, ["fresh-a", "fresh-b"]);

    expect(mergeChatHistory(page(0, 3, ["stale-a", "stale-b", "stale-c"]), incoming)).toEqual(incoming);
  });

  it("keeps adjacent cached history when an older page reports a lower total", () => {
    const existing = page(100, 200, ["newer-a", "newer-b"]);
    const incoming = page(98, 150, ["older-a", "older-b"]);

    expect(mergeChatHistory(existing, incoming)).toEqual(page(98, 200, ["older-a", "older-b", "newer-a", "newer-b"]));
  });

  it("uses incoming history instead of creating a gapped page", () => {
    const incoming = page(8, 10, ["i", "j"]);

    expect(mergeChatHistory(page(0, 10, ["a", "b"]), incoming)).toEqual(incoming);
  });

  it("uses incoming history when cached history contains normalized chat lines", () => {
    const incoming = page(0, 2, [{ role: "user", content: "fresh" }, { role: "assistant", content: "answer" }]);
    const normalizedLine = { role: "assistant", parts: [{ type: "text", text: "duplicated display line" }] };

    expect(mergeChatHistory(page(0, 2, [incoming.messages[0], normalizedLine]), incoming)).toEqual(incoming);
  });

  it("uses incoming history when cached history is longer than its raw range", () => {
    const incoming = page(0, 2, ["fresh-a", "fresh-b"]);

    expect(mergeChatHistory(page(0, 2, ["stale-a", "stale-b", "stale-c"]), incoming)).toEqual(incoming);
  });
});

describe("canMergeHistorySnapshot", () => {
  it("retains previously loaded pages when the snapshot overlaps the same growing history", () => {
    expect(canMergeHistorySnapshot(page(0, 3, ["a", "b", "c"]), page(2, 4, ["c", "d"]))).toBe(true);
  });

  it("replaces a partial cache when the authoritative total shrinks, even with matching overlap", () => {
    expect(canMergeHistorySnapshot(page(2, 8, ["c", "d", "e", "f", "g", "h"]), page(3, 6, ["d", "e", "f"]))).toBe(false);
  });

  it.each([6, 7])("rejects a different branch with a non-decreasing total (%s)", (total) => {
    const snapshot = page(4, total, Array.from({ length: total - 4 }, (_, index) => `new-${String(index)}`));
    expect(canMergeHistorySnapshot(page(2, 6, ["c", "d", "old-e", "old-f"]), snapshot)).toBe(false);
  });

  it("does not infer branch continuity from adjacent non-overlapping pages", () => {
    expect(canMergeHistorySnapshot(page(0, 2, ["a", "b"]), page(2, 4, ["c", "d"]))).toBe(false);
  });

  it("can merge an empty cache without needing an overlap", () => {
    expect(canMergeHistorySnapshot(page(0, 0, []), page(0, 0, []))).toBe(true);
    expect(canMergeHistorySnapshot(page(0, 0, []), page(2, 4, ["c", "d"]))).toBe(true);
  });

  it("does not trust an invalid cached raw range", () => {
    expect(canMergeHistorySnapshot(page(0, 1, ["a", "b"]), page(0, 2, ["a", "b"]))).toBe(false);
  });
});

describe("isHistoryTailSlice", () => {
  it("holds when the page is exactly the held history", () => {
    expect(isHistoryTailSlice(page(0, 2, ["a", "b"]), page(0, 2, ["a", "b"]))).toBe(true);
  });

  it("holds when the page is the tail of a history extended backwards", () => {
    expect(isHistoryTailSlice(page(0, 5, ["a", "b", "c", "d", "e"]), page(2, 5, ["c", "d", "e"]))).toBe(true);
  });

  it("holds for an empty history and an empty page", () => {
    expect(isHistoryTailSlice(page(0, 0, []), page(0, 0, []))).toBe(true);
  });

  it("does not hold without held history", () => {
    expect(isHistoryTailSlice(undefined, page(0, 0, []))).toBe(false);
  });

  it("does not hold when the transcript grew, even where the pages overlap", () => {
    expect(isHistoryTailSlice(page(0, 2, ["a", "b"]), page(0, 3, ["a", "b", "c"]))).toBe(false);
  });

  it("does not hold when the total shrank", () => {
    expect(isHistoryTailSlice(page(0, 3, ["a", "b", "c"]), page(1, 2, ["b", "c"]))).toBe(false);
  });

  it("does not hold when tail content differs", () => {
    expect(isHistoryTailSlice(page(0, 2, ["a", "b"]), page(0, 2, ["a", "edited"]))).toBe(false);
  });

  it("does not hold when the page reaches before the held history", () => {
    expect(isHistoryTailSlice(page(2, 5, ["c", "d", "e"]), page(0, 5, ["a", "b"]))).toBe(false);
  });

  it("does not hold for a page that is not a valid raw message page", () => {
    const normalizedLine = { role: "assistant", parts: [{ type: "text", text: "display line" }] };
    expect(isHistoryTailSlice(page(0, 1, ["a"]), page(0, 1, [normalizedLine]))).toBe(false);
  });
});
