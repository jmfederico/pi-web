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

/** Maximum on-disk transcript size retained by the daemon snapshot cache. */
export const DEFAULT_TRANSCRIPT_BRANCH_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** Construction options for {@link TranscriptBranchCache}. */
export interface TranscriptBranchCacheOptions {
  /**
   * Maximum memoized snapshots. Defaults to
   * {@link DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT}; tests pass a small limit to
   * exercise eviction directly.
   */
  readonly limit?: number;
  /** Maximum combined transcript file bytes retained by the cache. */
  readonly maxBytes?: number;
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
  /** SHA-256 proof of the parsed prefix; append reuse is disabled when absent. */
  readonly prefixSha256?: string;
  /** Every parsed transcript entry in file order — what the branch is derived from and what an append tail extends. */
  readonly entries: readonly unknown[];
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
  private readonly maxBytes: number;
  private readonly snapshots = new Map<string, TranscriptBranchSnapshot>();
  private totalBytes = 0;

  constructor(options: TranscriptBranchCacheOptions = {}) {
    this.limit = options.limit ?? DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT;
    this.maxBytes = options.maxBytes ?? DEFAULT_TRANSCRIPT_BRANCH_CACHE_MAX_BYTES;
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
    this.delete(path);
    // A single oversized transcript should not displace the useful hot set.
    if (snapshot.size > this.maxBytes) return;
    this.snapshots.set(path, snapshot);
    this.totalBytes += snapshot.size;
    while (this.snapshots.size > this.limit || this.totalBytes > this.maxBytes) {
      const oldest = this.snapshots.keys().next();
      if (oldest.done === true) break;
      this.delete(oldest.value);
    }
  }

  private delete(path: string): void {
    const existing = this.snapshots.get(path);
    if (existing === undefined) return;
    this.snapshots.delete(path);
    this.totalBytes -= existing.size;
  }

  private refresh(path: string, snapshot: TranscriptBranchSnapshot): void {
    this.snapshots.delete(path);
    this.snapshots.set(path, snapshot);
  }
}
