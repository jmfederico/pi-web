import type { ReviewAnchor, ReviewLineRange } from "./reviewTypes";

/** Normalize a range to `[min, max]` regardless of drag direction. */
export function normalizedRange(range: ReviewLineRange): { start: number; end: number } {
  return { start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) };
}

/**
 * Compact coordinate label for a range, e.g. `12`, `12-15`, or `8-9 (deleted)`
 * for old-side (deleted) lines.
 */
export function formatLineRange(range: ReviewLineRange): string {
  const { start, end } = normalizedRange(range);
  const lines = start === end ? String(start) : `${String(start)}-${String(end)}`;
  return range.side === "old" ? `${lines} (deleted)` : lines;
}

/** Full coordinate label, e.g. `src/app.ts:12-15` or `src/app.ts:8-9 (deleted)`. */
export function formatAnchorLabel(anchor: ReviewAnchor): string {
  return `${anchor.filePath}:${formatLineRange(anchor.range)}`;
}
