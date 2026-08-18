import * as fsPromises from "node:fs/promises";
import { appendFile, mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiSessionListEntry } from "./piSessionService.js";
import { rewriteHeaderWithoutParentSession } from "./sessionFileRewrite.testSupport.js";
import { SessionSummaryScanner } from "./sessionSummaryScanner.js";

// Route node:fs/promises through a plain copy of the real module: Node's
// builtin namespaces are frozen, so vi.spyOn cannot redefine their exports
// directly. Tests replay the memo's stat/open race by spying on `stat` here.
vi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof fsPromises>()) }));

const WORKSPACE = "/workspace/project";

let tempDir: string;
let sessionDir: string;
let entryCounter: number;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-summary-scanner-test-"));
  sessionDir = join(tempDir, "sessions");
  await mkdir(sessionDir, { recursive: true });
  entryCounter = 0;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("session summary scanner parity with the SDK listing", () => {
  it("reports the same summary fields the SDK computes from full transcripts", async () => {
    const richPath = await writeSession("2026-01-01T00-00-00-000Z_rich.jsonl", [
      headerLine({ id: "rich", cwd: WORKSPACE, parentSession: "/parents/rich-parent.jsonl" }),
      messageLine({ role: "user", content: textContent("Fix the login bug") }),
      messageLine({ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "On it" }] }),
      messageLine({ role: "user", content: [{ type: "toolResult", toolCallId: "call-1", content: "ok" }] }),
      sessionInfoLine("First name"),
      messageLine({ role: "assistant", content: textContent("Done") }),
      sessionInfoLine("Renamed session"),
      JSON.stringify({ type: "custom", id: nextEntryId(), parentId: "root", timestamp: "2026-01-01T00:03:00.000Z", customType: "note" }),
      sessionInfoLine(""),
      messageLine({ role: "user", content: textContent("second question") }),
    ]);
    const namedPath = await writeSession("2026-01-02T00-00-00-000Z_named.jsonl", [
      headerLine({ id: "named", cwd: WORKSPACE }),
      messageLine({ role: "assistant", content: textContent("assistant speaks first") }),
      messageLine({ role: "user", content: [] }),
      messageLine({ role: "user", content: "string content" }),
      sessionInfoLine("Kept name"),
    ]);

    const [sdkSessions, scannedSessions] = await Promise.all([SessionManager.listAll(sessionDir), coldListing(sessionDir)]);

    expect(scannedSessions.map((session) => session.path).sort()).toEqual([richPath, namedPath]);
    for (const scanned of scannedSessions) {
      const sdk = sdkSessions.find((candidate) => candidate.path === scanned.path);
      expect(sdk, `SDK listing includes ${scanned.path}`).toBeDefined();
      if (sdk === undefined) continue;
      expect(scanned.id).toBe(sdk.id);
      expect(scanned.cwd).toBe(sdk.cwd);
      expect(scanned.created.getTime()).toBe(sdk.created.getTime());
      expect(scanned.messageCount).toBe(sdk.messageCount);
      expect(scanned.firstMessage).toBe(sdk.firstMessage);
      expect(scanned.name).toBe(sdk.name);
      expect(scanned.parentSessionPath).toBe(sdk.parentSessionPath);
    }

    const rich = scannedSessions.find((session) => session.id === "rich");
    expect(rich).toMatchObject({ messageCount: 5, firstMessage: "Fix the login bug" });
    // Rename then explicit clear: the latest session_info wins, empty clears.
    expect(rich?.name).toBeUndefined();
    // Transcript text is never assembled by the scanner.
    expect(rich?.allMessagesText).toBe("");
  });

  it("uses the file mtime as the listing's modified time", async () => {
    const path = await writeSession("2026-01-01T00-00-00-000Z_mtimed.jsonl", [
      headerLine({ id: "mtimed", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("hello") }),
    ]);
    const pinned = new Date("2026-02-03T04:05:06.000Z");
    await utimes(path, pinned, pinned);

    const summary = await scanFileSummary(path);

    expect(summary?.modified.getTime()).toBe(pinned.getTime());
    expect(summary?.modified.getTime()).toBe((await stat(path)).mtime.getTime());
  });

  it("sorts listings by modified (mtime) descending", async () => {
    const ids = ["oldest", "newest", "middle"] as const;
    for (const id of ids) {
      await writeSession(`2026-01-01T00-00-00-000Z_${id}.jsonl`, [headerLine({ id, cwd: WORKSPACE })]);
    }
    await utimes(join(sessionDir, "2026-01-01T00-00-00-000Z_oldest.jsonl"), new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    await utimes(join(sessionDir, "2026-01-01T00-00-00-000Z_newest.jsonl"), new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));
    await utimes(join(sessionDir, "2026-01-01T00-00-00-000Z_middle.jsonl"), new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));

    const sessions = await coldListing(sessionDir);

    expect(sessions.map((session) => session.id)).toEqual(["newest", "middle", "oldest"]);
  });
});

