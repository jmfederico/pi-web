import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AGENT_SESSION_DIR_ENV_KEYS } from "../../config.js";
import { canonicalizeStoredCwd, cwdPathsEqual } from "../workingDirectory.js";
import { readSessionHeaderSummary, type SessionHeaderReader } from "./sessionFileHeader.js";
import { SessionSummaryScanner } from "./sessionSummaryScanner.js";
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
