import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionRef } from "../../../shared/apiTypes.js";
import { ompMessageEntry, writeOmpNestedArtifactSessionFile, writeOmpSessionFile } from "./ompSessionFixture.testSupport.js";
// `dependencies.createReadStream` is a test-only injection seam beyond the
// shared `OmpSessionStore` contract's literal constructor signature.
import { fromOmpSessionId, OmpSessionStore, toOmpSessionId } from "./ompSessionStore.js";

/** Builds a plausible-looking, valid-shaped native session UUID from an index, for tests needing many distinct sessions. */
function fakeUuid(index: number): string {
  return `01a08a3b-a686-727b-84fb-${index.toString(16).padStart(12, "0")}`;
}

const CWD = "/workspace/project";
const OTHER_CWD = "/workspace/other-project";
const VALID_ID = "01a08a3b-a686-727b-84fb-18a831987d12";
const OTHER_VALID_ID = "01a08a50-741d-73f7-af7c-1e7f1a77c37f";

let agentDir: string;
let sessionsRoot: string;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pi-web-omp-store-test-"));
  sessionsRoot = join(agentDir, "sessions");
});

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

/** Narrows a raw session entry down to its string `id`, for asserting branch/order contracts on `store.messages()`'s intentionally-`unknown[]` result. */
function entryId(entry: unknown): string {
  if (typeof entry !== "object" || entry === null || !("id" in entry) || typeof entry.id !== "string") {
    throw new Error("expected a session entry with a string id");
  }
  return entry.id;
}

/** Narrows a raw session entry down to its `type` discriminant, or undefined when absent/non-string. */
function entryType(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null || !("type" in entry) || typeof entry.type !== "string") return undefined;
  return entry.type;
}

/** Narrows a raw `message`-type entry down to its `message.content` array. */
function entryMessageContent(entry: unknown): unknown[] {
  if (typeof entry !== "object" || entry === null || !("message" in entry)) throw new Error("expected a message entry");
  const message = entry.message;
  if (typeof message !== "object" || message === null || !("content" in message) || !Array.isArray(message.content)) {
    throw new Error("expected message.content to be an array");
  }
  return message.content;
}

/** Writes a fixture blob into `<agentDir>/blobs/<hash>`, matching OMP's content-addressed blob store layout. */
async function writeOmpBlob(hash: string, bytes: Buffer): Promise<void> {
  const blobsDir = join(agentDir, "blobs");
  await mkdir(blobsDir, { recursive: true });
  await writeFile(join(blobsDir, hash), bytes);
}

/** Narrows a content array down to its image part's `data` field, for asserting blob-resolution outcomes. */
function imageContentData(content: unknown[]): string {
  for (const part of content) {
    if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "image") continue;
    if (!("data" in part) || typeof part.data !== "string") throw new Error("expected image content part to have a string data field");
    return part.data;
  }
  throw new Error("expected an image content part in the content array");
}

/** Narrows an unknown value to a plain object record — a real type-predicate guard, so callers get `Record<string, unknown>` narrowing without a cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Finds the first content-array part matching a predicate, for asserting blob resolution at a specific canonical position (image_generation_call.result, image_url). */
function findContentPart(content: unknown[], predicate: (part: Record<string, unknown>) => boolean): Record<string, unknown> {
  for (const part of content) {
    if (isRecord(part) && predicate(part)) return part;
  }
  throw new Error("expected a matching content part in the content array");
}

describe("toOmpSessionId / fromOmpSessionId", () => {
  it("round-trips a native uuid through the omp: prefix", () => {
    const externalId = toOmpSessionId(VALID_ID);
    expect(externalId).toBe(`omp:${VALID_ID}`);
    expect(fromOmpSessionId(externalId)).toBe(VALID_ID);
  });

  it("rejects an id missing the omp: prefix", () => {
    expect(() => fromOmpSessionId(VALID_ID)).toThrow();
  });

  it("rejects an omp: id whose remainder is not a valid uuid", () => {
    expect(() => fromOmpSessionId("omp:not-a-uuid")).toThrow();
  });

  it("rejects an omp: id with nothing after the prefix", () => {
    expect(() => fromOmpSessionId("omp:")).toThrow();
  });
});