describe("session summary scanner name handling", () => {
  it("keeps the latest non-empty session_info name", async () => {
    const path = await writeSession("renamed.jsonl", [
      headerLine({ id: "renamed", cwd: WORKSPACE }),
      sessionInfoLine("First"),
      sessionInfoLine("Second"),
    ]);

    expect(await scanFileSummary(path)).toMatchObject({ name: "Second" });
  });

  it("treats empty, whitespace-only, and missing names as clears", async () => {
    for (const clear of ["", "   ", undefined]) {
      const suffix = clear === undefined ? "missing" : `len-${String(clear.length)}`;
      const path = await writeSession(`cleared-${suffix}.jsonl`, [
        headerLine({ id: `cleared-${suffix}`, cwd: WORKSPACE }),
        sessionInfoLine("Visible"),
        sessionInfoLine(clear),
      ]);
      expect((await scanFileSummary(path))?.name, `name ${JSON.stringify(clear)} clears`).toBeUndefined();
    }
  });

  it("trims surrounding whitespace from kept names", async () => {
    const path = await writeSession("trimmed.jsonl", [headerLine({ id: "trimmed", cwd: WORKSPACE }), sessionInfoLine("  Padded name  ")]);

    expect(await scanFileSummary(path)).toMatchObject({ name: "Padded name" });
  });
});

describe("session summary scanner first message extraction", () => {
  it("takes the first user message with text, ignoring earlier assistant messages", async () => {
    const path = await writeSession("first-user.jsonl", [
      headerLine({ id: "first-user", cwd: WORKSPACE }),
      messageLine({ role: "assistant", content: textContent("assistant speaks first") }),
      messageLine({ role: "user", content: textContent("the real first message") }),
      messageLine({ role: "user", content: textContent("later") }),
    ]);

    expect(await scanFileSummary(path)).toMatchObject({ firstMessage: "the real first message", messageCount: 3 });
  });

  it("skips user messages without text content when finding the first message", async () => {
    const path = await writeSession("tool-first.jsonl", [
      headerLine({ id: "tool-first", cwd: WORKSPACE }),
      messageLine({ role: "user", content: [{ type: "toolResult", toolCallId: "call-1", content: "output" }] }),
      messageLine({ role: "user", content: [] }),
      messageLine({ role: "user", content: textContent("typed later") }),
    ]);

    expect(await scanFileSummary(path)).toMatchObject({ firstMessage: "typed later", messageCount: 3 });
  });

  it("joins multiple text blocks with a space like the SDK", async () => {
    const path = await writeSession("multi-block.jsonl", [
      headerLine({ id: "multi-block", cwd: WORKSPACE }),
      messageLine({ role: "user", content: [{ type: "text", text: "part one" }, { type: "image", url: "x" }, { type: "text", text: "part two" }] }),
    ]);

    expect(await scanFileSummary(path)).toMatchObject({ firstMessage: "part one part two" });
  });

  it("falls back to the SDK's placeholder when no user message has text", async () => {
    const path = await writeSession("no-text.jsonl", [
      headerLine({ id: "no-text", cwd: WORKSPACE }),
      messageLine({ role: "assistant", content: textContent("only assistant") }),
    ]);

    expect(await scanFileSummary(path)).toMatchObject({ firstMessage: "(no messages)", messageCount: 1 });
  });
});

