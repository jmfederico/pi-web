import type { Dirent } from "node:fs";
import { createReadStream as nodeCreateReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionInfo, SessionRef } from "../../../shared/apiTypes.js";
import { cwdPathsEqual } from "../../workingDirectory.js";

/**
 * Read-only discovery over OMP's on-disk session tree
 * (`<agentDir>/sessions/<project>/<timestamp>_<uuid>.jsonl`).
 *
 * File format (v3, traced against a live `~/.omp/agent/sessions/` tree and
 * the installed `@oh-my-pi/pi-coding-agent` package used purely as a
 * reference, never a runtime dependency — it is Bun-only):
 * an optional `{"type":"title",...}` slot line, then the
 * `{"type":"session",...}` header line, then entries forming a tree via
 * `(id, parentId)`. Subagent transcripts live one level deeper, inside a
 * directory named after their parent session file (minus `.jsonl`), and can
 * themselves carry a fully-valid header — this store only ever scans
 * `sessions/<project>/*.jsonl` (one level), never descending into those
 * per-session artifact directories, so a subagent transcript is never
 * mistaken for a root session.
 *
 * Discovery (list/listAll/resolve) reads each candidate file through an
 * injectable stream — real `fs.createReadStream` by default — with its own
 * bounded, incremental line-splitting: a candidate whose header cwd doesn't
 * match the query is abandoned right after the header line instead of being
 * read to EOF, and any single logical record (line) is capped at a generous
 * local ceiling so a corrupt or hostile unterminated write cannot buffer
 * unboundedly in memory. File-level work itself is bounded to a small
 * concurrent fan-out rather than opening every candidate file at once.
 */

const OMP_ID_PREFIX = "omp:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLOB_REF_PREFIX = "blob:sha256:";
const BLOB_HASH_PATTERN = /^[0-9a-f]{64}$/;
// A generous local ceiling on a single JSONL logical record (line), matching
// the same native reassembled-frame bound used elsewhere in this backend for
// logical frames. This is not the RPC wire transport's much smaller physical
// frame limit: a persisted record is a logical unit and a legitimate large
// one (e.g. a big pasted file) must remain fully discoverable.
const MAX_SESSION_RECORD_BYTES = 64 * 1024 * 1024;
// Caps how many candidate session files this store opens at once during a
// scan, so one huge project directory cannot fan out into hundreds of
// concurrent file handles/streams.
const MAX_CONCURRENT_SESSION_FILE_READS = 20;

export function toOmpSessionId(nativeId: string): string {
  return `${OMP_ID_PREFIX}${nativeId}`;
}

export function fromOmpSessionId(id: string): string {
  if (!id.startsWith(OMP_ID_PREFIX)) throw new Error(`Invalid OMP session id: expected the "${OMP_ID_PREFIX}" prefix`);
  const nativeId = id.slice(OMP_ID_PREFIX.length);
  if (!UUID_PATTERN.test(nativeId)) throw new Error(`Invalid OMP session id: "${nativeId}" is not a valid session UUID`);
  return nativeId;
}

interface ParsedSessionHeader {
  id: string;
  cwd: string;
  timestamp: string | undefined;
}

interface ParsedTitleSlot {
  title: string;
  source: string | undefined;
}

interface ParsedSessionFile {
  path: string;
  mtimeMs: number;
  header: ParsedSessionHeader | undefined;
  titleSlot: ParsedTitleSlot | undefined;
  headerEmbeddedTitle: string | undefined;
  entries: Record<string, unknown>[];
}

interface ResolvedSessionFile {
  path: string;
  header: ParsedSessionHeader;
}

/** `NodeJS.ReadableStream` plus the optional destroy surface real Node
 * streams (`fs.ReadStream`, `PassThrough`, ...) expose. Declaring it
 * explicitly lets `readLinesBounded` clean up an abandoned stream with real
 * typing instead of an unsafe dynamic `"destroy" in stream` probe. */
