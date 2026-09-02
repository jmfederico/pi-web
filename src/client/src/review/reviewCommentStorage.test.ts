import { describe, expect, it } from "vitest";
import { clearComments, loadComments, moveComments, saveComments } from "./reviewCommentStorage";
import type { ReviewComment } from "./reviewTypes";

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
  raw(key: string): string | null {
    return this.getItem(key);
  }
}

function comment(id: string): ReviewComment {
  return {
    id,
    anchor: { filePath: "src/app.ts", range: { side: "new", start: 1, end: 2 } },
    body: "note",
    createdAt: 1,
    updatedAt: 1,
    sourceHash: "abc",
  };
}

describe("reviewCommentStorage", () => {
  it("round-trips comments", () => {
    const storage = new MemoryStorage();
    saveComments("local:s1", [comment("a"), comment("b")], storage);
    expect(loadComments("local:s1", storage).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("returns empty for missing/empty keys", () => {
    const storage = new MemoryStorage();
    expect(loadComments("local:none", storage)).toEqual([]);
  });

  it("isolates by session key", () => {
    const storage = new MemoryStorage();
    saveComments("local:s1", [comment("a")], storage);
    expect(loadComments("local:s2", storage)).toEqual([]);
  });

  it("removes the entry when saving an empty list", () => {
    const storage = new MemoryStorage();
    saveComments("local:s1", [comment("a")], storage);
    saveComments("local:s1", [], storage);
    expect(storage.raw("pi-web:review-comments:local:s1")).toBeNull();
  });

  it("clears comments", () => {
    const storage = new MemoryStorage();
    saveComments("local:s1", [comment("a")], storage);
    clearComments("local:s1", storage);
    expect(loadComments("local:s1", storage)).toEqual([]);
  });

  it("moves comments to a new key and clears the old", () => {
    const storage = new MemoryStorage();
    saveComments("local:old", [comment("a")], storage);
    moveComments("local:old", "local:new", storage);
    expect(loadComments("local:old", storage)).toEqual([]);
    expect(loadComments("local:new", storage).map((entry) => entry.id)).toEqual(["a"]);
  });

  it("ignores a wrong version", () => {
    const storage = new MemoryStorage();
    storage.setItem("pi-web:review-comments:local:s1", JSON.stringify({ version: 999, comments: [comment("a")] }));
    expect(loadComments("local:s1", storage)).toEqual([]);
  });

  it("survives corrupt data", () => {
    const storage = new MemoryStorage();
    storage.setItem("pi-web:review-comments:local:s1", "{not json");
    expect(loadComments("local:s1", storage)).toEqual([]);
  });

  it("drops malformed comment records", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "pi-web:review-comments:local:s1",
      JSON.stringify({ version: 1, comments: [comment("a"), { id: "bad" }] }),
    );
    expect(loadComments("local:s1", storage).map((entry) => entry.id)).toEqual(["a"]);
  });
});