describe("session summary scanner edge cases", () => {
  it("skips empty files", async () => {
    const path = await writeSession("empty.jsonl", []);

    expect(await scanFileSummary(path)).toBeUndefined();
    expect(await coldListing(sessionDir)).toEqual([]);
  });

  it("skips files whose first parseable entry is not a session header", async () => {
    const path = await writeSession("message-first.jsonl", [
      messageLine({ role: "user", content: textContent("orphan") }),
      headerLine({ id: "late-header", cwd: WORKSPACE }),
    ]);

    expect(await scanFileSummary(path)).toBeUndefined();
  });

  it("skips unparseable files but still finds a header after blank or garbage lines", async () => {
    await writeSession("garbage.jsonl", ["not json at all"]);
    const latePath = await writeSession("late-header.jsonl", ["", "also not json", headerLine({ id: "late", cwd: WORKSPACE }), messageLine({ role: "user", content: textContent("hi") })]);

    expect(await scanFileSummary(join(sessionDir, "garbage.jsonl"))).toBeUndefined();
    expect(await scanFileSummary(latePath)).toMatchObject({ id: "late", messageCount: 1, firstMessage: "hi" });
  });

  it("skips headers without a usable string id instead of listing broken sessions", async () => {
    const path = await writeSession("no-id.jsonl", [JSON.stringify({ type: "session", version: 3, timestamp: "2026-01-01T00:00:00.000Z", cwd: WORKSPACE })]);

    expect(await scanFileSummary(path)).toBeUndefined();
  });

  it("lists headers without a cwd with an empty cwd for the gateway filter to drop", async () => {
    const path = await writeSession("legacy.jsonl", [headerLine({ id: "legacy" })]);

    expect(await scanFileSummary(path)).toMatchObject({ id: "legacy", cwd: "" });
  });

  it("does not count a message line truncated mid-write", async () => {
    const path = await writeSession("truncated.jsonl", [headerLine({ id: "truncated", cwd: WORKSPACE }), '{"type":"message","id":"half-written"']);

    expect(await scanFileSummary(path)).toMatchObject({ id: "truncated", messageCount: 0, firstMessage: "(no messages)" });
  });

  it("counts a torn final write that happens to end in an inner brace", async () => {
    // Performance contract: the fast path does not validate JSON, so a final
    // write caught mid-flight counts as soon as it ends with `}` — a transient
    // +1 that self-heals on the next listing, because a file whose size
    // changed is always scanned whole again.
    const path = await writeSession("torn.jsonl", [
      headerLine({ id: "torn", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("start") }),
      '{"type":"message","id":"torn-1","message":{"role":"assistant","content":[{"type":"text","text":"streaming"}]}',
    ]);

    expect(await scanFileSummary(path)).toMatchObject({ id: "torn", messageCount: 2, firstMessage: "start" });
  });

  it("never classifies high-bit garbage bytes as a known entry type", async () => {
    // Buffer.toString("ascii") masks each byte's high bit, so these byte
    // sequences decode to "message" and "session_info": classification must
    // compare raw bytes instead and skip the lines (no count, no rename).
    const maskedType = (bytes: number[]) => Buffer.concat([Buffer.from('{"type":"'), Buffer.from(bytes), Buffer.from('"')]);
    const path = join(sessionDir, "garbage-types.jsonl");
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from(`${headerLine({ id: "garbage-types", cwd: WORKSPACE })}\n`),
        maskedType([0xed, 0xe5, 0xf3, 0xf3, 0xe1, 0xe7, 0xe5]), // "message" under ASCII masking
        Buffer.from(',"id":"m1"}\n'),
        maskedType([0xf3, 0xe5, 0xf3, 0xf3, 0xe9, 0xef, 0xee, 0xdf, 0xe9, 0xee, 0xe6, 0xef]), // "session_info" under ASCII masking
        Buffer.from(',"name":"Hijacked"}\n'),
        Buffer.from(`${messageLine({ role: "user", content: textContent("real") })}\n`),
      ]),
    );

    const summary = await scanFileSummary(path);
    expect(summary).toMatchObject({ id: "garbage-types", messageCount: 1, firstMessage: "real" });
    expect(summary?.name).toBeUndefined();
  });

  it("counts message lines with trailing whitespace like the SDK", async () => {
    // JSON.parse tolerates trailing whitespace, so the SDK counts such lines;
    // the completeness check must look past it to the final `}`.
    await writeSession("padded.jsonl", [
      headerLine({ id: "padded", cwd: WORKSPACE }),
      `${messageLine({ role: "user", content: textContent("padded") })} \t`,
      `${messageLine({ role: "assistant", content: textContent("crlf") })}\r`,
    ]);

    const [sdkSessions, scannedSessions] = await Promise.all([SessionManager.listAll(sessionDir), coldListing(sessionDir)]);

    expect(sdkSessions).toMatchObject([{ id: "padded", messageCount: 2 }]);
    expect(scannedSessions).toMatchObject([{ id: "padded", messageCount: 2, firstMessage: "padded" }]);
  });

  it("falls back to parsing lines whose key order does not start with the type", async () => {
    const path = await writeSession("reordered.jsonl", [
      headerLine({ id: "reordered", cwd: WORKSPACE }),
      JSON.stringify({ id: "m1", type: "message", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: "reordered first" } }),
      JSON.stringify({ name: "Late name", type: "session_info", timestamp: "2026-01-01T00:02:00.000Z" }),
    ]);

    expect(await scanFileSummary(path)).toMatchObject({ messageCount: 1, firstMessage: "reordered first", name: "Late name" });
  });

  it("keeps huge tool-result lines from leaking into the summary without parsing them", async () => {
    const sessionInfoDecoy = '{"type":"session_info","name":"hijacked"}';
    const messageDecoy = '{"type":"message","id":"fake"}';
    const padding = "x".repeat(3 * 1024 * 1024);
    const path = await writeSession("huge.jsonl", [
      headerLine({ id: "huge", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("start") }),
      messageLine({ role: "assistant", content: [{ type: "toolResult", toolCallId: "call-big", content: `${sessionInfoDecoy}\n${padding}\n${messageDecoy}` }] }),
      messageLine({ role: "user", content: textContent("later") }),
    ]);

    const summary = await scanFileSummary(path);

    expect(summary).toMatchObject({ id: "huge", messageCount: 3, firstMessage: "start" });
    expect(summary?.name).toBeUndefined();
  });

  it("classifies message lines after the first user message by shape, without validating them", async () => {
    // A raw tab makes this line invalid JSON: a parsing scanner would reject it.
    // The fast path classifies by the leading type key and trailing brace
    // alone, so it is still counted — proof that bodies after the first user
    // message are never parsed. (SDK-written files are always valid JSON, so
    // this never diverges from the SDK on real transcripts.)
    const invalidBody = '{"type":"message","id":"m2","message":{"role":"assistant","content":[{"type":"text","text":"has\traw tab"}]}}';
    const path = await writeSession("unvalidated.jsonl", [
      headerLine({ id: "unvalidated", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("start") }),
      invalidBody,
    ]);

    expect(await scanFileSummary(path)).toMatchObject({ id: "unvalidated", messageCount: 2, firstMessage: "start" });
  });

  it("lists nothing when the session directory does not exist", async () => {
    expect(await coldListing(join(tempDir, "missing"))).toEqual([]);
  });
});