export interface DestroyableReadStream extends NodeJS.ReadableStream {
  destroy?(error?: Error): void;
  readonly destroyed?: boolean;
}

export interface OmpSessionStoreDependencies {
  /** Test-only injection seam: real callers omit it and get the actual
   * `fs.createReadStream`. Deliberately low-level (a raw byte stream, not a
   * pre-split line) so tests exercise this store's own buffering/
   * line-splitting logic. */
  createReadStream?: (path: string) => DestroyableReadStream;
}

export class OmpSessionStore {
  private readonly agentDir: string;
  private readonly createReadStream: (path: string) => DestroyableReadStream;

  constructor(agentDir: string, dependencies: OmpSessionStoreDependencies = {}) {
    this.agentDir = agentDir;
    this.createReadStream = dependencies.createReadStream ?? nodeCreateReadStream;
  }

  async list(cwd: string): Promise<SessionInfo[]> {
    return this.scanAll((header) => cwdPathsEqual(header.cwd, cwd));
  }

  async listAll(): Promise<SessionInfo[]> {
    return this.scanAll(() => true);
  }

  async resolve(ref: SessionRef): Promise<{ path: string; nativeId: string }> {
    const file = await this.findSessionFile(ref);
    return { path: file.path, nativeId: file.header.id };
  }

  async messages(ref: SessionRef): Promise<unknown[]> {
    const found = await this.findSessionFile(ref);
    const file = await this.parseSessionFile(found.path, () => true);
    if (!file?.header) throw new Error(`OMP session not found: ${ref.id}`);
    const branch = activeBranchEntries(file.entries);
    await resolveImageBlobsInEntries(branch, join(this.agentDir, "blobs"));
    return branch;
  }

  /** Locates the one file matching `ref` by scanning every candidate's
   * header only — resolve()/messages() never need entries during this
   * search, so every candidate is abandoned right after its header line. */
  private async findSessionFile(ref: SessionRef): Promise<ResolvedSessionFile> {
    const nativeId = fromOmpSessionId(ref.id);
    const paths = await listSessionFilePaths(this.agentDir);
    const files = await this.scanWithConcurrency(paths, () => false);
    for (const file of files) {
      if (file.header?.id === nativeId && cwdPathsEqual(file.header.cwd, ref.cwd)) {
        return { path: file.path, header: file.header };
      }
    }
    throw new Error(`OMP session not found: ${ref.id}`);
  }

  private async scanAll(shouldReadEntries: (header: ParsedSessionHeader) => boolean): Promise<SessionInfo[]> {
    const paths = await listSessionFilePaths(this.agentDir);
    const files = await this.scanWithConcurrency(paths, shouldReadEntries);
    const infos: SessionInfo[] = [];
    for (const file of files) {
      if (!file.header || !shouldReadEntries(file.header)) continue;
      const summary = summarizeEntries(file.entries);
      const title = resolveTitle(file.titleSlot, file.headerEmbeddedTitle);
      const modified = new Date(file.mtimeMs).toISOString();
      const info: SessionInfo = {
        id: toOmpSessionId(file.header.id),
        cwd: file.header.cwd,
        path: file.path,
        created: file.header.timestamp ?? modified,
        modified,
        messageCount: summary.messageCount,
        firstMessage: summary.firstMessage || "(no messages)",
      };
      if (title !== undefined) info.name = title;
      infos.push(info);
    }
    infos.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    return infos;
  }

  private async scanWithConcurrency(
    paths: string[],
    shouldReadEntries: (header: ParsedSessionHeader) => boolean,
  ): Promise<ParsedSessionFile[]> {
    const results = await mapWithConcurrency(paths, MAX_CONCURRENT_SESSION_FILE_READS, (path) =>
      this.parseSessionFile(path, shouldReadEntries),
    );
    return results.filter((file): file is ParsedSessionFile => file !== undefined);
  }

