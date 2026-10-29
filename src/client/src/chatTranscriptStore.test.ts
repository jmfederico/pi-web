import { describe, expect, it, vi } from "vitest";
import { ChatTranscriptStore, type ChatHistoryCacheAdapter } from "./chatTranscriptStore";
import type { RawMessagePage } from "./chatHistoryCache";

class MemoryChatHistoryCache implements ChatHistoryCacheAdapter {
  readonly pages = new Map<string, RawMessagePage>();

  read(sessionId: string): RawMessagePage | undefined {
    return this.pages.get(sessionId);
  }

  write(sessionId: string, page: RawMessagePage): void {
    this.pages.set(sessionId, page);
  }
}

function page(start: number, total: number, messages: unknown[]): RawMessagePage {
  return { start, total, messages };
}

describe("ChatTranscriptStore", () => {
  it("evicts the least recently read session and rehydrates it from the cache", () => {
    const cache = new MemoryChatHistoryCache();
    const store = new ChatTranscriptStore(cache, { maxSessions: 2, maxBytes: 100_000 });
    const read = vi.spyOn(cache, "read");
    store.mergeHistory("a", page(0, 1, [{ role: "user", content: "a" }]));
    store.mergeHistory("b", page(0, 1, [{ role: "user", content: "b" }]));
    store.cachedView("a");
    store.mergeHistory("c", page(0, 1, [{ role: "user", content: "c" }]));
    read.mockClear();

    store.rawHistoryPage("a");
    expect(read).not.toHaveBeenCalled();
    expect(store.cachedView("b").messages[0]?.parts).toEqual([{ type: "text", text: "b" }]);
    expect(read).toHaveBeenCalledExactlyOnceWith("b");
    expect(store.historyRevision("b")).toBe(0);
  });

  it("evicts by byte budget but keeps a single oversized page whole", () => {
    const cache = new MemoryChatHistoryCache();
    const store = new ChatTranscriptStore(cache, { maxSessions: 8, maxBytes: 1000 });
    const read = vi.spyOn(cache, "read");
    store.mergeHistory("a", page(0, 1, [{ role: "user", content: "small" }]));
    const large = page(20, 23, Array.from({ length: 3 }, () => ({ role: "user", content: "x".repeat(1000) })));
    const view = store.mergeHistory("b", large);
    read.mockClear();

    expect(store.rawHistoryPage("b")).toBe(large);
    expect(store.cachedView("b")).toBe(view);
    expect(view.messagePageStart).toBe(20);
    expect(view.messages).toHaveLength(3);
    expect(read).not.toHaveBeenCalled();
    store.rawHistoryPage("a");
    expect(read).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("reuses normalization for an unchanged raw page and invalidates it after replacement or discard", () => {
    const cache = new MemoryChatHistoryCache();
    const store = new ChatTranscriptStore(cache);
    const first = store.mergeHistory("s1", page(0, 1, [{ role: "user", content: "before" }]));
    expect(store.cachedView("s1")).toBe(first);
    const second = store.mergeHistory("s1", page(0, 1, [{ role: "user", content: "after" }]));
    expect(second.messages).not.toBe(first.messages);
    expect(second.messages[0]?.parts).toEqual([{ type: "text", text: "after" }]);
    expect(store.cachedView("s1")).toBe(second);

    store.discard("s1");
    cache.pages.delete("s1");
    expect(store.cachedView("s1").messages).toEqual([]);
    expect(store.historyRevision("s1")).toBe(1);
  });
  it("hydrates a visible transcript from cached raw history", () => {
    const cache = new MemoryChatHistoryCache();
    cache.write("s1", page(0, 2, [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]));

    expect(new ChatTranscriptStore(cache).cachedView("s1")).toEqual({
      messages: [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        { role: "assistant", parts: [{ type: "text", text: "hello" }] },
      ],
      messagePageStart: 0,
      messagePageEnd: 2,
      messagePageTotal: 2,
    });
  });

  it("replaces incompatible cached snapshots even when the cache adapter cannot remove entries", () => {
    const cache = new MemoryChatHistoryCache();
    cache.write("s1", page(1, 4, [
      { role: "user", content: "old-a" }, { role: "assistant", content: "old-b" }, { role: "user", content: "old-c" },
    ]));
    const store = new ChatTranscriptStore(cache);
    const current = page(1, 3, [{ role: "user", content: "new-a" }, { role: "assistant", content: "new-b" }]);

    const view = store.mergeSnapshot("s1", current);

    expect(view.messagePageTotal).toBe(3);
    expect(store.rawHistoryPage("s1")).toEqual(current);
    expect(cache.read("s1")).toEqual(current);
    expect(store.historyRevision("s1")).toBe(1);
  });

  it("tracks the raw page end separately from normalized display messages", () => {
    const store = new ChatTranscriptStore(new MemoryChatHistoryCache());

    const view = store.mergeHistory("s1", page(0, 3, [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "src/app.ts" } }] },
      { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "ok" }] },
    ]));

    expect(view.messages).toHaveLength(2);
    expect(view.messagePageStart).toBe(0);
    expect(view.messagePageEnd).toBe(3);
    expect(view.messagePageTotal).toBe(3);
  });

  it("keeps live streamed transcript state out of the raw history cache", () => {
    const cache = new MemoryChatHistoryCache();
    const store = new ChatTranscriptStore(cache);
    const initial = page(0, 2, [{ role: "user", content: "hi" }, { role: "assistant", content: "hel" }]);
    const updated = page(1, 3, [{ role: "assistant", content: "hello" }, { role: "user", content: "next" }]);

    let visible = store.mergeHistory("s1", initial).messages;
    visible = store.applyLiveEvent(visible, { type: "assistant.delta", text: "lo" }) ?? visible;

    expect(visible.at(-1)).toEqual({ role: "assistant", parts: [{ type: "text", text: "hello" }] });
    expect(cache.read("s1")?.messages).toEqual(initial.messages);
    expect(store.mergeHistory("s1", updated)).toEqual({
      messages: [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        { role: "assistant", parts: [{ type: "text", text: "hello" }] },
        { role: "user", parts: [{ type: "text", text: "next" }] },
      ],
      messagePageStart: 0,
      messagePageEnd: 3,
      messagePageTotal: 3,
    });
  });
});
