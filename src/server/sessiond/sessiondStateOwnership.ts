/**
 * Session daemon state ownership.
 *
 * The session daemon is the authority over a pi-web instance's durable state:
 * projects, machines, session archives, and unread state all live in the data
 * directory, and the daemon is the only process allowed to own it while
 * running (the web/API process of the same instance shares the directory but
 * never claims it). A second daemon resolving the same data directory would
 * corrupt that state silently, so the daemon records its ownership in
 * `<data dir>/sessiond-owner.json` at startup and refuses to start while a
 * live owner holds the marker.
 *
 * Liveness uses the owning process's Linux `/proc` start-time ticks when both
 * the marker and the probe have them: the recorded value distinguishes the
 * original owner from a reused pid — including the same numeric pid in a
 * recreated container's fresh PID namespace — so stale markers never block
 * startup and live owners always do. Otherwise it falls back to a
 * `kill(pid, 0)` probe. Detection is scoped to one PID namespace; two daemons
 * in different containers sharing one data volume cannot see each other's
 * processes, an operator error no pid-based mechanism can catch.
 *
 * Service and `tsx watch` restarts briefly overlap the outgoing daemon, so a
 * claimant that finds a live owner waits a short grace for the owner to
 * release (orderly shutdown removes the marker) before failing. When the
 * owner persists past the grace window, startup fails with a
 * {@link SessiondStateOwnershipConflictError} naming the owner and the
 * configuration a second instance needs: a distinct `PI_WEB_DATA_DIR`,
 * `PI_WEB_SESSIOND_SOCKET` (or `PI_WEB_SESSIOND_PORT` / `PI_WEB_SESSIOND_HOST`),
 * and web port.
 */

import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { piWebDataDir } from "../../config.js";
import { sessiondEndpointDescription } from "../../sessiond/config.js";

/** Marker file recording the owning daemon, inside the instance data directory. */
export const SESSIOND_OWNER_MARKER_FILENAME = "sessiond-owner.json";

export interface SessiondStateOwnershipRecord {
  readonly pid: number;
  /** Wall-clock start of the owning daemon; for humans and release identity. */
  readonly startedAt: string;
  /**
   * Linux `/proc/<pid>/stat` start-time ticks of the owner, when readable. A
   * mismatch means the recorded pid now names a different process.
   */
  readonly processStartTime?: string;
  /** Human description of the daemon endpoint: socket path or host:port. */
  readonly endpoint: string;
}

/**
 * The daemon could not start because a live session daemon owns the state this
 * one resolved. The message is the user- and agent-facing remediation, so it
 * names the owner and the distinct configuration a second instance needs.
 */
export class SessiondStateOwnershipConflictError extends Error {
  readonly dataDir: string;
  readonly owner: SessiondStateOwnershipRecord;

  constructor(options: { dataDir: string; markerPath: string; owner: SessiondStateOwnershipRecord }) {
    const { dataDir, markerPath, owner } = options;
    super(
      `another pi-web session daemon already owns this state\n\n` +
        `The data directory "${dataDir}" is owned by a live session daemon ` +
        `(pid ${String(owner.pid)}, started ${owner.startedAt}, listening on ${owner.endpoint}; ` +
        `ownership marker ${markerPath}). Two daemons sharing one data directory corrupt each other's state.\n\n` +
        `To run a second pi-web instance, give it its own state and endpoints:\n` +
        `- PI_WEB_DATA_DIR: a different data directory\n` +
        `- PI_WEB_SESSIOND_SOCKET (or PI_WEB_SESSIOND_PORT / PI_WEB_SESSIOND_HOST): a different session daemon endpoint\n` +
        `- PI_WEB_PORT: a different web/API port\n\n` +
        `If pid ${String(owner.pid)} is not a running pi-web session daemon, remove the stale marker file and start again.`,
    );
    this.name = "SessiondStateOwnershipConflictError";
    this.dataDir = dataDir;
    this.owner = owner;
  }
}

export interface SessiondStateOwnershipLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

export interface ClaimSessiondStateOwnershipOptions {
  /** The captured pre-scrub daemon environment; resolves the data dir and endpoint. */
  readonly env: NodeJS.ProcessEnv;
  /** Test seam; defaults to the env-resolved data dir. */
  readonly dataDir?: string;
  readonly ownPid?: number;
  /** Test seam; defaults to {@link isOwnershipRecordAlive}. */
  readonly isAlive?: (record: SessiondStateOwnershipRecord) => boolean;
  /** How long to wait for a live owner to release before failing. */
  readonly graceMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: SessiondStateOwnershipLogger;
}

export interface SessiondStateOwnership {
  readonly markerPath: string;
  readonly record: SessiondStateOwnershipRecord;
  /**
   * Remove the marker when it still records this daemon; a no-op when another
   * owner has taken over. Best-effort by contract: a failed release only
   * leaves a stale marker the next start's liveness check discards, so
   * failures are logged, not thrown.
   */
  release(): Promise<void>;
}

const DEFAULT_GRACE_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * Claim ownership of the instance data directory for this daemon.
 *
 * Resolves once the marker records this daemon; throws
 * {@link SessiondStateOwnershipConflictError} when a live owner persists past
 * the grace window.
 */