  /** Streams `path` line-by-line: an optional title-slot line, the header
   * line, then entries. `shouldReadEntries(header)` is consulted the instant
   * a valid header is parsed — returning `false` (e.g. a non-matching cwd
   * for `list(cwd)`, or a header-only search) abandons the stream right
   * there instead of reading the remainder of the file. Any single
   * unterminated line that grows past `MAX_SESSION_RECORD_BYTES` poisons the
   * whole file (returns `undefined`, matching every other "can't parse this
   * file" case) rather than reporting degraded/empty metadata for it. */
  private async parseSessionFile(
    path: string,
    shouldReadEntries: (header: ParsedSessionHeader) => boolean,
  ): Promise<ParsedSessionFile | undefined> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      return undefined;
    }

    let stream: DestroyableReadStream;
    try {
      stream = this.createReadStream(path);
    } catch {
      return undefined;
    }

    let phase: "titleOrHeader" | "header" | "entries" = "titleOrHeader";
    let titleSlot: ParsedTitleSlot | undefined;
    let header: ParsedSessionHeader | undefined;
    let headerEmbeddedTitle: string | undefined;
    const entries: Record<string, unknown>[] = [];

    const parseHeaderLine = (record: Record<string, unknown> | undefined): boolean => {
      if (
        record?.["type"] === "session" &&
        typeof record["id"] === "string" &&
        UUID_PATTERN.test(record["id"]) &&
        typeof record["cwd"] === "string"
      ) {
        header = {
          id: record["id"],
          cwd: record["cwd"],
          timestamp: typeof record["timestamp"] === "string" ? record["timestamp"] : undefined,
        };
        headerEmbeddedTitle = typeof record["title"] === "string" ? record["title"] : undefined;
      }
      if (header === undefined) return false; // No valid header: nothing else in this file matters.
      if (!shouldReadEntries(header)) return false; // e.g. cwd mismatch, or a header-only search.
      return true;
    };

    try {
      await readLinesBounded(stream, (rawLine) => {
        const line = rawLine.trim();
        if (line.length === 0) return true; // Blank lines never occupy a structural slot.
        const record = tryParseJsonRecord(line);
        if (phase === "titleOrHeader") {
          if (record?.["type"] === "title") {
            titleSlot = {
              title: typeof record["title"] === "string" ? record["title"] : "",
              source: typeof record["source"] === "string" ? record["source"] : undefined,
            };
            phase = "header";
            return true;
          }
          phase = "entries"; // No title slot: this line IS the header line.
          return parseHeaderLine(record);
        }
        if (phase === "header") {
          phase = "entries";
          return parseHeaderLine(record);
        }
        if (record) entries.push(record);
        return true;
      });
    } catch {
      return undefined;
    }

    return { path, mtimeMs, header, titleSlot, headerEmbeddedTitle, entries };
  }
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Direct children of `<agentDir>/sessions/<project>/*.jsonl` only — never the per-session artifact directories living alongside them. */
async function listSessionFilePaths(agentDir: string): Promise<string[]> {
  const sessionsRoot = join(agentDir, "sessions");
  let projectDirs: Dirent[];
  try {
    projectDirs = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return [];
    throw error;
  }

  const paths: string[] = [];
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    const projectPath = join(sessionsRoot, projectDir.name);
    let files: Dirent[];
    try {
      files = await readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.isFile() && file.name.endsWith(".jsonl")) paths.push(join(projectPath, file.name));
    }
  }
  return paths;
}

function tryParseJsonRecord(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    // A JSON object literal always satisfies a string-keyed record; this is
    // the standard, narrow escape hatch for a JSON.parse boundary, not a
    // trust-then-access shortcut — every field is still read defensively
    // below via typeof checks before use.
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- JSON.parse boundary: a validated non-null, non-array `object` has no index signature TS can derive from `typeof`/`Array.isArray` alone.
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Skip a malformed line (torn write) rather than failing the whole file.
  }
  return undefined;
}

