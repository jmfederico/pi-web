import { describe, expect, it } from "vitest";
import { DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT, TranscriptBranchCache, type TranscriptBranchSnapshot } from "./transcriptBranchCache.js";

describe("TranscriptBranchCache", () => {
  it("returns the memoized snapshot while the file signature matches", () => {
    const cache = new TranscriptBranchCache({ limit: 2 });
    const snapshot = snapshotOf("sig-1", [{ id: "m1" }]);
    cache.set("/sessions/a.jsonl", snapshot);

    expect(cache.get("/sessions/a.jsonl", "sig-1")).toBe(snapshot);
  });

  it("misses unknown paths and stale signatures", () => {
    const cache = new TranscriptBranchCache({ limit: 2 });
    cache.set("/sessions/a.jsonl", snapshotOf("sig-1", [{ id: "m1" }]));

    expect(cache.get("/sessions/missing.jsonl", "sig-1")).toBeUndefined();
    expect(cache.get("/sessions/a.jsonl", "sig-2")).toBeUndefined();
  });

  it("replaces the memoized snapshot when a new signature is stored", () => {
    const cache = new TranscriptBranchCache({ limit: 2 });
    cache.set("/sessions/a.jsonl", snapshotOf("sig-1", [{ id: "m1" }]));
    const updated = snapshotOf("sig-2", [{ id: "m1" }, { id: "m2" }]);
    cache.set("/sessions/a.jsonl", updated);

    expect(cache.get("/sessions/a.jsonl", "sig-2")).toBe(updated);
    expect(cache.get("/sessions/a.jsonl", "sig-1")).toBeUndefined();
  });

  it("hands out the latest snapshot for append extension regardless of signature", () => {
    const cache = new TranscriptBranchCache({ limit: 2 });
    cache.set("/sessions/a.jsonl", snapshotOf("sig-1", [{ id: "m1" }]));

    expect(cache.getLatest("/sessions/a.jsonl")).toMatchObject({ signature: "sig-1" });
    expect(cache.getLatest("/sessions/missing.jsonl")).toBeUndefined();
  });

  it("treats an append-extension lookup as recent use", () => {
    // A session polled every few seconds is extended through getLatest; those
    // lookups must count as use or one-off reads of other sessions would
    // evict the actively polled snapshot.
    const cache = new TranscriptBranchCache({ limit: 2 });
    cache.set("/sessions/polled.jsonl", snapshotOf("sig-1", ["polled"]));
    cache.set("/sessions/other.jsonl", snapshotOf("sig", ["other"]));

    expect(cache.getLatest("/sessions/polled.jsonl")).toBeDefined();
    cache.set("/sessions/third.jsonl", snapshotOf("sig", ["third"]));

    expect(cache.getLatest("/sessions/polled.jsonl")).toBeDefined();
    expect(cache.get("/sessions/other.jsonl", "sig")).toBeUndefined();
  });

  it("evicts the least recently used entry beyond the limit", () => {
    const cache = new TranscriptBranchCache({ limit: 2 });
    cache.set("/sessions/a.jsonl", snapshotOf("sig", ["a"]));
    cache.set("/sessions/b.jsonl", snapshotOf("sig", ["b"]));
    cache.set("/sessions/c.jsonl", snapshotOf("sig", ["c"]));

    expect(cache.get("/sessions/a.jsonl", "sig")).toBeUndefined();
    expect(cache.get("/sessions/b.jsonl", "sig")?.branch).toEqual(["b"]);
    expect(cache.get("/sessions/c.jsonl", "sig")?.branch).toEqual(["c"]);
  });

  it("keeps a recently read entry when other sessions churn through the bound", () => {
    // The steady-state shape this cache exists for: one session polled every
    // few seconds must stay memoized while one-off reads of other sessions
    // pass through the same bound.
    const cache = new TranscriptBranchCache({ limit: 2 });
    cache.set("/sessions/polled.jsonl", snapshotOf("sig", ["polled"]));
    cache.set("/sessions/other.jsonl", snapshotOf("sig", ["other"]));

    expect(cache.get("/sessions/polled.jsonl", "sig")?.branch).toEqual(["polled"]);
    cache.set("/sessions/third.jsonl", snapshotOf("sig", ["third"]));

    expect(cache.get("/sessions/polled.jsonl", "sig")?.branch).toEqual(["polled"]);
    expect(cache.get("/sessions/other.jsonl", "sig")).toBeUndefined();
  });

  it("treats a re-stored entry as recently used", () => {
    const cache = new TranscriptBranchCache({ limit: 2 });
    cache.set("/sessions/a.jsonl", snapshotOf("sig-1", ["a"]));
    cache.set("/sessions/b.jsonl", snapshotOf("sig", ["b"]));
    // A grew on disk and was re-parsed: storing the fresh snapshot must count
    // as use, so the next insert evicts b, not a.
    cache.set("/sessions/a.jsonl", snapshotOf("sig-2", ["a", "a2"]));
    cache.set("/sessions/c.jsonl", snapshotOf("sig", ["c"]));

    expect(cache.get("/sessions/a.jsonl", "sig-2")?.branch).toEqual(["a", "a2"]);
    expect(cache.get("/sessions/b.jsonl", "sig")).toBeUndefined();
  });

  it("bounds growth at the default limit", () => {
    const cache = new TranscriptBranchCache();
    for (let i = 0; i < DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT + 5; i += 1) {
      cache.set(`/sessions/s${String(i)}.jsonl`, snapshotOf("sig", [i]));
    }

    expect(cache.get("/sessions/s0.jsonl", "sig")).toBeUndefined();
    expect(cache.get("/sessions/s4.jsonl", "sig")).toBeUndefined();
    expect(cache.get("/sessions/s5.jsonl", "sig")?.branch).toEqual([5]);
    expect(cache.get(`/sessions/s${String(DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT + 4)}.jsonl`, "sig")?.branch).toEqual([DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT + 4]);
  });
});

function snapshotOf(signature: string, branch: unknown[]): TranscriptBranchSnapshot {
  return { signature, identity: "1:1", size: 1, entries: [], branch };
}
