import { describe, expect, it } from "vitest";
import { isHistoryTailSlice, mergeChatHistory, type RawMessagePage } from "./chatHistoryCache";

function page(start: number, total: number, messages: unknown[]): RawMessagePage {
  return { start, total, messages };
}

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