/** Reads `stream` incrementally, invoking `onLine` for each newline-terminated
 * (or final, EOF-terminated) line. `onLine` returning `false` stops reading
 * immediately — the stream is destroyed and the promise resolves without
 * waiting for EOF, the seam `parseSessionFile` uses to abandon a
 * non-matching or already-decided file early. A single line whose buffered,
 * still-unterminated bytes exceed `MAX_SESSION_RECORD_BYTES` rejects instead
 * of continuing to accumulate — the stream is destroyed either way. */
function readLinesBounded(stream: DestroyableReadStream, onLine: (line: string) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    let settled = false;
    const decoder = new TextDecoder();

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      stream.removeAllListeners("data");
      stream.removeAllListeners("end");
      const complete = (): void => {
        stream.removeAllListeners("error");
        if (error) reject(error);
        else resolve();
      };
      // EOF/destroy() can precede the asynchronous file-descriptor close.
      // Hold the worker slot until close, not merely until parsing ends.
      if (typeof stream.destroy === "function" && !("closed" in stream && stream.closed === true)) {
        stream.once("close", complete);
        stream.destroy();
      } else {
        complete();
      }
    };

    stream.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let newlineIndex = buffered.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffered.slice(0, newlineIndex);
        buffered = buffered.slice(newlineIndex + 1);
        if (!onLine(line)) {
          finish();
          return;
        }
        newlineIndex = buffered.indexOf("\n");
      }
      if (Buffer.byteLength(buffered, "utf8") > MAX_SESSION_RECORD_BYTES) {
        finish(new Error(`session record exceeds the local ${String(MAX_SESSION_RECORD_BYTES)}-byte ceiling`));
      }
    });
    stream.on("end", () => {
      if (settled) return;
      buffered += decoder.decode();
      if (buffered.length > 0) onLine(buffered);
      finish();
    });
    stream.on("error", (error: Error) => {
      finish(error);
    });
  });
}

/** Runs `fn` over `items` with at most `limit` concurrent in-flight calls,
 * preserving input order in the returned results. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  const iterator = items.entries();
  async function worker(): Promise<void> {
    for (let next = iterator.next(); next.done !== true; next = iterator.next()) {
      const [index, item] = next.value;
      results[index] = await fn(item);
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/** Title-slot precedence: a present slot always wins (an empty slot explicitly clears the title, even over a stale header-embedded value); a legacy file with no slot at all falls back to the header's own title. */
function resolveTitle(titleSlot: ParsedTitleSlot | undefined, headerEmbeddedTitle: string | undefined): string | undefined {
  if (titleSlot) return titleSlot.title ? titleSlot.title : undefined;
  return headerEmbeddedTitle;
}

function isTextContentBlock(value: unknown): value is { text: string } {
  return typeof value === "object" && value !== null && "type" in value && value.type === "text" && "text" in value && typeof value.text === "string";
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isTextContentBlock(block)) parts.push(block.text);
  }
  return parts.join(" ");
}

function messageRoleAndContent(entry: Record<string, unknown>): { role: string | undefined; content: unknown } | undefined {
  if (entry["type"] !== "message") return undefined;
  const message = entry["message"];
  if (typeof message !== "object" || message === null) return undefined;
  const role = "role" in message && typeof message.role === "string" ? message.role : undefined;
  const content = "content" in message ? message.content : undefined;
  return { role, content };
}

function summarizeEntries(entries: Record<string, unknown>[]): { messageCount: number; firstMessage: string } {
  let messageCount = 0;
  let firstMessage = "";
  for (const entry of entries) {
    const parsed = messageRoleAndContent(entry);
    if (!parsed) continue;
    messageCount++;
    if (!firstMessage && parsed.role === "user") firstMessage = extractTextFromContent(parsed.content);
  }
  return { messageCount, firstMessage };
}

/**
 * Reconstructs the persisted active branch: walk `parentId` backward from
 * the last-appended entry to the root, discarding any earlier fork's
 * abandoned descendants, then return the chain oldest-first. Matches omp's
 * own "persisted leaf is the last appended entry" semantics.
 */
