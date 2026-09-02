import { formatAnchorLabel, normalizedRange } from "./reviewCoordinates";
import type { ReviewComment } from "./reviewTypes";

/** Deterministic order: by file path, then start line, then creation order. */
export function sortComments(comments: readonly ReviewComment[]): ReviewComment[] {
  return [...comments].sort((left, right) => {
    if (left.anchor.filePath !== right.anchor.filePath) {
      return left.anchor.filePath < right.anchor.filePath ? -1 : 1;
    }
    const leftStart = normalizedRange(left.anchor.range).start;
    const rightStart = normalizedRange(right.anchor.range).start;
    if (leftStart !== rightStart) return leftStart - rightStart;
    return left.createdAt - right.createdAt;
  });
}

/**
 * Markdown appended to the prompt on submit. Coordinates + comment text only
 * (no code snippet, no file attachment). Returns "" for no comments.
 *
 * This text is rendered as REAL markdown in the chat transcript
 * (`<formatted-text>` in `ChatView.ts`), for both user and assistant
 * messages -- not just fed as raw text to the model -- so its CommonMark
 * structure has to hold up regardless of what a comment's own body
 * contains (code fences, lists, blank lines, etc). Each comment gets:
 * a sequential id (`C1`, `C2`, ... in the same sorted order as the rest of
 * this module, unique within one markdown block -- comments are cleared
 * after a successful send, so it never needs to be stable across sends);
 * a `####` heading combining that id with the anchor; the body as its own
 * following block (never nested inside a list item, so it can't corrupt
 * surrounding structure no matter what it contains); and a closing marker
 * repeating the id, so the block's extent stays unambiguous even if the
 * body itself contains further headings.
 */
export function buildReviewMarkdown(comments: readonly ReviewComment[]): string {
  const sorted = sortComments(comments);
  if (sorted.length === 0) return "";
  const blocks = sorted.map((comment, index) => {
    const id = `C${String(index + 1)}`;
    return [
      "---",
      "",
      `#### ${id}: ${formatAnchorLabel(comment.anchor)}`,
      "",
      comment.body.trim(),
      "",
      `<sub><sup><small>*-- end of ${id} --*</small></sup></sub>`,
    ].join("\n");
  });
  return [`### Code review comments (${String(sorted.length)})`, ...blocks].join("\n\n");
}