describe("OmpSessionStore.list", () => {
  it("lists a matching-cwd session with an omp:-prefixed id", async () => {
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_a", {
      id: VALID_ID,
      cwd: CWD,
      entries: [ompMessageEntry({ id: "m1", parentId: null, role: "user", content: [{ type: "text", text: "hello" }] })],
    });
    const store = new OmpSessionStore(agentDir);

    const sessions = await store.list(CWD);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: toOmpSessionId(VALID_ID), cwd: CWD, messageCount: 1, firstMessage: "hello" });
  });

  it("does not trust the project directory name — matches purely on header.cwd", async () => {
    // Placed under a directory name that encodes an unrelated cwd; the header still says CWD.
    await writeOmpSessionFile(sessionsRoot, "-totally-unrelated-directory-name", "2026-01-01T00-00-00-000Z_a", {
      id: VALID_ID,
      cwd: CWD,
      entries: [],
    });
    const store = new OmpSessionStore(agentDir);

    const sessions = await store.list(CWD);

    expect(sessions.map((session) => session.id)).toEqual([toOmpSessionId(VALID_ID)]);
  });

  it("excludes sessions belonging to a different cwd stored in the same project directory", async () => {
    await writeOmpSessionFile(sessionsRoot, "-workspace-shared", "2026-01-01T00-00-00-000Z_mine", { id: VALID_ID, cwd: CWD, entries: [] });
    await writeOmpSessionFile(sessionsRoot, "-workspace-shared", "2026-01-01T00-00-01-000Z_theirs", { id: OTHER_VALID_ID, cwd: OTHER_CWD, entries: [] });
    const store = new OmpSessionStore(agentDir);

    const sessions = await store.list(CWD);

    expect(sessions.map((session) => session.id)).toEqual([toOmpSessionId(VALID_ID)]);
  });

  it("prefers a non-empty title-slot value over a stale header-embedded title", async () => {
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_a", {
      id: VALID_ID,
      cwd: CWD,
      headerTitle: "stale header title",
      titleSlot: { title: "current title", source: "user" },
      entries: [],
    });
    const store = new OmpSessionStore(agentDir);

    const [session] = await store.list(CWD);

    expect(session?.name).toBe("current title");
  });

  it("clears the title when the title-slot is explicitly empty, even with a stale header title present", async () => {
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_a", {
      id: VALID_ID,
      cwd: CWD,
      headerTitle: "stale header title",
      titleSlot: { title: "" },
      entries: [],
    });
    const store = new OmpSessionStore(agentDir);

    const [session] = await store.list(CWD);

    expect(session?.name).toBeUndefined();
  });

  it("falls back to the header-embedded title for a legacy file with no title-slot line", async () => {
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_a", {
      id: VALID_ID,
      cwd: CWD,
      headerTitle: "legacy title",
      entries: [],
    });
    const store = new OmpSessionStore(agentDir);

    const [session] = await store.list(CWD);

    expect(session?.name).toBe("legacy title");
  });

  it("skips a session file whose header id is not a valid uuid instead of failing the whole listing", async () => {
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_bad", { id: "not-a-uuid", cwd: CWD, entries: [] });
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-01-000Z_good", { id: VALID_ID, cwd: CWD, entries: [] });
    const store = new OmpSessionStore(agentDir);

    const sessions = await store.list(CWD);

    expect(sessions.map((session) => session.id)).toEqual([toOmpSessionId(VALID_ID)]);
  });

  it("does not descend into a session's own per-session artifact directory (subagent transcripts are not root sessions)", async () => {
    const rootPath = await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_root", { id: VALID_ID, cwd: CWD, entries: [] });
    // A subagent transcript with its own fully-valid v3 header, living inside
    // the root session's per-session artifact directory (same base name minus .jsonl).
    await writeOmpNestedArtifactSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_root", "SubagentName", {
      id: OTHER_VALID_ID,
      cwd: CWD,
      entries: [],
    });
    const store = new OmpSessionStore(agentDir);

    const sessions = await store.list(CWD);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: toOmpSessionId(VALID_ID), path: rootPath });
  });

  it("orders results newest-modified-first", async () => {
    const olderPath = await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_older", { id: VALID_ID, cwd: CWD, entries: [] });
    const newerPath = await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-01-000Z_newer", { id: OTHER_VALID_ID, cwd: CWD, entries: [] });
    // Set explicit, unambiguous mtimes instead of relying on real write-order
    // timing, which filesystems may coalesce to the same tick.
    await utimes(olderPath, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
    await utimes(newerPath, new Date("2026-01-02T00:00:00.000Z"), new Date("2026-01-02T00:00:00.000Z"));
    const store = new OmpSessionStore(agentDir);

    const sessions = await store.list(CWD);

    expect(sessions.map((session) => session.id)).toEqual([toOmpSessionId(OTHER_VALID_ID), toOmpSessionId(VALID_ID)]);
  });

  it("returns no sessions for a cwd with none, without throwing when the sessions directory is absent", async () => {
    const store = new OmpSessionStore(agentDir);

    await expect(store.list(CWD)).resolves.toEqual([]);
  });
});