function activeBranchEntries(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const id = entry["id"];
    if (typeof id === "string") byId.set(id, entry);
  }
  const last = entries[entries.length - 1];
  if (!last) return [];

  const chain: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let current: Record<string, unknown> | undefined = last;
  while (current !== undefined) {
    const entry: Record<string, unknown> = current;
    const id = entry["id"];
    if (typeof id === "string") {
      if (visited.has(id)) break; // Guard against a corrupt/cyclic parent chain.
      visited.add(id);
    }
    chain.push(entry);
    const parentId: unknown = entry["parentId"];
    current = typeof parentId === "string" ? byId.get(parentId) : undefined;
  }
  return chain.reverse();
}

/**
 * Resolves `blob:sha256:<hash>` image references in place, mirroring the
 * installed OMP package's own `resolvePersistedBlobRefs` contract
 * (session/session-loader.ts, session/blob-store.ts). A missing blob leaves
 * the reference unchanged rather than throwing, and a hash suffix that
 * fails the canonical 64-char lowercase-hex shape is treated as not a blob
 * reference at all, so it is never used to read outside the blob store.
 * Covers all three canonical externalization positions:
 * - `{type:"image", data, mimeType}` content blocks — base64 (resolveImageData).
 * - `{type:"image_generation_call", result}` — base64 (resolveImageData); the
 *   stored bytes are already-base64 image data either way.
 * - any `{..., image_url}` position — UTF-8 (resolveImageDataUrl): the
 *   externalized value is the ORIGINAL data-url *string* stored verbatim as
 *   UTF-8 bytes, not base64-decoded binary, so restoring it is a UTF-8
 *   decode, not a base64 one — the one place these positions are not
 *   interchangeable.
 */
async function resolveImageBlobsInEntries(entries: Record<string, unknown>[], blobsDir: string): Promise<void> {
  await Promise.all(entries.map((entry) => resolveBlobRefsInValue(entry, blobsDir)));
}

async function resolveBlobRefsInValue(value: unknown, blobsDir: string): Promise<void> {
  if (Array.isArray(value)) {
    await Promise.all(value.map((item) => resolveBlobRefsInValue(item, blobsDir)));
    return;
  }
  if (typeof value !== "object" || value === null) return;

  if ("type" in value && value.type === "image" && "data" in value && typeof value.data === "string") {
    const resolved = await resolveBase64BlobRef(value.data, blobsDir);
    if (resolved !== undefined) value.data = resolved;
  }
  if ("type" in value && value.type === "image_generation_call" && "result" in value && typeof value.result === "string") {
    const resolved = await resolveBase64BlobRef(value.result, blobsDir);
    if (resolved !== undefined) value.result = resolved;
  }
  if ("image_url" in value && typeof value.image_url === "string") {
    const resolved = await resolveUtf8BlobRef(value.image_url, blobsDir);
    if (resolved !== undefined) value.image_url = resolved;
  }
  await Promise.all(Object.values(value).map((nested) => resolveBlobRefsInValue(nested, blobsDir)));
}

async function resolveBase64BlobRef(data: string, blobsDir: string): Promise<string | undefined> {
  const hash = parseBlobRef(data);
  if (hash === undefined) return undefined;
  const bytes = await readBlobBytes(blobsDir, hash);
  return bytes?.toString("base64");
}

async function resolveUtf8BlobRef(data: string, blobsDir: string): Promise<string | undefined> {
  const hash = parseBlobRef(data);
  if (hash === undefined) return undefined;
  const bytes = await readBlobBytes(blobsDir, hash);
  return bytes?.toString("utf8");
}

function parseBlobRef(data: string): string | undefined {
  if (!data.startsWith(BLOB_REF_PREFIX)) return undefined;
  const hash = data.slice(BLOB_REF_PREFIX.length);
  return BLOB_HASH_PATTERN.test(hash) ? hash : undefined;
}

async function readBlobBytes(blobsDir: string, hash: string): Promise<Buffer | undefined> {
  try {
    return await readFile(join(blobsDir, hash));
  } catch {
    return undefined;
  }
}
