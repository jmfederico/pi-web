import type { Dirent, Stats } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AGENT_SESSION_DIR_ENV_KEYS } from "../../config.js";
import { canonicalizeStoredCwd, cwdPathsEqual } from "../workingDirectory.js";
import { isNodeErrorWithCode } from "../workspaces/pathSafety.js";
import { readSessionHeaderSummary, type SessionHeaderReader } from "./sessionFileHeader.js";
import { tryParseEntry } from "./sessionFileFormat.js";
import { SessionSummaryScanner } from "./sessionSummaryScanner.js";
import { TranscriptBranchCache, type TranscriptBranchSnapshot } from "./transcriptBranchCache.js";
import type { PiSessionListEntry, PiSessionManager, PiSessionManagerGateway, ResolvedSessionFile } from "./piSessionService.js";

type SessionDirSource = "env" | "settings" | "pi-default";

export interface SessionDirResolution {
  source: SessionDirSource;
  sessionDir: string;
  usesConfiguredSessionDir: boolean;
}

export interface SessionDirResolverOptions {
  agentDir: string;
  env: Readonly<NodeJS.ProcessEnv>;
}

export class SessionDirResolver {
  private readonly agentDir: string;
  private readonly envSessionDir: string | undefined;
  private readonly homeDir: string;

  constructor(options: SessionDirResolverOptions) {
    this.agentDir = options.agentDir;
    // Session storage override policy: the deprecated PI_WEB_ alias keeps
    // winning when both are set, then the canonical pi SDK name (see
    // AGENT_SESSION_DIR_ENV_KEYS).
    this.envSessionDir = AGENT_SESSION_DIR_ENV_KEYS
      .map((key) => options.env[key])
      .find((value) => value !== undefined && value !== "");
    const configuredHome = options.env["HOME"];
    this.homeDir = configuredHome !== undefined && configuredHome !== "" && isAbsolute(configuredHome) ? configuredHome : homedir();
  }

  defaultSessionsRoot(): string {
    return defaultPiSessionsRoot(this.agentDir);
  }

  globalEnvSessionDir(): string | undefined {
    if (this.envSessionDir === undefined) return undefined;
    const expanded = expandTildePath(this.envSessionDir, this.homeDir);
    return isAbsolute(expanded) ? expanded : undefined;
  }

  resolve(cwd: string): SessionDirResolution {
    if (this.envSessionDir !== undefined) {
      return { source: "env", sessionDir: resolveConfiguredPath(this.envSessionDir, cwd, this.homeDir), usesConfiguredSessionDir: true };
    }

    const settingsSessionDir = SettingsManager.create(cwd, this.agentDir).getSessionDir();
    if (settingsSessionDir !== undefined && settingsSessionDir !== "") {
      return { source: "settings", sessionDir: resolveConfiguredPath(settingsSessionDir, cwd, this.homeDir), usesConfiguredSessionDir: true };
    }

    return { source: "pi-default", sessionDir: defaultPiSessionDir(cwd, this.agentDir), usesConfiguredSessionDir: false };
  }
}

export type PiSessionManagerGatewayOptions = SessionDirResolverOptions;

export function createPiSessionManagerGateway(options: PiSessionManagerGatewayOptions): PiSessionManagerGateway {
  return new SettingsAwarePiSessionManagerGateway(new SessionDirResolver(options));
}

class SettingsAwarePiSessionManagerGateway implements PiSessionManagerGateway {
  /**
   * One memoized scanner per gateway: its per-file summary memo lives as long
   * as the daemon, so repeated listings answer unchanged files from one stat
   * and re-scan changed ones whole. Invalidation is automatic (file identity +
   * size; see SessionSummaryScanner), with `invalidateSessionFile` for the
   * in-place rewrites those checks cannot see.
   */
  private readonly summaryScanner = new SessionSummaryScanner();
  // Idle-session transcript snapshots, memoized by file signature and bounded
  // (LRU) so daemon-lifetime polling cannot retain every session ever read.
  // Snapshots keep their parsed entries so a file that grew by append only is
  // extended from the appended bytes instead of re-parsed whole.
  private readonly transcriptBranches = new TranscriptBranchCache();
  // In-flight snapshot reads, deduplicated per path. Each entry removes itself
  // when its read settles, so this map only ever holds genuinely concurrent
  // reads and needs no bound of its own.
  private readonly pendingTranscriptBranches = new Map<string, Promise<unknown[] | undefined>>();

  constructor(private readonly resolver: SessionDirResolver) {}

  async list(cwd: string): Promise<PiSessionListEntry[]> {
    const resolution = this.resolver.resolve(cwd);
    // Lightweight streaming summaries instead of the SDK's full-transcript
    // listing: same fields, but message bodies are never parsed once the first
    // user message is found. The cross-project cleanup listing (listAll) keeps
    // the SDK path.
    const sessions = (await this.summaryScanner.scanSessionSummariesInDir(resolution.sessionDir)).map((session) => ({
      ...session,
      cwd: canonicalizeStoredCwd(session.cwd),
    }));
    return filterSessionsForCwd(sessions, cwd);
  }