describe("OmpSessionStore.resolve", () => {
  it("resolves a valid, matching ref to its file path and native id", async () => {
    const path = await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_a", { id: VALID_ID, cwd: CWD, entries: [] });
    const store = new OmpSessionStore(agentDir);
    const ref: SessionRef = { id: toOmpSessionId(VALID_ID), cwd: CWD };

    await expect(store.resolve(ref)).resolves.toEqual({ path, nativeId: VALID_ID });
  });

  it("rejects a ref id missing the omp: prefix", async () => {
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_a", { id: VALID_ID, cwd: CWD, entries: [] });
    const store = new OmpSessionStore(agentDir);

    await expect(store.resolve({ id: VALID_ID, cwd: CWD })).rejects.toThrow();
  });

  it("rejects a ref whose native id matches no session file", async () => {
    const store = new OmpSessionStore(agentDir);

    await expect(store.resolve({ id: toOmpSessionId(VALID_ID), cwd: CWD })).rejects.toThrow();
  });

  it("rejects a ref whose native id exists but under a different cwd (no cross-project resolution)", async () => {
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_a", { id: VALID_ID, cwd: OTHER_CWD, entries: [] });
    const store = new OmpSessionStore(agentDir);

    await expect(store.resolve({ id: toOmpSessionId(VALID_ID), cwd: CWD })).rejects.toThrow();
  });

  it("does not resolve into a nested per-session artifact directory", async () => {
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_root", { id: VALID_ID, cwd: CWD, entries: [] });
    await writeOmpNestedArtifactSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_root", "SubagentName", {
      id: OTHER_VALID_ID,
      cwd: CWD,
      entries: [],
    });
    const store = new OmpSessionStore(agentDir);

    await expect(store.resolve({ id: toOmpSessionId(OTHER_VALID_ID), cwd: CWD })).rejects.toThrow();
  });
});

