import type { WorkspaceReviewLineRef } from "@jmfederico/pi-web/plugin-api";
import type { UnifiedDiffLine } from "./unifiedDiff.js";

/**
 * Maps a rendered unified-diff row to the review line ref it anchors to:
 * context/added rows anchor to the current (`new`) side line number; removed
 * rows anchor to the deleted (`old`) side line number. `meta`/`hunk`/`marker`
 * rows carry no line and cannot be commented on.
 */
export function reviewRefForDiffLine(line: UnifiedDiffLine): WorkspaceReviewLineRef | undefined {
  if ((line.kind === "context" || line.kind === "add") && line.newLineNumber !== undefined) {
    return { side: "new", line: line.newLineNumber };
  }
  if (line.kind === "remove" && line.oldLineNumber !== undefined) {
    return { side: "old", line: line.oldLineNumber };
  }
  return undefined;
}

/**
 * A local copy of `src/client/src/review/reviewHash.ts`'s `hashSource`
 * (FNV-1a 32-bit, cheap/stable/order-sensitive, not cryptographic). A plugin
 * package can only depend on the published `@jmfederico/pi-web/plugin-api`
 * surface, not core client source paths, and that hashing helper is not
 * re-exported through the plugin API, so it is duplicated verbatim here for
 * use as the `sourceHash` passed to `review.commitSelection(...)` for
 * diff-grid selections.
 */
export function hashDiffSource(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