  resolveSessionFile(cwd: string, sessionId: string): Promise<ResolvedSessionFile | undefined> {
    const resolution = this.resolver.resolve(cwd);
    return resolveSessionFileInDir(resolution.sessionDir, cwd, sessionId, readSessionHeaderSummary);
  }

  invalidateSessionFile(sessionFile: string): void {
    // Detach is the only flow that rewrites a session file in place (keeping
    // the inode), and the summary memo cannot detect such rewrites from
    // identity + size alone. Drop the entry so the next listing re-reads it.
    this.summaryScanner.invalidate(sessionFile);
  }

  create(cwd: string, options?: { parentSession?: string }): PiSessionManager {
    const resolution = this.resolver.resolve(cwd);
    return SessionManager.create(cwd, resolution.sessionDir, options?.parentSession === undefined ? undefined : { parentSession: options.parentSession });
  }

  async readBranch(path: string): Promise<unknown[] | undefined> {
    // A session whose path is known may still have no file on disk (created in
    // memory, never persisted) or be removed externally at any moment. Absence
    // is not a failure: it means there is no disk snapshot to serve.
    const file = await statIfPresent(path);
    if (file === undefined) return undefined;
    const signature = transcriptFileSignature(file);
    const cached = this.transcriptBranches.get(path, signature);
    if (cached !== undefined) return cached.branch;
    const pending = this.pendingTranscriptBranches.get(path);
    if (pending !== undefined) return pending;
    const read = this.readSnapshot(path, file, signature)
      .then((snapshot) => {
        this.transcriptBranches.set(path, snapshot);
        return snapshot.branch;
      })
      .catch((error: unknown) => {
        // Deleted between the stat above and the read: again, no snapshot.
        if (isNodeErrorWithCode(error, "ENOENT")) return undefined;
        throw error;
      })
      .finally(() => { this.pendingTranscriptBranches.delete(path); });
    this.pendingTranscriptBranches.set(path, read);
    return read;
  }

  /**
   * Parse the transcript snapshot for `path`. When the memoized snapshot's
   * file grew by append only — same identity, larger size, and the appended
   * bytes start on a line boundary — parse just those bytes and extend the
   * memoized entries; any anomaly falls back to a full re-read.
   */
  private async readSnapshot(path: string, file: Stats, signature: string): Promise<TranscriptBranchSnapshot> {
    const identity = transcriptFileIdentity(file);
    const previous = this.transcriptBranches.getLatest(path);
    // A zero-size cached prefix has no boundary byte to verify against, but a
    // full re-read of a file that was empty one poll ago is trivial anyway.
    if (previous?.identity === identity && previous.size > 0 && previous.size < file.size) {
      const appended = await readAppendedEntries(path, previous.size, file.size, identity);
      if (appended !== undefined) {
        const entries = [...previous.entries, ...appended];
        return { signature, identity, size: file.size, entries, branch: deriveTranscriptBranch(entries) };
      }
    }
    const entries = parseTranscriptEntries(await readFile(path, "utf8"));
    return { signature, identity, size: file.size, entries, branch: deriveTranscriptBranch(entries) };
  }

  async listAll(): Promise<PiSessionListEntry[]> {
    const envSessionDir = this.resolver.globalEnvSessionDir();
    const [defaultSessions, envSessions] = await Promise.all([
      listSessionsInDefaultPiStore(this.resolver.defaultSessionsRoot()),
      envSessionDir === undefined ? Promise.resolve([]) : listSessionsInDir(envSessionDir),
    ]);
    return uniqueSessionsByPath([...defaultSessions, ...envSessions]);
  }

  open(path: string): PiSessionManager {
    return SessionManager.open(path, dirname(path));
  }
}

/** Stat a transcript path that may be absent; any error other than absence stays a failure. */
async function statIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

/** The device + inode pair that identifies a transcript file independently of its path. */
function transcriptFileIdentity(file: Stats): string {
  return `${String(file.dev)}:${String(file.ino)}`;
}
/** The signature a memoized snapshot is validated against: identity, size, and mtime. */
function transcriptFileSignature(file: Stats): string {
  return `${transcriptFileIdentity(file)}:${String(file.size)}:${String(file.mtimeMs)}`;
}

/**
 * Read and parse only the bytes appended to a transcript since `offset`, the
 * size the memoized snapshot was parsed from.
 *
 * Returns `undefined` when the append assumption does not hold — the file was
 * replaced since the stat that produced `identity`, the byte before the
 * offset is not a line boundary, the first appended line does not parse, or
 * the read came back short (truncated mid-read) — so the caller falls back to
 * a full re-read. An unparseable line later in the chunk is skipped, matching
 * full-read behavior, and a final line still being written simply fails to
 * parse until the next poll completes it.
 */