describe("OmpSessionStore.messages", () => {
  it("returns only the active branch after a fork, excluding the abandoned branch's entries", async () => {
    // m1 -> m2 -> fork point (m3) -> { abandoned: m4 } and { active: m5 -> m6 }
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_a", {
      id: VALID_ID,
      cwd: CWD,
      entries: [
        ompMessageEntry({ id: "m1", parentId: null, role: "user", content: [{ type: "text", text: "one" }], timestamp: "2026-01-01T00:00:01.000Z" }),
        ompMessageEntry({ id: "m2", parentId: "m1", role: "assistant", content: [{ type: "text", text: "two" }], timestamp: "2026-01-01T00:00:02.000Z" }),
        ompMessageEntry({ id: "m3", parentId: "m2", role: "user", content: [{ type: "text", text: "three" }], timestamp: "2026-01-01T00:00:03.000Z" }),
        ompMessageEntry({ id: "m4-abandoned", parentId: "m3", role: "assistant", content: [{ type: "text", text: "abandoned reply" }], timestamp: "2026-01-01T00:00:04.000Z" }),
        ompMessageEntry({ id: "m5", parentId: "m3", role: "assistant", content: [{ type: "text", text: "active reply" }], timestamp: "2026-01-01T00:00:05.000Z" }),
        ompMessageEntry({ id: "m6", parentId: "m5", role: "user", content: [{ type: "text", text: "follow-up" }], timestamp: "2026-01-01T00:00:06.000Z" }),
      ],
    });
    const store = new OmpSessionStore(agentDir);

    const messages = await store.messages({ id: toOmpSessionId(VALID_ID), cwd: CWD });

    expect(messages.map(entryId)).toEqual(["m1", "m2", "m3", "m5", "m6"]);
  });

  it("orders returned entries chronologically, oldest first", async () => {
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_a", {
      id: VALID_ID,
      cwd: CWD,
      entries: [
        ompMessageEntry({ id: "m1", parentId: null, role: "user", content: [{ type: "text", text: "first" }], timestamp: "2026-01-01T00:00:01.000Z" }),
        ompMessageEntry({ id: "m2", parentId: "m1", role: "assistant", content: [{ type: "text", text: "second" }], timestamp: "2026-01-01T00:00:02.000Z" }),
      ],
    });
    const store = new OmpSessionStore(agentDir);

    const messages = await store.messages({ id: toOmpSessionId(VALID_ID), cwd: CWD });

    expect(messages.map(entryId)).toEqual(["m1", "m2"]);
  });

  it("excludes the header and title-slot pseudo-entries from the returned messages", async () => {
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_a", {
      id: VALID_ID,
      cwd: CWD,
      titleSlot: { title: "a title" },
      entries: [ompMessageEntry({ id: "m1", parentId: null, role: "user", content: [{ type: "text", text: "hi" }] })],
    });
    const store = new OmpSessionStore(agentDir);

    const messages = await store.messages({ id: toOmpSessionId(VALID_ID), cwd: CWD });

    expect(messages.map(entryType)).not.toContain("session");
    expect(messages.map(entryType)).not.toContain("title");
  });

  it("resolves an external image blob reference to inline base64 data", async () => {
    // Canonical behavior ported from the installed OMP package's own
    // resolveImageData (@oh-my-pi/pi-coding-agent session/blob-store.ts):
    // a blob:sha256:<hash> content-block reference is replaced with the
    // referenced bytes, base64-encoded, in the same `data` field.
    const hash = "c7b55d20afbcc04de989f6f91482e5d921f3d5372c154e69f49075a8556df8da";
    const bytes = Buffer.from("fake webp bytes for the fixture");
    await writeOmpBlob(hash, bytes);
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_a", {
      id: VALID_ID,
      cwd: CWD,
      entries: [
        ompMessageEntry({
          id: "m1",
          parentId: null,
          role: "toolResult",
          content: [{ type: "text", text: "see image" }, { type: "image", data: `blob:sha256:${hash}`, mimeType: "image/webp" }],
        }),
      ],
    });
    const store = new OmpSessionStore(agentDir);

    const [message] = await store.messages({ id: toOmpSessionId(VALID_ID), cwd: CWD });

    expect(imageContentData(entryMessageContent(message))).toBe(bytes.toString("base64"));
  });

  it("resolves an image_generation_call.result blob reference to inline base64 data", async () => {
    // Canonical resolvePersistedBlobRefs (session-loader.ts) resolves this
    // position through the same resolveImageData (base64) path as a content
    // image block, keyed off `type === "image_generation_call"` + `result`
    // instead of `type === "image"` + `data`.
    const hash = "05875064f03b0f68f28a06a9480003b40386d7e6b88a8b39778b0ac26c5581d6";
    const bytes = Buffer.from("fake generated image bytes");
    await writeOmpBlob(hash, bytes);
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_a", {
      id: VALID_ID,
      cwd: CWD,
      entries: [
        ompMessageEntry({
          id: "m1",
          parentId: null,
          role: "assistant",
          content: [{ type: "image_generation_call", result: `blob:sha256:${hash}` }],
        }),
      ],
    });
    const store = new OmpSessionStore(agentDir);

    const [message] = await store.messages({ id: toOmpSessionId(VALID_ID), cwd: CWD });
    const part = findContentPart(entryMessageContent(message), (candidate) => candidate["type"] === "image_generation_call");

    expect(part["result"]).toBe(bytes.toString("base64"));
  });

  it("resolves an image_url blob reference to its original UTF-8 string, not base64", async () => {
    // Canonical resolveImageDataUrl decodes as UTF-8: externalizeImageDataUrl
    // stores the ORIGINAL data-url string itself as UTF-8 bytes (unlike
    // image.data/image_generation_call.result, which store already-base64
    // image bytes), so restoring it is a UTF-8 decode, not a base64 one.
    const hash = "93dce6ac427f38888ebb11eece962cd414bf531bdaf301d70e51fcc2d649c677";
    const originalDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    await writeOmpBlob(hash, Buffer.from(originalDataUrl, "utf8"));
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_a", {
      id: VALID_ID,
      cwd: CWD,
      entries: [
        ompMessageEntry({
          id: "m1",
          parentId: null,
          role: "assistant",
          content: [{ type: "image_url", image_url: `blob:sha256:${hash}` }],
        }),
      ],
    });
    const store = new OmpSessionStore(agentDir);

    const [message] = await store.messages({ id: toOmpSessionId(VALID_ID), cwd: CWD });
    const part = findContentPart(entryMessageContent(message), (candidate) => "image_url" in candidate);

    expect(part["image_url"]).toBe(originalDataUrl);
  });

  it("leaves a blob reference unchanged when the referenced blob file is missing, instead of throwing", async () => {
    const missingHash = "a".repeat(64);
    const ref = `blob:sha256:${missingHash}`;
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_a", {
      id: VALID_ID,
      cwd: CWD,
      entries: [ompMessageEntry({ id: "m1", parentId: null, role: "toolResult", content: [{ type: "text", text: "see image" }, { type: "image", data: ref, mimeType: "image/webp" }] })],
    });
    const store = new OmpSessionStore(agentDir);

    const [message] = await store.messages({ id: toOmpSessionId(VALID_ID), cwd: CWD });

    expect(imageContentData(entryMessageContent(message))).toBe(ref);
  });

  it("treats a malformed blob hash suffix as inert instead of reading outside the blob store", async () => {
    // Mirrors the canonical parseBlobRef's own security invariant: a suffix
    // that is not a canonical 64-char lowercase hex hash must never reach a
    // filesystem read, so a crafted "blob:sha256:../../../etc/passwd"-style
    // ref cannot escape the blob directory.
    const maliciousRef = "blob:sha256:../../../../etc/passwd";
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_a", {
      id: VALID_ID,
      cwd: CWD,
      entries: [ompMessageEntry({ id: "m1", parentId: null, role: "toolResult", content: [{ type: "text", text: "see image" }, { type: "image", data: maliciousRef, mimeType: "image/webp" }] })],
    });
    const store = new OmpSessionStore(agentDir);

    const [message] = await store.messages({ id: toOmpSessionId(VALID_ID), cwd: CWD });

    expect(imageContentData(entryMessageContent(message))).toBe(maliciousRef);
  });

  it("rejects for an unresolvable ref instead of returning an empty history", async () => {
    const store = new OmpSessionStore(agentDir);

    await expect(store.messages({ id: toOmpSessionId(VALID_ID), cwd: CWD })).rejects.toThrow();
  });
});

