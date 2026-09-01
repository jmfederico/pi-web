/**
 * Bounded memo for idle-session transcript snapshots.
 *
 * The session daemon lives indefinitely and clients poll their selected idle
 * session's transcript from disk. Memoizing the parsed branch per file makes
 * an unchanged poll cheap, but an unbounded memo would retain every session
 * ever polled — transcripts included — for the daemon's lifetime. This cache
 * keeps the memo bounded: entries are keyed by session file path, validated
 * by the file signature the caller computed, and evicted least-recently-used
 * first once the limit is reached.
 *
 * Each snapshot retains the parsed entries alongside the derived branch so a
 * file that grew by append only can be extended from just the appended bytes
 * instead of re-parsing the whole transcript.
 *
 * Eviction is self-contained on purpose: it needs no hook into session
 * close/archive/delete flows, and an evicted entry simply means the next read
 * re-parses the file.
 */

/**
 * Default snapshot bound. Snapshot reads come from clients polling their
 * selected idle session, so the hot set is the distinct sessions polled
 * concurrently; 16 sits far above realistic client counts while capping how
 * many parsed transcripts the daemon retains.
 */
export const DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT = 16;

/** Construction options for {@link TranscriptBranchCache}. */
export interface TranscriptBranchCacheOptions {
  /**
   * Maximum memoized snapshots. Defaults to
   * {@link DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT}; tests pass a small limit to
   * exercise eviction directly.
   */
  readonly limit?: number;
}

/**
 * One memoized parse of a transcript file: the parsed entries, the branch
 * derived from them, and the file coordinates needed to validate or extend
 * the snapshot. The signature format is the caller's business; the cache
 * treats it as opaque and only stores the pieces the append-tail fast path
 * reasons about.
 */
export interface TranscriptBranchSnapshot {
  /** Full file signature the snapshot was parsed under; strict reads validate against it. */
  readonly signature: string;
  /** File identity (device + inode). A snapshot is only append-extendable while this stays put. */
  readonly identity: string;
  /** File size in bytes at parse time; appended bytes start at this offset. */
  readonly size: number;
  /** Every parsed transcript entry in file order — what the branch is derived from and what an append tail extends. */
  readonly entries: readonly Record<string, unknown>[];
  /** The active-branch projection served to snapshot readers. */
  readonly branch: unknown[];
}

/**
 * A small LRU memo of transcript snapshots keyed by session file path.
 * Backed by a `Map` whose insertion order doubles as recency order: reads
 * and writes refresh the entry, and the oldest entry is evicted past the
 * limit.
 */
export class TranscriptBranchCache {
  private readonly limit: number;
  private readonly snapshots = new Map<string, TranscriptBranchSnapshot>();

  constructor(options: TranscriptBranchCacheOptions = {}) {
    this.limit = options.limit ?? DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT;
  }

  /**
   * The memoized snapshot for `path`, or `undefined` when nothing is memoized
   * or the memoized signature no longer matches. A hit refreshes recency so
   * an actively polled session outlives one-off reads churning the bound.
   */
  get(path: string, signature: string): TranscriptBranchSnapshot | undefined {
    const snapshot = this.snapshots.get(path);
    if (snapshot === undefined) return undefined;
    if (snapshot.signature !== signature) return undefined;
    this.refresh(path, snapshot);
    return snapshot;
  }

  /**
   * The most recently stored snapshot for `path` regardless of signature, or
   * `undefined` when nothing is memoized. Refreshes recency like {@link get}.
   * Callers use this to extend a snapshot whose file grew on disk, then
   * validate what they serve against the fresh signature themselves.
   */
  getLatest(path: string): TranscriptBranchSnapshot | undefined {
    const snapshot = this.snapshots.get(path);
    if (snapshot === undefined) return undefined;
    this.refresh(path, snapshot);
    return snapshot;
  }

  /** Memoize `snapshot` for `path`, evicting the least recently used entry at the bound. */
  set(path: string, snapshot: TranscriptBranchSnapshot): void {
    this.snapshots.delete(path);
    this.snapshots.set(path, snapshot);
    // One set adds at most one entry, so a single eviction restores the bound.
    if (this.snapshots.size > this.limit) {
      const oldest = this.snapshots.keys().next();
      if (oldest.done !== true) this.snapshots.delete(oldest.value);
    }
  }

  private refresh(path: string, snapshot: TranscriptBranchSnapshot): void {
    this.snapshots.delete(path);
    this.snapshots.set(path, snapshot);
  }
}
