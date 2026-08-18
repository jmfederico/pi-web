import { open, readdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join, sep } from "node:path";
import { isRecord, tryParseEntry } from "./sessionFileFormat.js";
import type { PiSessionListEntry } from "./piSessionService.js";

/*
 * LISTING CONTRACT
 *
 * The summary fields mirror the SDK listing (`SessionManager.listAll`):
 * `messageCount` counts every `message` entry, `firstMessage` is the first
 * user message with non-empty text content, `name` is the latest `session_info`
 * name (an empty or missing name clears it), and `created`/`id`/`cwd`/
 * `parentSessionPath` come from the header line. Three deliberate differences:
 *
 * - `modified` is the file mtime rather than the last message timestamp.
 *   Session files are append-only, so the mtime is a faithful "last activity"
 *   for listing order, the only thing `modified` is used for.
 * - `allMessagesText` is always empty. Building it required parsing every
 *   message body — the cost this scanner exists to remove — and PI WEB never
 *   consumes it.
 * - `messageCount` can transiently include a final write read mid-flight: a
 *   message-shaped line that ends with `}` counts even though its JSON is
 *   never validated, where the SDK fails to parse such a torn line. The count
 *   self-heals on the next listing once the line completes (the file is
 *   re-scanned whole as soon as its size changes).
 *
 * Files whose header is missing, unreadable, or not a session header are
 * skipped, like the SDK does. Results are sorted by `modified` descending.
 *
 * Per-line work is minimal: lines are classified from their leading
 * `{"type":"..."` bytes without ever decoding them, and lines are only turned
 * into strings and JSON-parsed when they matter — the header, `session_info`
 * lines (rare, one per rename), and message lines until the first user text
 * message has been found. Message bodies after that point (which hold the huge
 * tool results and assistant replies) are neither decoded nor parsed.
 */

/**
 * Fast-path classification prefix of a session file line, as raw bytes.
 *
 * The Pi SDK writes every entry with `type` as the first JSON key, so the
 * entry type can normally be read directly from the line's first bytes without
 * decoding or parsing it. This is what lets a listing skip the (potentially
 * huge) message bodies entirely: only lines whose type actually matters for
 * the summary are ever decoded to strings and JSON-parsed.
 */
const ENTRY_TYPE_PREFIX = Buffer.from('{"type":"');
const TYPE_QUOTE = 0x22; // `"`
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const CLOSING_BRACE = 0x7d; // `}`
const SPACE = 0x20;
const TAB = 0x09;

/** The entry types the byte fast path recognizes, as raw bytes: type names are never decoded. */
const MESSAGE_TYPE_BYTES = Buffer.from("message");
const SESSION_INFO_TYPE_BYTES = Buffer.from("session_info");

/** Same bound the SDK uses for its concurrent session-info builds. */
const MAX_CONCURRENT_SESSION_SUMMARY_SCANS = 10;

/** Default read chunk size for the streaming pass; see SessionSummaryScannerOptions. */
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

/** Types longer than this fall back to a full parse instead of byte classification. */
const MAX_CLASSIFIED_TYPE_LENGTH = 64;

/** Construction options for {@link SessionSummaryScanner}. */
export interface SessionSummaryScannerOptions {
  /**
   * Read chunk size for the streaming pass. Defaults to 4 MiB. Tests shrink
   * this to exercise multi-chunk line folding with small files; production
   * callers leave it unset.
   */
  readonly chunkBytes?: number;
}

/**
 * Session summary scanner with a per-file memo, so repeated listings of the
 * same session directory do not re-read transcripts that did not change. See
 * the listing contract above for the fields it produces.
 *
 * The memo is a last resort on top of the lightweight streaming scan and is
 * deliberately trivial to invalidate — it never holds anything the file
 * itself cannot re-derive:
 *
 * - Key: absolute file path. Trusted value: file identity (dev/ino) plus the
 *   size the cached summary was folded from.
 * - Identity and size unchanged → cached summary. The mtime is re-read from
 *   the same stat, so `modified` stays faithful even on a cache hit.
 * - Identity or size changed → the cached summary is dropped and the file is
 *   scanned whole again. Nothing is folded incrementally, so a warm listing
 *   is always the fold of exactly the bytes it read.
 * - File gone (ENOENT) → its entry is dropped; entries for files that no
 *   longer appear in the directory listing are pruned on each scan.
 * - {@link clear} drops every entry. There are no TTLs and nothing is
 *   persisted: the memo is an in-process speedup, and a daemon restart starts
 *   cold but correct.
 *
 * The one thing the key cannot detect is an in-place rewrite that keeps the
 * inode and the size, which the stat-only fast path then serves from the
 * memo. The SDK never rewrites session files, but PI WEB's detach does (it
 * clears the header), so callers that rewrite a file in place must call
 * {@link invalidate} for it; {@link clear} remains the escape hatch for
 * unknown external rewrites.
 */