describe("OmpSessionStore.listAll", () => {
  // Beyond list/resolve/messages + toOmpSessionId/fromOmpSessionId: global
  // cleanup (cleanupPreview/cleanup with no explicit projectCwds) needs
  // every OMP session across every cwd, and the service layer has no way
  // to enumerate cwds itself. Reuses the exact same one-level,
  // header-validated scan as list(cwd) — this is not a second,
  // independently-audited scanner — it simply omits the cwd filter.
  it("returns sessions across every cwd, not just one", async () => {
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_mine", { id: VALID_ID, cwd: CWD, entries: [] });
    await writeOmpSessionFile(sessionsRoot, "-workspace-other", "2026-01-01T00-00-01-000Z_theirs", { id: OTHER_VALID_ID, cwd: OTHER_CWD, entries: [] });
    const store = new OmpSessionStore(agentDir);

    const sessions = await store.listAll();

    expect(sessions.map((session) => session.id).sort()).toEqual([toOmpSessionId(OTHER_VALID_ID), toOmpSessionId(VALID_ID)].sort());
    expect(sessions.find((session) => session.id === toOmpSessionId(VALID_ID))).toMatchObject({ cwd: CWD });
    expect(sessions.find((session) => session.id === toOmpSessionId(OTHER_VALID_ID))).toMatchObject({ cwd: OTHER_CWD });
  });

  it("orders results newest-modified-first across cwds, same as list(cwd)", async () => {
    const olderPath = await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_older", { id: VALID_ID, cwd: CWD, entries: [] });
    const newerPath = await writeOmpSessionFile(sessionsRoot, "-workspace-other", "2026-01-01T00-00-01-000Z_newer", { id: OTHER_VALID_ID, cwd: OTHER_CWD, entries: [] });
    await utimes(olderPath, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
    await utimes(newerPath, new Date("2026-01-02T00:00:00.000Z"), new Date("2026-01-02T00:00:00.000Z"));
    const store = new OmpSessionStore(agentDir);

    const sessions = await store.listAll();

    expect(sessions.map((session) => session.id)).toEqual([toOmpSessionId(OTHER_VALID_ID), toOmpSessionId(VALID_ID)]);
  });

  it("applies the same header validation and one-level scan safety as list(cwd)", async () => {
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_bad", { id: "not-a-uuid", cwd: CWD, entries: [] });
    const rootPath = await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-01-000Z_root", { id: VALID_ID, cwd: CWD, entries: [] });
    await writeOmpNestedArtifactSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-01-000Z_root", "SubagentName", { id: OTHER_VALID_ID, cwd: CWD, entries: [] });
    const store = new OmpSessionStore(agentDir);

    const sessions = await store.listAll();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: toOmpSessionId(VALID_ID), path: rootPath });
  });

  it("returns an empty list when no sessions exist anywhere, without throwing", async () => {
    const store = new OmpSessionStore(agentDir);

    await expect(store.listAll()).resolves.toEqual([]);
  });
});

