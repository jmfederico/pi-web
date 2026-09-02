/**
 * Side the anchor refers to. The Files raw view is always "new" (current file
 * lines). Git context/added lines are "new"; git deleted lines are "old".
 * A single comment is single-side.
 */
export type ReviewSide = "new" | "old";

export interface ReviewLineRange {
  side: ReviewSide;
  /** 1-based inclusive line number on the given side. */
  start: number;
  end: number;
}

export interface ReviewAnchor {
  /** Workspace-relative path. */
  filePath: string;
  /** Single side, contiguous range. */
  range: ReviewLineRange;
}

export interface ReviewComment {
  /** Stable local id, e.g. "review-<seq>". */
  id: string;
  anchor: ReviewAnchor;
  /** User text (markdown allowed). */
  body: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Fingerprint of the underlying content at creation, for staleness
   * invalidation. For side "new": hash of the file's current content. For side
   * "old": hash of the diff text the comment was authored against.
   */
  sourceHash: string;
}

/** A line reference used by the selection/render APIs. */
export interface ReviewLineRef {
  side: ReviewSide;
  line: number;
}

/** An in-progress, not-yet-saved comment. */
export interface ReviewDraft {
  anchor: ReviewAnchor;
  body: string;
}