describe("session summary scanner memo", () => {
  it("answers repeated warm listings identically to the cold listing", async () => {
    await writeSession("2026-01-03T00-00-00-000Z_named.jsonl", [
      headerLine({ id: "named", cwd: WORKSPACE, parentSession: "/parents/named-parent.jsonl" }),
      messageLine({ role: "user", content: textContent("hello") }),
      sessionInfoLine("Named session"),
    ]);
    await writeSession("2026-01-02T00-00-00-000Z_bare.jsonl", [headerLine({ id: "bare", cwd: WORKSPACE })]);
    await writeSession("2026-01-01T00-00-00-000Z_chatty.jsonl", [
      headerLine({ id: "chatty", cwd: WORKSPACE }),
      messageLine({ role: "assistant", content: textContent("assistant first") }),
      messageLine({ role: "user", content: textContent("then user") }),
      messageLine({ role: "assistant", content: textContent("reply") }),
    ]);
    // Pin the order deterministically instead of trusting write-time mtimes.
    await utimes(join(sessionDir, "2026-01-03T00-00-00-000Z_named.jsonl"), new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));
    await utimes(join(sessionDir, "2026-01-02T00-00-00-000Z_bare.jsonl"), new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    await utimes(join(sessionDir, "2026-01-01T00-00-00-000Z_chatty.jsonl"), new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    const scanner = new SessionSummaryScanner();

    const cold = await scanner.scanSessionSummariesInDir(sessionDir);
    expect(cold.map((session) => session.id)).toEqual(["named", "bare", "chatty"]);
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toEqual(cold);
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toEqual(cold);
    // A warm memoized listing is field-for-field identical to a fresh scan.
    expect(await coldListing(sessionDir)).toEqual(cold);
  });

  it("re-scans a grown file whole", async () => {
    const path = await writeSession("grown.jsonl", [
      headerLine({ id: "grown", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("first question") }),
      messageLine({ role: "assistant", content: textContent("first answer") }),
    ]);
    const scanner = new SessionSummaryScanner();
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toMatchObject([{ id: "grown", messageCount: 2, firstMessage: "first question" }]);

    await appendFile(
      path,
      `${[messageLine({ role: "user", content: [{ type: "toolResult", toolCallId: "call-1", content: "ok" }] }), messageLine({ role: "user", content: textContent("second question") }), sessionInfoLine("Renamed later")].join("\n")}\n`,
      "utf8",
    );

    const warm = await scanner.scanSessionSummariesInDir(sessionDir);
    expect(warm).toMatchObject([{ id: "grown", messageCount: 4, firstMessage: "first question", name: "Renamed later" }]);
    expect(warm).toEqual(await coldListing(sessionDir));
  });

  it("re-scans a file whose unterminated trailing line was completed by an append", async () => {
    // A line still being written is folded into the listing it was read for,
    // then folded again as part of the whole file once the writer finishes
    // it: the size changed, so no line is counted twice.
    const inFlight = messageLine({ role: "assistant", content: textContent("streaming") });
    const path = await writeSession("inflight.jsonl", [headerLine({ id: "inflight", cwd: WORKSPACE }), messageLine({ role: "user", content: textContent("start") })]);
    await appendFile(path, inFlight, "utf8");
    const scanner = new SessionSummaryScanner();
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toMatchObject([{ id: "inflight", messageCount: 2 }]);

    // The writer finishes the line and appends the next one.
    await appendFile(path, `\n${messageLine({ role: "user", content: textContent("after") })}\n`, "utf8");

    const warm = await scanner.scanSessionSummariesInDir(sessionDir);
    expect(warm).toMatchObject([{ id: "inflight", messageCount: 3, firstMessage: "start" }]);
    expect(warm).toEqual(await coldListing(sessionDir));
  });

  it("fully re-parses a file that shrunk", async () => {
    const path = await writeSession("shrunk.jsonl", [
      headerLine({ id: "shrunk", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("old first") }),
      messageLine({ role: "assistant", content: textContent("old answer") }),
      sessionInfoLine("Old name"),
    ]);
    const scanner = new SessionSummaryScanner();
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toMatchObject([{ id: "shrunk", messageCount: 2, name: "Old name" }]);

    await writeFile(path, `${[headerLine({ id: "shrunk", cwd: WORKSPACE }), messageLine({ role: "user", content: textContent("new first") })].join("\n")}\n`, "utf8");

    const warm = await scanner.scanSessionSummariesInDir(sessionDir);
    expect(warm).toMatchObject([{ id: "shrunk", messageCount: 1, firstMessage: "new first" }]);
    expect(warm[0]?.name).toBeUndefined();
    expect(warm).toEqual(await coldListing(sessionDir));
  });

  it("fully re-parses a replacement file at the same path even when it is larger", async () => {
    const path = await writeSession("replaced.jsonl", [headerLine({ id: "original", cwd: WORKSPACE }), messageLine({ role: "user", content: textContent("small") })]);
    const scanner = new SessionSummaryScanner();
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toMatchObject([{ id: "original", messageCount: 1 }]);

    // Rename-over swaps in a different inode, so growth must not be read as
    // an append. (Unlink + recreate is not a portable replacement: some
    // filesystems hand the freed inode right back to the recreated file.)
    const replacementPath = await writeSession("replaced-successor.jsonl", [
      headerLine({ id: "replacement", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("bigger first") }),
      messageLine({ role: "assistant", content: textContent("padding to outgrow the original file") }),
      messageLine({ role: "user", content: textContent("more") }),
    ]);
    await rename(replacementPath, path);

    const warm = await scanner.scanSessionSummariesInDir(sessionDir);
    expect(warm).toMatchObject([{ id: "replacement", messageCount: 3, firstMessage: "bigger first" }]);
    expect(warm).toEqual(await coldListing(sessionDir));
  });

  it("drops deleted sessions and does not resurrect stale entries at the same path", async () => {
    await writeSession("kept.jsonl", [headerLine({ id: "kept", cwd: WORKSPACE }), messageLine({ role: "user", content: textContent("stays") })]);
    const removedPath = await writeSession("removed.jsonl", [headerLine({ id: "removed", cwd: WORKSPACE }), messageLine({ role: "user", content: textContent("goes") })]);
    const scanner = new SessionSummaryScanner();
    expect((await scanner.scanSessionSummariesInDir(sessionDir)).map((session) => session.id).sort()).toEqual(["kept", "removed"]);

    await rm(removedPath);
    expect((await scanner.scanSessionSummariesInDir(sessionDir)).map((session) => session.id)).toEqual(["kept"]);

    // A brand-new session at the old path is listed as itself, not its predecessor.
    await writeSession("removed.jsonl", [headerLine({ id: "fresh", cwd: WORKSPACE }), messageLine({ role: "user", content: textContent("back") })]);
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toMatchObject(expect.arrayContaining([expect.objectContaining({ id: "fresh", messageCount: 1 })]));
  });

  it("keeps skipping unusable files on warm listings until they change", async () => {
    const path = await writeSession("not-a-session.jsonl", [messageLine({ role: "user", content: textContent("orphan") })]);
    const scanner = new SessionSummaryScanner();
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toEqual([]);
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toEqual([]);

    // Rename-over swaps in a different inode (unlink + recreate can reuse the
    // freed inode, which the memo would read as growth of the rejected fold).
    const fixedPath = await writeSession("not-a-session-fixed.jsonl", [headerLine({ id: "fixed", cwd: WORKSPACE }), messageLine({ role: "user", content: textContent("valid now") })]);
    await rename(fixedPath, path);
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toMatchObject([{ id: "fixed" }]);
  });

  it("clear() drops the memo and recovers from an undetectable in-place rewrite", async () => {
    // Same inode, same size, different bytes: invisible to the identity+size
    // key by design. clear() is the documented escape hatch for it.
    const version = (sessionId: string, text: string) => [
      `{"type":"session","version":3,"id":"${sessionId}","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${WORKSPACE}"}`,
      `{"type":"message","id":"m1","parentId":"root","timestamp":"2026-01-01T00:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"${text}"}]}}`,
    ];
    const path = await writeSession("rewritten.jsonl", version("before", "old text"));
    const scanner = new SessionSummaryScanner();
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toMatchObject([{ id: "before", firstMessage: "old text" }]);

    await writeFile(path, `${version("afters", "new text").join("\n")}\n`, "utf8");
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toMatchObject([{ id: "before", firstMessage: "old text" }]);

    scanner.clear();
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toMatchObject([{ id: "afters", firstMessage: "new text" }]);
  });

  it("invalidate() drops one memo entry so a same-size in-place rewrite is re-read", async () => {
    // Detach clears the parent link by rewriting the header in place (same
    // inode) — the rewrite the identity+size key cannot detect whenever the
    // file's size happens to be unchanged. invalidate() is the targeted
    // escape hatch; without it the stat-only fast path serves the pre-detach
    // summary forever.
    const parentPath = join(tempDir, "parents", "parent.jsonl");
    const path = await writeSession("detached.jsonl", [
      headerLine({ id: "detached", cwd: WORKSPACE, parentSession: parentPath }),
      messageLine({ role: "user", content: textContent("first") }),
      messageLine({ role: "assistant", content: textContent("second") }),
    ]);
    const scanner = new SessionSummaryScanner();
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toMatchObject([{ id: "detached", messageCount: 2, parentSessionPath: parentPath }]);

    // Rewrite the header without the parent link the way clearParentSession
    // does (truncate + write, same inode), padding the file back to its
    // original size so identity and size both look unchanged.
    await rewriteHeaderWithoutParentSession(path);

    // No invalidation yet: the memo still serves the old parent link.
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toMatchObject([{ id: "detached", parentSessionPath: parentPath }]);

    scanner.invalidate(path);
    const warm = await scanner.scanSessionSummariesInDir(sessionDir);
    expect(warm).toMatchObject([{ id: "detached", messageCount: 2 }]);
    expect(warm[0]).not.toHaveProperty("parentSessionPath");
    expect(warm).toEqual(await coldListing(sessionDir));
  });

  it("reads identity and metadata from the opened file, not a stale pathname stat", async () => {
    const path = await writeSession("raced.jsonl", [
      headerLine({ id: "original", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("old first") }),
    ]);
    const scanner = new SessionSummaryScanner();
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toMatchObject([{ id: "original", messageCount: 1 }]);
    const memoizedStats = await stat(path);

    // A concurrent writer replaces the file atomically: write the successor
    // alongside, pin its mtime, then rename over the path (new inode).
    const replacementPath = await writeSession("raced-replacement.jsonl", [
      headerLine({ id: "replacement", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("new first") }),
      messageLine({ role: "assistant", content: textContent("new second") }),
      messageLine({ role: "user", content: textContent("new third") }),
    ]);
    const replacementMtime = new Date("2026-02-03T04:05:06.000Z");
    await utimes(replacementPath, replacementMtime, replacementMtime);
    await rename(replacementPath, path);

    // Replay the stat/open race: the pathname stat still reports the
    // memoized identity at a different size, as it did before the
    // replacement landed. The rescan opens the path and describes whatever
    // file it got, so the summary and its mtime come from the replacement.
    const statSpy = vi.spyOn(fsPromises, "stat").mockResolvedValue(statWithSize(memoizedStats, memoizedStats.size + 1));
    try {
      const warm = await scanner.scanSessionSummariesInDir(sessionDir);
      expect(warm).toMatchObject([{ id: "replacement", messageCount: 3, firstMessage: "new first" }]);
      // Metadata comes from the opened handle, not the stale pathname stat.
      expect(warm[0]?.modified.getTime()).toBe(replacementMtime.getTime());
    } finally {
      statSpy.mockRestore();
    }

    // The memo now describes the replacement: later listings stay consistent.
    const settled = await scanner.scanSessionSummariesInDir(sessionDir);
    expect(settled).toMatchObject([{ id: "replacement", messageCount: 3 }]);
    expect(settled).toEqual(await coldListing(sessionDir));
  });

});

describe("session summary scanner multi-chunk folding with a small chunk seam", () => {
  // The 4 MiB production chunk size would need gigabyte fixtures to span;
  // the constructor seam shrinks it so lines spanning chunks and unterminated
  // tails are testable at byte scale.
  const SMALL_CHUNK_BYTES = 64;

  it("rejects chunk sizes that cannot drive a streaming read", () => {
    expect(() => new SessionSummaryScanner({ chunkBytes: 0 })).toThrow(TypeError);
    expect(() => new SessionSummaryScanner({ chunkBytes: -1 })).toThrow(TypeError);
    expect(() => new SessionSummaryScanner({ chunkBytes: 1.5 })).toThrow(TypeError);
  });

  it("folds terminated lines that span many chunks", async () => {
    // Every line here is longer than the chunk buffer, so the header, the
    // messages, and the rename all exercise the pending-chunk join path.
    await writeSession("spanning.jsonl", [
      headerLine({ id: "spanning", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("first") }),
      messageLine({ role: "assistant", content: [{ type: "toolResult", toolCallId: "call-1", content: "x".repeat(500) }] }),
      sessionInfoLine("Renamed across chunks"),
      messageLine({ role: "user", content: textContent("last") }),
    ]);
    const scanner = new SessionSummaryScanner({ chunkBytes: SMALL_CHUNK_BYTES });

    const cold = await scanner.scanSessionSummariesInDir(sessionDir);
    expect(cold).toMatchObject([{ id: "spanning", messageCount: 3, firstMessage: "first", name: "Renamed across chunks" }]);
    expect(cold).toEqual(await coldListing(sessionDir));
  });

  it("counts a line longer than several chunks exactly once without scanning its body", async () => {
    // The 3 MiB "huge" case at byte scale: the joined line must not be
    // counted twice at chunk boundaries, and entry-shaped substrings inside
    // its body must not leak into the summary.
    const sessionInfoDecoy = '{"type":"session_info","name":"hijacked"}';
    const messageDecoy = '{"type":"message","id":"fake"}';
    const padding = "x".repeat(1024);
    await writeSession("long-line.jsonl", [
      headerLine({ id: "long-line", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("start") }),
      messageLine({ role: "assistant", content: [{ type: "toolResult", toolCallId: "call-big", content: `${sessionInfoDecoy}\n${padding}\n${messageDecoy}` }] }),
      messageLine({ role: "user", content: textContent("end") }),
    ]);
    const scanner = new SessionSummaryScanner({ chunkBytes: SMALL_CHUNK_BYTES });

    const summary = (await scanner.scanSessionSummariesInDir(sessionDir))[0];
    expect(summary).toMatchObject({ id: "long-line", messageCount: 3, firstMessage: "start" });
    expect(summary?.name).toBeUndefined();
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toEqual(await coldListing(sessionDir));
  });

  it("folds an unterminated multi-chunk tail whole once the file grows", async () => {
    const path = await writeSession("unterminated-span.jsonl", [
      headerLine({ id: "unterminated-span", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("start") }),
    ]);
    const longLine = messageLine({ role: "assistant", content: [{ type: "text", text: "s".repeat(300) }] });
    // Land the long line in two writes, cut inside its body: the first scan
    // sees a tail that both spans chunks and has no trailing newline.
    const cutAt = 200;
    await appendFile(path, longLine.slice(0, cutAt), "utf8");
    const scanner = new SessionSummaryScanner({ chunkBytes: SMALL_CHUNK_BYTES });

    // Mid-JSON: not counted yet.
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toMatchObject([{ id: "unterminated-span", messageCount: 1, firstMessage: "start" }]);

    // The writer completes the long line and appends one more.
    await appendFile(path, `${longLine.slice(cutAt)}\n${messageLine({ role: "user", content: textContent("after") })}\n`, "utf8");

    const warm = await scanner.scanSessionSummariesInDir(sessionDir);
    expect(warm).toMatchObject([{ id: "unterminated-span", messageCount: 3, firstMessage: "start" }]);
    expect(warm).toEqual(await coldListing(sessionDir));
  });

  it("memoizes a rejected file at its observed end-of-file so warm listings do not re-read it", async () => {
    // The first parseable line is not a session header, so the file is
    // rejected and the fold stops at that line. Rejection is final, so the
    // memo must still record the observed end-of-file, or every warm listing
    // would see a size mismatch and re-read the rejected bytes.
    const filler = messageLine({ role: "assistant", content: textContent("filler") });
    const lines = [messageLine({ role: "user", content: textContent("orphan first line") })];
    for (let index = 0; index < 40; index += 1) lines.push(filler);
    const path = await writeSession("rejected-many-chunks.jsonl", lines);
    const scanner = new SessionSummaryScanner({ chunkBytes: SMALL_CHUNK_BYTES });

    const openSpy = vi.spyOn(fsPromises, "open");
    try {
      expect(await scanner.scanSessionSummariesInDir(sessionDir)).toEqual([]);
      const coldOpens = openSpy.mock.calls.length;
      expect(coldOpens).toBeGreaterThan(0);

      // Warm listing: the stat-only fast path answers; the file is not opened again.
      expect(await scanner.scanSessionSummariesInDir(sessionDir)).toEqual([]);
      expect(openSpy.mock.calls.length).toBe(coldOpens);

      // Growth is folded once into the still-rejected fold...
      await appendFile(path, `${filler}\n`, "utf8");
      expect(await scanner.scanSessionSummariesInDir(sessionDir)).toEqual([]);
      expect(openSpy.mock.calls.length).toBe(coldOpens + 1);

      // ...and the next warm listing is again answered without a read.
      expect(await scanner.scanSessionSummariesInDir(sessionDir)).toEqual([]);
      expect(openSpy.mock.calls.length).toBe(coldOpens + 1);
    } finally {
      openSpy.mockRestore();
    }
    expect(await scanner.scanSessionSummariesInDir(sessionDir)).toEqual(await coldListing(sessionDir));
  });

  it("allocates no read buffers for a fully warm listing", async () => {
    await writeSession("2026-01-01T00-00-00-000Z_warm-a.jsonl", [
      headerLine({ id: "warm-a", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("a") }),
    ]);
    await writeSession("2026-01-02T00-00-00-000Z_warm-b.jsonl", [
      headerLine({ id: "warm-b", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("b") }),
    ]);
    const scanner = new SessionSummaryScanner({ chunkBytes: SMALL_CHUNK_BYTES });
    const cold = await scanner.scanSessionSummariesInDir(sessionDir);
    expect(cold).toHaveLength(2);

    // The warm listing answers every file from the stat-only fast path, so it
    // must not pay a chunk-sized buffer allocation per worker for reads that
    // never happen.
    const allocSpy = vi.spyOn(Buffer, "allocUnsafe");
    try {
      const warm = await scanner.scanSessionSummariesInDir(sessionDir);
      expect(warm).toEqual(cold);
      expect(allocSpy.mock.calls.filter(([size]) => size === SMALL_CHUNK_BYTES)).toHaveLength(0);
    } finally {
      allocSpy.mockRestore();
    }
  });
});

describe("session summary scanner deliberate SDK divergences", () => {
  it("skips headers with an empty, missing, or non-string id, where the SDK lists a broken entry", async () => {
    // The SDK lists these sessions with whatever the header carries as id
    // (undefined, "", or a number); downstream lookups then call .startsWith
    // on it and crash. The scanner is deliberately stricter and skips them.
    await writeSession("missing-id.jsonl", [
      JSON.stringify({ type: "session", version: 3, timestamp: "2026-01-01T00:00:00.000Z", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("hi") }),
    ]);
    await writeSession("empty-id.jsonl", [
      JSON.stringify({ type: "session", version: 3, id: "", timestamp: "2026-01-01T00:00:00.000Z", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("hi") }),
    ]);
    await writeSession("numeric-id.jsonl", [
      JSON.stringify({ type: "session", version: 3, id: 123, timestamp: "2026-01-01T00:00:00.000Z", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("hi") }),
    ]);

    const [sdkSessions, scannedSessions] = await Promise.all([SessionManager.listAll(sessionDir), coldListing(sessionDir)]);

    // Divergence, locked in: the SDK lists all three broken headers.
    expect(sdkSessions).toHaveLength(3);
    expect(scannedSessions).toEqual([]);
  });

  it("skips scalar JSON lines before the header, where the SDK drops the file", async () => {
    // JSON.parse accepts scalars: the SDK treats any parseable non-session
    // entry before the header as a disqualifier, so one truthy scalar kills
    // the whole file there. The scanner only accepts objects as entries and
    // keeps looking for a header.
    await writeSession("scalars.jsonl", [
      "123",
      '"scalar"',
      "true",
      "null",
      headerLine({ id: "after-scalars", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("hi") }),
    ]);

    const [sdkSessions, scannedSessions] = await Promise.all([SessionManager.listAll(sessionDir), coldListing(sessionDir)]);

    expect(sdkSessions).toEqual([]);
    expect(scannedSessions).toMatchObject([{ id: "after-scalars", messageCount: 1, firstMessage: "hi" }]);
  });

  it("tolerates a null message payload, where the SDK dies on the file", async () => {
    // The SDK's isMessageWithContent reads message.role unguarded, so
    // {"type":"message","message":null} throws inside its listing and the
    // whole file is dropped. The scanner guards the payload and lists it.
    await writeSession("null-message.jsonl", [
      headerLine({ id: "null-message", cwd: WORKSPACE }),
      JSON.stringify({ type: "message", id: nextEntryId(), parentId: "root", timestamp: "2026-01-01T00:01:00.000Z", message: null }),
      messageLine({ role: "user", content: textContent("real first") }),
      messageLine({ role: "user", content: textContent("after null") }),
    ]);

    const [sdkSessions, scannedSessions] = await Promise.all([SessionManager.listAll(sessionDir), coldListing(sessionDir)]);

    expect(sdkSessions).toEqual([]);
    expect(scannedSessions).toMatchObject([{ id: "null-message", messageCount: 3, firstMessage: "real first" }]);
  });

  it("keeps the SDK's (no messages) fallback for sessions without user text", async () => {
    await writeSession("assistant-only.jsonl", [
      headerLine({ id: "assistant-only", cwd: WORKSPACE }),
      messageLine({ role: "assistant", content: textContent("assistant speaks") }),
    ]);
    await writeSession("header-only.jsonl", [headerLine({ id: "header-only", cwd: WORKSPACE })]);

    const [sdkSessions, scannedSessions] = await Promise.all([SessionManager.listAll(sessionDir), coldListing(sessionDir)]);

    const idAndFirstMessage = (sessions: { id: string; firstMessage: string }[]) => sessions.map((session) => [session.id, session.firstMessage]).sort();
    expect(idAndFirstMessage(sdkSessions)).toEqual([
      ["assistant-only", "(no messages)"],
      ["header-only", "(no messages)"],
    ]);
    expect(idAndFirstMessage(scannedSessions)).toEqual([
      ["assistant-only", "(no messages)"],
      ["header-only", "(no messages)"],
    ]);
  });
});

/** A listing from a scanner with an empty memo: every file is read from disk. */
async function coldListing(dir: string): Promise<PiSessionListEntry[]> {
  return new SessionSummaryScanner().scanSessionSummariesInDir(dir);
}

/** The cold summary of one session file, or undefined when it is not listable. */
async function scanFileSummary(path: string): Promise<PiSessionListEntry | undefined> {
  return (await coldListing(dirname(path))).find((session) => session.path === path);
}

function nextEntryId(): string {
  entryCounter += 1;
  return `entry-${String(entryCounter)}`;
}

function headerLine(header: { id: string; cwd?: string; parentSession?: string }): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: header.id,
    timestamp: "2026-01-01T00:00:00.000Z",
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
  });
}

function messageLine(message: { role: string; content: unknown }): string {
  return JSON.stringify({ type: "message", id: nextEntryId(), parentId: "root", timestamp: "2026-01-01T00:01:00.000Z", message });
}

function sessionInfoLine(name: string | undefined): string {
  return JSON.stringify({ type: "session_info", id: nextEntryId(), parentId: "root", timestamp: "2026-01-01T00:02:00.000Z", ...(name === undefined ? {} : { name }) });
}

function textContent(text: string): { type: "text"; text: string }[] {
  return [{ type: "text", text }];
}

async function writeSession(fileName: string, lines: readonly string[]): Promise<string> {
  const path = join(sessionDir, fileName);
  await writeFile(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
  return path;
}

/**
 * The memoized stat replayed at a different size: the race stub reports the
 * identity the scanner cached, at a size that selects the growth branch.
 */
function statWithSize(stats: Awaited<ReturnType<typeof stat>>, size: number): Awaited<ReturnType<typeof stat>> {
  return Object.assign({}, stats, { size });
}