async function readAppendedEntries(path: string, offset: number, size: number, identity: string): Promise<Record<string, unknown>[] | undefined> {
  const handle = await open(path, "r");
  try {
    const current = await handle.stat();
    if (transcriptFileIdentity(current) !== identity) return undefined;
    // Read the byte before the offset along with the appended bytes: it must
    // end a line, proving the cached prefix still ends on a line boundary in
    // the file's current content (i.e. this really is a pure append).
    const length = size - offset + 1;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset - 1);
    if (bytesRead !== length) return undefined;
    if (buffer[0] !== 0x0a) return undefined;
    const lines = buffer.toString("utf8", 1).split("\n");
    const appended: Record<string, unknown>[] = [];
    let firstLine = true;
    for (const line of lines) {
      const entry = tryParseEntry(line);
      if (entry === undefined) {
        // A first appended line that does not parse means the offset did not
        // land on a real content boundary after all; later lines may be
        // skipped the way a full read skips them.
        if (firstLine && line.trim() !== "") return undefined;
      } else if (entry["type"] !== "session") {
        appended.push(entry);
      }
      firstLine = false;
    }
    return appended;
  } finally {
    await handle.close();
  }
}

/** Parse every entry line in transcript `content`, skipping unreadable lines and session headers. */
function parseTranscriptEntries(content: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of content.split("\n")) {
    const entry = tryParseEntry(line);
    if (entry !== undefined && entry["type"] !== "session") entries.push(entry);
  }
  return entries;
}

/**
 * SDK-compatible active-branch projection with no migration or write side
 * effects: the walk from the last id-bearing entry through `parentId` links,
 * oldest first. Cheap enough to re-run over merged entries after an append.
 */
function deriveTranscriptBranch(entries: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  let leafId: string | undefined;
  for (const entry of entries) {
    const id = entry["id"];
    if (typeof id !== "string") continue;
    byId.set(id, entry);
    leafId = id;
  }
  const branch: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let currentId = leafId;
  while (currentId !== undefined && !visited.has(currentId)) {
    visited.add(currentId);
    const entry = byId.get(currentId);
    if (entry === undefined) break;
    branch.push(entry);
    currentId = typeof entry["parentId"] === "string" ? entry["parentId"] : undefined;
  }
  return branch.reverse();
}

export async function listSessionsInDir(sessionDir: string): Promise<PiSessionListEntry[]> {
  // listAll(sessionDir) lists without the SDK's internal cwd filter, which would
  // otherwise compare against this process's cwd and drop other projects' sessions.
  // Cwd filtering is applied explicitly by filterSessionsForCwd where needed.
  // Session file headers are written by external tools (Pi CLI, SDK consumers),
  // so their cwd is canonicalized here before it enters pi-web.
  const sessions = await SessionManager.listAll(sessionDir);
  return sessions.map((session) => ({ ...session, cwd: canonicalizeStoredCwd(session.cwd) }));
}

