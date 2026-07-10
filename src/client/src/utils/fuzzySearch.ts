/**
 * Fuzzy search for palette-style UIs: command pickers, action palettes, model selectors.
 *
 * Matches query characters sequentially against a target string (case-insensitive),
 * scoring higher for consecutive runs and word-boundary hits. Spaces in the query
 * are ignored so that "cl son" matches "claude-sonnet" the same way "clson" does.
 */

function isWordBoundary(ch: string): boolean {
  return ch === " " || ch === "-" || ch === "_" || ch === "." || ch === "/";
}

/**
 * Returns a positive score when every character in `query` can be matched in order
 * against `target` (case-insensitive, spaces in the query are ignored).
 * Returns 0 when the query cannot be matched.
 *
 * Scoring heuristics (higher is better):
 *  - Every matched character contributes.
 *  - Consecutive matches get an accumulating bonus.
 *  - Matches at word/segment boundaries get a bonus.
 *  - Matching the first character of the target gets an extra boost.
 */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 0;
  // Strip spaces from the query so "clau son" and "clauson" both match "claude-sonnet".
  const q = query.replace(/\s+/g, "").toLowerCase();
  const t = target.toLowerCase();

  let score = 0;
  let queryIdx = 0;
  let prevMatchIdx = -1;
  let consecutiveRun = 0;

  for (let i = 0; i < t.length && queryIdx < q.length; i++) {
    if (t[i] === q[queryIdx]) {
      score += 10; // base match

      if (prevMatchIdx === i - 1) {
        consecutiveRun++;
        score += consecutiveRun * 2; // growing consecutive bonus
      } else {
        consecutiveRun = 0;
      }

      if (i === 0) {
        score += 3; // start-of-string bonus
      } else {
        const prev = t[i - 1];
        if (prev !== undefined && isWordBoundary(prev)) {
          score += 3; // word-boundary bonus
        }
      }

      prevMatchIdx = i;
      queryIdx++;
    }
  }

  if (queryIdx < q.length) return 0; // not all query chars matched

  return score;
}

export interface FuzzyTarget<T> {
  /** The text to search within. */
  text: string;
  /** Arbitrary data associated with this target. */
  item: T;
}

export interface FuzzyResult<T> {
  item: T;
  score: number;
}

/**
 * Fuzzy-searches `targets` with `query`, returning results scored and sorted
 * (highest score first). Only targets with a positive score are included.
 *
 * When `query` is empty or whitespace-only, returns all targets in original order
 * with a score of 0.
 */
export function fuzzySearch<T>(query: string, targets: FuzzyTarget<T>[]): FuzzyResult<T>[] {
  const trimmed = query.trim();
  if (!trimmed) return targets.map((t) => ({ item: t.item, score: 0 }));

  const results: FuzzyResult<T>[] = [];
  for (const target of targets) {
    const score = fuzzyScore(trimmed, target.text);
    if (score > 0) results.push({ item: target.item, score });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