export class SessionSummaryScanner {
  private readonly memo = new Map<string, MemoizedSessionSummary>();
  private readonly chunkBytes: number;

  constructor(options: SessionSummaryScannerOptions = {}) {
    const chunkBytes = options.chunkBytes ?? SCAN_CHUNK_BYTES;
    if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
      throw new TypeError(`SessionSummaryScanner options.chunkBytes must be a positive integer, got ${String(chunkBytes)}`);
    }
    this.chunkBytes = chunkBytes;
  }

  /** Drop every cached summary, forcing full re-parses on the next listing. */
  clear(): void {
    this.memo.clear();
  }

  /**
   * Drop the cached summary for one file, forcing a full re-parse of it on
   * the next listing. Callers that rewrite a session file in place (keeping
   * the inode) must invalidate it, since identity + size checks cannot detect
   * such rewrites. Dropping a path that is not memoized is a no-op.
   */
  invalidate(filePath: string): void {
    this.memo.delete(filePath);
  }

  /**
   * List the sessions in one session directory with one lightweight streaming
   * pass per changed file, instead of the SDK's full-transcript listing. Files
   * whose identity and size have not changed since the previous scan of their
   * directory are answered from the memo (one stat each) instead of being read.
   */
  async scanSessionSummariesInDir(sessionDir: string): Promise<PiSessionListEntry[]> {
    const files = await listSessionFilesInDir(sessionDir);
    this.pruneEntriesRemovedFrom(sessionDir, files);
    const summaries = await scanSessionFilesWithBoundedConcurrency(files, this.chunkBytes, (file, chunkBuffer) => this.scanFileWithMemo(file, chunkBuffer));
    return sortedSessionSummaries(summaries);
  }

  private pruneEntriesRemovedFrom(sessionDir: string, existingFiles: readonly string[]): void {
    const dirPrefix = sessionDir.endsWith(sep) ? sessionDir : sessionDir + sep;
    const existing = new Set(existingFiles);
    for (const path of this.memo.keys()) {
      // Deletion invalidates automatically: entries for the scanned directory
      // whose file no longer exists are dropped, keeping the memo bounded.
      if (path.startsWith(dirPrefix) && !existing.has(path)) this.memo.delete(path);
    }
  }

  private async scanFileWithMemo(filePath: string, chunkBuffer: () => Buffer): Promise<PiSessionListEntry | undefined> {
    const memoized = this.memo.get(filePath);
    if (memoized === undefined) return this.fullScan(filePath, chunkBuffer);

    let stats: Stats;
    try {
      stats = await stat(filePath);
    } catch {
      // Went away between readdir and stat: drop it and skip, like the SDK.
      this.memo.delete(filePath);
      return undefined;
    }

    if (stats.dev !== memoized.dev || stats.ino !== memoized.ino || stats.size !== memoized.size) {
      // Anything but an unchanged file is scanned whole again.
      return this.fullScan(filePath, chunkBuffer);
    }
    // Stat-only fast path: unchanged file, so no open and no read. Its one
    // blind spot is an equal-size in-place rewrite that keeps the inode;
    // identity + size cannot see it by design (see the class docs).
    return buildSummaryFromFold(memoized.fold, filePath, stats.mtime);
  }

  private async fullScan(filePath: string, chunkBuffer: () => Buffer): Promise<PiSessionListEntry | undefined> {
    const scanned = await scanWholeSessionFile(filePath, chunkBuffer);
    if (scanned === undefined) {
      this.memo.delete(filePath);
      return undefined;
    }
    this.memo.set(filePath, { dev: scanned.dev, ino: scanned.ino, size: scanned.size, fold: scanned.fold });
    return buildSummaryFromFold(scanned.fold, filePath, scanned.mtime);
  }
}

/** One memoized file: the identity and size it was scanned at, plus its summary state. */
interface MemoizedSessionSummary {
  dev: number;
  ino: number;
  /** Observed end-of-file offset when the fold below was completed. */
  size: number;
  /** Summary state for the whole file, including any unterminated trailing line. */
  fold: SummaryFoldState;
}