export async function claimSessiondStateOwnership(options: ClaimSessiondStateOwnershipOptions): Promise<SessiondStateOwnership> {
  const ownPid = options.ownPid ?? process.pid;
  const isAlive = options.isAlive ?? isOwnershipRecordAlive;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const logger = options.logger;
  const dataDir = options.dataDir ?? piWebDataDir(options.env);
  const markerPath = join(dataDir, SESSIOND_OWNER_MARKER_FILENAME);
  const processStartTime = readProcessStartTime(ownPid);
  const record: SessiondStateOwnershipRecord = {
    pid: ownPid,
    startedAt: new Date().toISOString(),
    ...(processStartTime === undefined ? {} : { processStartTime }),
    endpoint: sessiondEndpointDescription(options.env),
  };
  await mkdir(dataDir, { recursive: true });
  const deadline = Date.now() + graceMs;
  let waitedForOwner = false;

  for (;;) {
    const existing = await readOwnershipRecord(markerPath);
    if (existing !== undefined && existing !== "invalid") {
      if (existing.pid !== ownPid && isAlive(existing)) {
        // A live different owner: wait out the grace window for an orderly
        // restart to release, then fail loudly.
        if (Date.now() >= deadline) {
          throw new SessiondStateOwnershipConflictError({ dataDir, markerPath, owner: existing });
        }
        if (!waitedForOwner) {
          logger?.warn(
            { markerPath, owner: existing },
            "another live session daemon owns this state; waiting briefly for it to release ownership",
          );
          waitedForOwner = true;
        }
        await sleep(pollIntervalMs);
        continue;
      }
      if (existing.pid !== ownPid) {
        logger?.info(
          { markerPath, previousOwner: existing },
          "taking over session daemon state ownership from a stale marker",
        );
      }
      await rm(markerPath, { force: true });
    } else if (existing === "invalid") {
      // Possibly a torn write by a claimant mid-create; give it the grace
      // window to finish before discarding the marker.
      if (Date.now() < deadline) {
        await sleep(pollIntervalMs);
        continue;
      }
      logger?.warn({ markerPath }, "discarding an unreadable session daemon ownership marker");
      await rm(markerPath, { force: true });
    }
    // No live owner holds the marker: claim it exclusively. The loser of a
    // create race re-reads and re-evaluates the winner's marker above.
    try {
      await writeFile(markerPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
      return {
        markerPath,
        record,
        release: () => releaseOwnershipMarker(markerPath, record, logger),
      };
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
    }
  }
}

/** Parse marker content; `"invalid"` when it is not a readable ownership record. */
export function parseOwnershipRecord(content: string): SessiondStateOwnershipRecord | "invalid" {
  try {
    const value: unknown = JSON.parse(content);
    if (!isRecord(value)) return "invalid";
    if (typeof value["pid"] !== "number" || typeof value["startedAt"] !== "string" || typeof value["endpoint"] !== "string") {
      return "invalid";
    }
    if (value["processStartTime"] !== undefined && typeof value["processStartTime"] !== "string") return "invalid";
    return {
      pid: value["pid"],
      startedAt: value["startedAt"],
      ...(value["processStartTime"] === undefined ? {} : { processStartTime: value["processStartTime"] }),
      endpoint: value["endpoint"],
    };
  } catch {
    return "invalid";
  }
}

/**
 * Whether the process a marker records is still that same running process.
 *
 * With both the recorded and the current `/proc` start time available, a
 * mismatch pins down pid reuse; otherwise the pid probe is all there is.
 */
export function isOwnershipRecordAlive(record: Pick<SessiondStateOwnershipRecord, "pid" | "processStartTime">): boolean {
  const currentStartTime = readProcessStartTime(record.pid);
  if (currentStartTime !== undefined && record.processStartTime !== undefined) {
    return currentStartTime === record.processStartTime;
  }
  return isProcessAlive(record.pid);
}

/**
 * Linux-only precise process identity: `/proc/<pid>/stat` field 22 (start time
 * in clock ticks since boot). `undefined` off Linux or when the process is
 * gone. The `comm` field may contain spaces and parentheses, so parsing starts
 * after its closing parenthesis.
 */
export function readProcessStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen === -1) return undefined;
    const afterComm = stat.slice(closeParen + 2).split(" ");
    return afterComm[19];
  } catch {
    return undefined;
  }
}

async function readOwnershipRecord(markerPath: string): Promise<SessiondStateOwnershipRecord | "invalid" | undefined> {
  let content: string;
  try {
    content = await readFile(markerPath, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  return parseOwnershipRecord(content);
}

async function releaseOwnershipMarker(
  markerPath: string,
  record: SessiondStateOwnershipRecord,
  logger: SessiondStateOwnershipLogger | undefined,
): Promise<void> {
  try {
    const current = await readOwnershipRecord(markerPath);
    if (current === undefined || current === "invalid") return;
    // Remove only our own marker: pid plus the wall-clock start makes a newer
    // owner that reused the pid after a takeover race safe from deletion.
    if (current.pid === record.pid && current.startedAt === record.startedAt) {
      await rm(markerPath, { force: true });
    }
  } catch (error) {
    logger?.warn({ err: error, markerPath }, "could not release the session daemon ownership marker; the next start discards it as stale");
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return isErrorCode(error, "EPERM");
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}