export async function listSessionsInDefaultPiStore(storeRoot: string): Promise<PiSessionListEntry[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(storeRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessionDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(storeRoot, entry.name));
  const sessions = (await Promise.all(sessionDirs.map((dir) => listSessionsInDir(dir)))).flat();
  return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function filterSessionsForCwd(sessions: readonly PiSessionListEntry[], cwd: string): PiSessionListEntry[] {
  // Sessions with an empty cwd (old session files) are excluded: resolve("") would
  // resolve to this process's cwd and produce false matches.
  return sessions.filter((session) => session.cwd !== "" && cwdPathsEqual(session.cwd, cwd));
}

/**
 * Locate a session file by id without parsing transcripts.
 *
 * Session filenames embed the session id (`<timestamp>_<sessionId>.jsonl`), so
 * exact and prefix matches are normally found from the directory names alone
 * and confirmed by one header read. Filename candidates that fail header
 * verification (a copy whose header holds a different session) do not end the
 * search: the remaining files are checked too, so sessions in renamed or
 * hand-named files still resolve. Headers decide: a file whose header id or cwd
 * does not match is not the session.
 *
 * Among matches, an exact header id wins over a prefix match wherever it
 * appears. Ambiguous prefix candidates are considered in two buckets: filename
 * matches before remaining files, with each bucket sorted by the creation time
 * embedded in SDK-style names (see `byNewestEmbeddedTimestamp`).
 *
 * The header's cwd is returned canonicalized, matching what `list` reports.
 */
export async function resolveSessionFileInDir(
  sessionDir: string,
  cwd: string,
  sessionId: string,
  readHeader: SessionHeaderReader,
): Promise<ResolvedSessionFile | undefined> {
  const sessionFiles = await listSessionFiles(sessionDir);
  const fileNameMatches: string[] = [];
  const remainingFiles: string[] = [];
  for (const sessionFile of sessionFiles) {
    (fileNameMatchesSessionId(basename(sessionFile), sessionId) ? fileNameMatches : remainingFiles).push(sessionFile);
  }
  fileNameMatches.sort(byNewestEmbeddedTimestamp);
  remainingFiles.sort(byNewestEmbeddedTimestamp);

  // A prefix match is only provisional: an exact header id wins over it
  // wherever it appears, so the search continues after one is found.
  let prefixMatch: ResolvedSessionFile | undefined;
  // Filename matches first; the remaining files follow so a renamed file still
  // resolves when every filename candidate fails header verification.
  for (const sessionFile of [...fileNameMatches, ...remainingFiles]) {
    const header = await readHeader(sessionFile);
    if (header?.cwd === undefined) continue;
    if (!cwdPathsEqual(header.cwd, cwd)) continue;
    if (header.id === sessionId) {
      return { id: header.id, cwd: canonicalizeStoredCwd(header.cwd), path: sessionFile };
    }
    if (prefixMatch === undefined && header.id.startsWith(sessionId)) {
      prefixMatch = { id: header.id, cwd: canonicalizeStoredCwd(header.cwd), path: sessionFile };
    }
  }
  return prefixMatch;
}

/**
 * Order session files newest-first by the timestamp embedded in SDK-style names
 * (`<timestamp>_<sessionId>.jsonl`; the SDK stamps the session's creation time
 * into the name, so this is creation-time order). Files sharing a timestamp,
 * or without one, fall back to a plain code-unit path comparison — never
 * `localeCompare`, whose result varies by locale — so the order is
 * deterministic everywhere.
 *
 * This deliberately drifts from the listing, which orders by modified time:
 * the resolver never stats transcript files, so ambiguous prefix candidates
 * within each bucket are considered in this creation-time order instead.
 */
function byNewestEmbeddedTimestamp(a: string, b: string): number {
  const timestampA = embeddedFileNameTimestamp(basename(a));
  const timestampB = embeddedFileNameTimestamp(basename(b));
  if (timestampA !== timestampB) return timestampA < timestampB ? 1 : -1;
  return a < b ? 1 : a > b ? -1 : 0;
}

/** The creation timestamp embedded in an SDK-style session file name ("" when absent). */
function embeddedFileNameTimestamp(fileName: string): string {
  const stem = fileName.slice(0, -".jsonl".length);
  const separatorIndex = stem.indexOf("_");
  return separatorIndex === -1 ? "" : stem.slice(0, separatorIndex);
}

/** Whether a `.jsonl` file name embeds `sessionId` (exactly or as a prefix). */
function fileNameMatchesSessionId(fileName: string, sessionId: string): boolean {
  const embeddedId = embeddedFileNameSessionId(fileName);
  return embeddedId !== undefined && (embeddedId === sessionId || embeddedId.startsWith(sessionId));
}

/**
 * The session id embedded in an SDK-style session file name
 * (`<timestamp>_<sessionId>.jsonl`). The timestamp never contains `_`, so the
 * id is everything after the first separator; files without one fall back to
 * the whole stem, and header verification discards false guesses.
 */
function embeddedFileNameSessionId(fileName: string): string | undefined {
  const stem = fileName.slice(0, -".jsonl".length);
  const separatorIndex = stem.indexOf("_");
  const candidate = separatorIndex === -1 ? stem : stem.slice(separatorIndex + 1);
  return candidate === "" ? undefined : candidate;
}

async function listSessionFiles(sessionDir: string): Promise<string[]> {
  try {
    const names = await readdir(sessionDir);
    return names.filter((name) => name.endsWith(".jsonl")).map((name) => join(sessionDir, name));
  } catch {
    // Matches the SDK listing behavior: an unreadable directory lists nothing.
    return [];
  }
}

function uniqueSessionsByPath(sessions: readonly PiSessionListEntry[]): PiSessionListEntry[] {
  const byPath = new Map<string, PiSessionListEntry>();
  for (const session of sessions) byPath.set(session.path, session);
  return [...byPath.values()].sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function defaultPiSessionsRoot(agentDir: string): string {
  return join(agentDir, "sessions");
}

export function defaultPiSessionDir(cwd: string, agentDir: string): string {
  return sessionDirInDefaultPiStore(defaultPiSessionsRoot(agentDir), cwd);
}

export function sessionDirInDefaultPiStore(storeRoot: string, cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
  return join(storeRoot, safePath);
}

export function resolveConfiguredPath(path: string, cwd: string, homeDir: string): string {
  const expanded = expandTildePath(path, homeDir);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function expandTildePath(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return join(homeDir, path.slice(2));
  return path;
}