describe("OmpSessionStore bounded discovery I/O", () => {
  it("preserves a Unicode workspace when UTF-8 characters span stream chunks", async () => {
    const cwd = "/workspace/café";
    await writeOmpSessionFile(sessionsRoot, "-unicode", "session", {
      id: VALID_ID, cwd, entries: [],
    });
    const store = new OmpSessionStore(agentDir, {
      createReadStream: (path) => createReadStream(path, { highWaterMark: 1 }),
    });
    expect((await store.list(cwd)).map((session) => session.id)).toEqual([toOmpSessionId(VALID_ID)]);
  });

  // Discovery (list/listAll/resolve) must not let one huge, unrelated-cwd
  // session transcript get fully materialized into memory just to compute a
  // listing for a different cwd — a real resource risk on a shared daemon —
  // nor let a single corrupt/oversized unterminated line hang or OOM the
  // scan even for a MATCHING file. This proposes an injected
  // `createReadStream` stream-factory seam (`OmpSessionStore(agentDir, {
  // createReadStream })`, defaulting to real `fs.createReadStream`) low-level
  // enough that these tests exercise the store's own real byte-buffering
  // and line-splitting logic against a raw, controllable stream — not a
  // seam that hands back an already-materialized "line" string, which would
  // pass even if the real reader still buffered unboundedly. `messages()` is
  // unaffected: it still fully reads only the one already-validated target
  // file via a real stream to EOF.
  it("stops reading a non-matching cwd's file after its header, without waiting for EOF", async () => {
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_mine", {
      id: VALID_ID,
      cwd: CWD,
      entries: [ompMessageEntry({ id: "m1", parentId: null, role: "user", content: [{ type: "text", text: "hello" }] })],
    });
    // A real file must exist for the on-disk directory walk to discover the
    // path at all; its injected stream is entirely fake and never ends.
    const otherPath = await writeOmpSessionFile(sessionsRoot, "-workspace-huge", "2026-01-01T00-00-01-000Z_huge", { id: OTHER_VALID_ID, cwd: OTHER_CWD, entries: [] });

    const destroyedPaths: string[] = [];
    const store = new OmpSessionStore(agentDir, {
      createReadStream: (path) => {
        if (path !== otherPath) return createReadStream(path);
        const stream = new PassThrough();
        const header = JSON.stringify({ type: "session", version: 3, id: OTHER_VALID_ID, cwd: OTHER_CWD, timestamp: "2026-01-01T00:00:00.000Z" });
        stream.write(`${header}\n`);
        stream.write("x".repeat(5_000_000)); // huge, unterminated, and the stream never ends.
        stream.once("close", () => destroyedPaths.push(path));
        return stream;
      },
    });

    const sessions = await store.list(CWD);

    expect(sessions.map((session) => session.id)).toEqual([toOmpSessionId(VALID_ID)]);
    expect(destroyedPaths).toContain(otherPath);
  });

  it("omits an entire candidate whose content contains an unterminated line beyond the local 64 MiB record ceiling, instead of reporting it with wrong/empty metadata", async () => {
    // A conservative whole-file omission, not a partial/degraded metadata
    // report: a downstream cleanup pass could otherwise mistake a
    // wrongly-reported messageCount:0 for a genuinely empty session and
    // delete real content it never actually read. The ceiling is a generous
    // 64 MiB local bound (matching the same native reassembled-frame bound
    // used elsewhere for logical frames), not the RPC wire transport's 1 MiB
    // *physical* frame limit: a persisted JSONL record is a logical unit,
    // and a legitimate large record must remain discoverable (see the
    // paired regression guard below).
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_untouched", {
      id: VALID_ID,
      cwd: CWD,
      entries: [ompMessageEntry({ id: "m1", parentId: null, role: "user", content: [{ type: "text", text: "untouched" }] })],
    });
    const corruptPath = await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-01-000Z_corrupt", { id: OTHER_VALID_ID, cwd: CWD, entries: [] });

    const destroyedPaths: string[] = [];
    const store = new OmpSessionStore(agentDir, {
      createReadStream: (path) => {
        if (path !== corruptPath) return createReadStream(path);
        const stream = new PassThrough();
        const header = JSON.stringify({ type: "session", version: 3, id: OTHER_VALID_ID, cwd: CWD, timestamp: "2026-01-01T00:00:00.000Z" });
        stream.write(`${header}\n`);
        // A real message with genuine content, immediately followed by a
        // never-terminated chunk with no newline exceeding the 64 MiB
        // ceiling -- a torn/corrupt write. The stream never ends.
        stream.write(`${JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: "real content" }] } })}\n`);
        stream.write("x".repeat(65 * 1024 * 1024));
        stream.once("close", () => destroyedPaths.push(path));
        return stream;
      },
    });

    const sessions = await store.list(CWD);

    expect(sessions.map((session) => session.id)).toEqual([toOmpSessionId(VALID_ID)]);
    expect(sessions.find((session) => session.id === toOmpSessionId(OTHER_VALID_ID))).toBeUndefined();
    expect(destroyedPaths).toContain(corruptPath);
    // The untouched file's real metadata stays exact and unaffected.
    expect(sessions[0]).toMatchObject({ messageCount: 1, firstMessage: "untouched" });
  });

  it("still discovers a legitimate multi-megabyte record within the local ceiling, not just physically-small lines", async () => {
    // Regression guard for the ceiling above: a real, complete (newline-
    // terminated) record well over any *physical* wire-frame size but
    // comfortably under the 64 MiB logical-record ceiling must remain fully
    // readable, through the real default stream reader (no injected seam).
    const bigText = "y".repeat(10 * 1024 * 1024);
    await writeOmpSessionFile(sessionsRoot, "-workspace-project", "2026-01-01T00-00-00-000Z_big", {
      id: VALID_ID,
      cwd: CWD,
      entries: [ompMessageEntry({ id: "m1", parentId: null, role: "user", content: [{ type: "text", text: bigText }] })],
    });
    const store = new OmpSessionStore(agentDir);

    const sessions = await store.list(CWD);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: toOmpSessionId(VALID_ID), messageCount: 1, firstMessage: bigText });
  });

  it("scans candidate session files with bounded concurrency, not unlimited fan-out", async () => {
    const fileCount = 40;
    for (let index = 0; index < fileCount; index++) {
      await writeOmpSessionFile(sessionsRoot, "-workspace-project", `2026-01-01T00-00-00-000Z_s${String(index)}`, { id: fakeUuid(index), cwd: CWD, entries: [] });
    }

    let inFlight = 0;
    let peakInFlight = 0;
    const store = new OmpSessionStore(agentDir, {
      createReadStream: (path) => {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        const stream = createReadStream(path);
        const release = (): void => {
          inFlight--;
        };
        stream.once("close", release);
        stream.once("error", release);
        return stream;
      },
    });

    const sessions = await store.listAll();

    expect(sessions).toHaveLength(fileCount);
    expect(peakInFlight).toBeGreaterThan(0);
    expect(peakInFlight).toBeLessThanOrEqual(20);
  });
});