/** The summary-relevant state accumulated while folding a file's lines. */
interface SummaryFoldState {
  header: Record<string, unknown> | undefined;
  rejected: boolean;
  messageCount: number;
  firstMessageText: string | undefined;
  name: string | undefined;
}

function createEmptyFold(): SummaryFoldState {
  return { header: undefined, rejected: false, messageCount: 0, firstMessageText: undefined, name: undefined };
}

/** One scanned session file: what it was read as, and what folding it produced. */
interface ScannedSessionFile {
  dev: number;
  ino: number;
  /** Observed end-of-file offset after the read. */
  size: number;
  mtime: Date;
  /** Summary state for the whole file, including any unterminated trailing line. */
  fold: SummaryFoldState;
}

/** Open a session file for reading and fstat the opened handle. */
async function openSessionFile(filePath: string): Promise<{ file: FileHandle; stats: Stats } | undefined> {
  let file: FileHandle | undefined;
  try {
    file = await open(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    const stats = await file.stat();
    return { file, stats };
  } catch {
    await file.close().catch(() => undefined);
    return undefined;
  }
}

/**
 * Open `filePath`, fold its entire contents, and report the identity and
 * metadata of the handle it actually read — never of the pathname, so a
 * concurrent replacement is described by whichever file was opened rather
 * than by a stat that may already be stale.
 *
 * Returns undefined when the file cannot be read (unreadable, or it vanished
 * mid-scan): one corrupt file must not break the listing, and the SDK skips
 * such files too.
 */
async function scanWholeSessionFile(filePath: string, chunkBuffer: () => Buffer): Promise<ScannedSessionFile | undefined> {
  const opened = await openSessionFile(filePath);
  if (opened === undefined) return undefined;
  const { file, stats } = opened;
  try {
    const fold = createEmptyFold();
    const endOffset = await foldFileLines(file, fold, chunkBuffer());
    // Rejection is final — the first parseable line decides it — so the fold
    // stops early and the observed file size, not the read offset, is what a
    // later listing must compare against to take the stat-only fast path.
    const size = fold.rejected ? Math.max(stats.size, endOffset) : endOffset;
    return { dev: stats.dev, ino: stats.ino, size, mtime: stats.mtime, fold };
  } catch {
    return undefined;
  } finally {
    await file.close().catch(() => undefined);
  }
}

/**
 * Fold every line of an open session file into `fold`, returning the observed
 * end-of-file offset. The caller owns the handle and keeps it open for the
 * whole fold, so the fold always reads the file it was opened on, even if the
 * path is replaced concurrently.
 */
async function foldFileLines(file: FileHandle, fold: SummaryFoldState, chunkBuffer: Buffer): Promise<number> {
  let position = 0;
  let pendingChunks: Buffer[] = [];
  for (;;) {
    const { bytesRead } = await file.read(chunkBuffer, 0, chunkBuffer.length, position);
    if (bytesRead === 0) {
      // Final line without a trailing newline (foreign writers, or a line
      // still being written when we read): fold it into this listing's
      // result. Once bytes follow it the file's size differs from the
      // memoized one, so the whole file is folded again and no line is ever
      // counted twice.
      if (pendingChunks.length > 0) {
        const whole = Buffer.concat(pendingChunks);
        processLineBytes(whole, 0, whole.length, fold);
      }
      return position;
    }
    const data = chunkBuffer.subarray(0, bytesRead);
    let lineStart = 0;
    let newlineAt = data.indexOf(NEWLINE);
    while (newlineAt !== -1) {
      if (pendingChunks.length > 0) {
        // A line longer than one chunk: join the saved pieces and finish it.
        pendingChunks.push(Buffer.from(data.subarray(lineStart, newlineAt)));
        const whole = Buffer.concat(pendingChunks);
        pendingChunks = [];
        processLineBytes(whole, 0, whole.length, fold);
      } else {
        processLineBytes(data, lineStart, newlineAt, fold);
      }
      if (fold.rejected) return position + bytesRead;
      lineStart = newlineAt + 1;
      newlineAt = data.indexOf(NEWLINE, lineStart);
    }
    if (lineStart < bytesRead) pendingChunks.push(Buffer.from(data.subarray(lineStart)));
    position += bytesRead;
  }
}

/** The listing entry for a fold, or undefined when the file is not a usable session. */
function buildSummaryFromFold(fold: SummaryFoldState, filePath: string, mtime: Date): PiSessionListEntry | undefined {
  if (fold.rejected || fold.header === undefined) return undefined;
  const id = fold.header["id"];
  // The SDK would list a header without a usable id; downstream lookups then
  // call `.startsWith` on it and crash. Skip such files instead.
  if (typeof id !== "string" || id === "") return undefined;

  const headerCwd = fold.header["cwd"];
  const parentSessionPath = fold.header["parentSession"];
  const headerTimestamp = fold.header["timestamp"];
  return {
    path: filePath,
    id,
    cwd: typeof headerCwd === "string" ? headerCwd : "",
    created: typeof headerTimestamp === "string" || typeof headerTimestamp === "number" ? new Date(headerTimestamp) : new Date(Number.NaN),
    modified: mtime,
    messageCount: fold.messageCount,
    firstMessage: fold.firstMessageText ?? "(no messages)",
    // Never built: see the listing contract above. Kept because SDK-built
    // entries (cleanup listing) still carry the field.
    allMessagesText: "",
    ...(fold.name === undefined ? {} : { name: fold.name }),
    ...(typeof parentSessionPath === "string" ? { parentSessionPath } : {}),
  };
}

/** Classify and fold one line, addressed as bytes inside `data`. */
function processLineBytes(data: Buffer, start: number, end: number, state: SummaryFoldState): void {
  // Readline parity: a CRLF file yields lines without their trailing `\r`.
  if (end > start && data[end - 1] === CARRIAGE_RETURN) end -= 1;

  if (state.header === undefined) {
    const outcome = classifyPreHeaderLine(data.toString("utf8", start, end));
    if (outcome === "skip") return;
    if (outcome === "reject") {
      state.rejected = true;
      return;
    }
    state.header = outcome;
    return;
  }

  const entryType = classifyLineType(data, start, end);
  if (entryType === "session_info") {
    const entry = tryParseEntry(data.toString("utf8", start, end));
    if (entry !== undefined) state.name = sessionInfoName(entry);
    return;
  }
  if (entryType === "message") {
    // A line still being written can be complete JSON only if its last
    // significant byte is `}`; treating anything else as malformed matches
    // the SDK, which skips unparseable lines. Ending in `}` counts the line
    // without validating its JSON — a torn final write adds a transient +1
    // that self-heals when the line completes (see messageCount's contract).
    if (!endsWithClosingBrace(data, start, end)) return;
    state.messageCount += 1;
    // The expensive part of a listing was parsing message bodies; decode and
    // parse only until the first user text message is known.
    if (state.firstMessageText !== undefined) return;
    const entry = tryParseEntry(data.toString("utf8", start, end));
    if (entry !== undefined) {
      const userText = firstUserMessageText(entry);
      if (userText !== undefined) state.firstMessageText = userText;
    }
    return;
  }
  if (entryType !== undefined) return;

  // Lines that do not start with the SDK-style `{"type":"..."}` prefix
  // (foreign writers, garbage) fall back to a parse so they are classified
  // exactly like the SDK would.
  const entry = tryParseEntry(data.toString("utf8", start, end));
  if (entry === undefined) return;
  if (entry["type"] === "session_info") state.name = sessionInfoName(entry);
  else if (entry["type"] === "message") {
    state.messageCount += 1;
    if (state.firstMessageText === undefined) {
      const userText = firstUserMessageText(entry);
      if (userText !== undefined) state.firstMessageText = userText;
    }
  }
}

/**
 * The entry type from a line's leading bytes, without decoding it. The type
 * bytes are compared directly against the known SDK entry types: decoding
 * them first would mask each byte's high bit — `Buffer.toString("ascii")`
 * turns bytes like `ed e5 f3 f3 e1 e7 e5` into "message" — fabricating
 * matches for corrupt input. Returns "other" when the line carries the
 * SDK-style prefix but not a known type (only message/session_info matter
 * for the summary, so such lines need no parse), or undefined when the line
 * does not carry the prefix (or the type is unreasonably long), leaving
 * classification to the parse fallback.
 */
function classifyLineType(data: Buffer, start: number, end: number): "message" | "session_info" | "other" | undefined {
  const prefixLength = ENTRY_TYPE_PREFIX.length;
  if (end - start < prefixLength + 1) return undefined;
  for (let i = 0; i < prefixLength; i += 1) {
    if (data[start + i] !== ENTRY_TYPE_PREFIX[i]) return undefined;
  }
  const searchLimit = Math.min(end, start + prefixLength + MAX_CLASSIFIED_TYPE_LENGTH);
  const closeAt = data.indexOf(TYPE_QUOTE, start + prefixLength);
  if (closeAt === -1 || closeAt > searchLimit) return undefined;
  if (sameBytes(data, start + prefixLength, closeAt, MESSAGE_TYPE_BYTES)) return "message";
  if (sameBytes(data, start + prefixLength, closeAt, SESSION_INFO_TYPE_BYTES)) return "session_info";
  return "other";
}

/** Whether `data[start, end)` holds exactly `expected`'s bytes. */
function sameBytes(data: Buffer, start: number, end: number, expected: Buffer): boolean {
  if (end - start !== expected.length) return false;
  return expected.compare(data, start, end) === 0;
}

/**
 * Whether the line's last significant byte is `}`, skipping trailing spaces,
 * tabs, and carriage returns: JSON.parse (and therefore the SDK) tolerates
 * that whitespace, so valid message lines with it still count.
 */
function endsWithClosingBrace(data: Buffer, start: number, end: number): boolean {
  let last = end;
  while (last > start) {
    const byte = data[last - 1];
    if (byte !== SPACE && byte !== TAB && byte !== CARRIAGE_RETURN) break;
    last -= 1;
  }
  return last > start && data[last - 1] === CLOSING_BRACE;
}

/**
 * First parseable entry of a session file must be its session header —
 * exactly the SDK's rule: unparseable lines are skipped until one parses, and
 * a parseable non-session entry disqualifies the file.
 */
function classifyPreHeaderLine(line: string): Record<string, unknown> | "skip" | "reject" {
  const entry = tryParseEntry(line);
  if (entry === undefined) return "skip";
  if (entry["type"] !== "session") return "reject";
  return entry;
}

/** The SDK's name rule: latest `session_info` wins, and empty/missing names clear. */
function sessionInfoName(entry: Record<string, unknown>): string | undefined {
  const value = entry["name"];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The first user message with non-empty text content, mirroring the SDK's
 * `firstMessage` extraction (role/content shape checks and text-block join).
 */
function firstUserMessageText(entry: Record<string, unknown>): string | undefined {
  const message = entry["message"];
  if (!isRecord(message)) return undefined;
  if (message["role"] !== "user" || !("content" in message)) return undefined;
  const text = extractTextContent(message["content"]);
  return text === "" ? undefined : text;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block["type"] !== "text") continue;
    const text = block["text"];
    if (typeof text === "string") texts.push(text);
  }
  return texts.join(" ");
}

async function listSessionFilesInDir(sessionDir: string): Promise<string[]> {
  let fileNames: string[];
  try {
    fileNames = await readdir(sessionDir);
  } catch {
    // Matches the SDK listing behavior: an unreadable directory lists nothing.
    return [];
  }
  return fileNames.filter((name) => name.endsWith(".jsonl")).map((name) => join(sessionDir, name));
}

function sortedSessionSummaries(summaries: readonly (PiSessionListEntry | undefined)[]): PiSessionListEntry[] {
  const sessions = summaries.filter((summary): summary is PiSessionListEntry => summary !== undefined);
  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return sessions;
}

async function scanSessionFilesWithBoundedConcurrency(
  files: readonly string[],
  chunkBytes: number,
  scan: (file: string, chunkBuffer: () => Buffer) => Promise<PiSessionListEntry | undefined>,
): Promise<(PiSessionListEntry | undefined)[]> {
  const results: (PiSessionListEntry | undefined)[] = Array.from({ length: files.length }, () => undefined);
  let nextIndex = 0;
  const workerCount = Math.min(MAX_CONCURRENT_SESSION_SUMMARY_SCANS, files.length);
  const workers = Array.from({ length: workerCount }, async () => {
    // One reusable read buffer per worker, allocated on first use: warm
    // listings answer every file from the memo's stat-only fast path and
    // must not pay a chunk-sized allocation per worker for reads that
    // never happen.
    let chunkBuffer: Buffer | undefined;
    const readBuffer = (): Buffer => (chunkBuffer ??= Buffer.allocUnsafe(chunkBytes));
    for (;;) {
      const index = nextIndex++;
      const file = files[index];
      if (file === undefined) return;
      results[index] = await scan(file, readBuffer).catch(() => undefined);
    }
  });
  await Promise.all(workers);
  return results;
}
