import { describe, expect, it } from "vitest";
import { buildReviewMarkdown, sortComments } from "./reviewMarkdown";
import type { ReviewComment } from "./reviewTypes";

let seq = 0;
function comment(
  filePath: string,
  side: "new" | "old",
  start: number,
  end: number,
  body: string,
  createdAt = ++seq,
): ReviewComment {
  return {
    id: `review-${String(createdAt)}`,
    anchor: { filePath, range: { side, start, end } },
    body,
    createdAt,
    updatedAt: createdAt,
    sourceHash: "deadbeef",
  };
}

describe("buildReviewMarkdown", () => {
  it("returns empty string for no comments", () => {
    expect(buildReviewMarkdown([])).toBe("");
  });

  it("renders a single new-side comment with a counted heading, a sequential id, a leading rule, and an end marker", () => {
    // This text is rendered as REAL markdown in the chat transcript
    // (`<formatted-text>` in `ChatView.ts`), for both user and assistant
    // messages -- not just fed as raw text to the model -- so each comment
    // gets its own heading (id + anchor), its own block for the body
    // (immune to whatever markdown the body itself contains, e.g. code
    // fences/lists), and an explicit end marker so the block's extent is
    // unambiguous regardless of body content.
    expect(buildReviewMarkdown([comment("src/app.ts", "new", 12, 12, "fix this")])).toBe(
      "### Code review comments (1)\n\n---\n\n#### C1: src/app.ts:12\n\nfix this\n\n<sub><sup><small>*-- end of C1 --*</small></sup></sub>",
    );
  });

  it("renders ranges and deleted lines, numbering ids sequentially in sorted order", () => {
    const md = buildReviewMarkdown([
      comment("a.ts", "new", 3, 5, "range note", 1),
      comment("b.ts", "old", 8, 9, "deletion note", 2),
    ]);
    expect(md).toBe(
      "### Code review comments (2)\n\n"
      + "---\n\n#### C1: a.ts:3-5\n\nrange note\n\n<sub><sup><small>*-- end of C1 --*</small></sup></sub>\n\n"
      + "---\n\n#### C2: b.ts:8-9 (deleted)\n\ndeletion note\n\n<sub><sup><small>*-- end of C2 --*</small></sup></sub>",
    );
  });

  it("trims comment bodies", () => {
    expect(buildReviewMarkdown([comment("a.ts", "new", 1, 1, "  spaced  ", 1)])).toContain(
      "#### C1: a.ts:1\n\nspaced\n\n",
    );
  });

  it("keeps a multi-line body (code fences, lists) intact as its own block instead of embedding it inline after a bullet", () => {
    const body = "Test comment `inline code`. \n```\nexample code\n```\n\n* list of elements\n* list of elements 2";
    const md = buildReviewMarkdown([comment("a.ts", "new", 1, 1, body, 1)]);
    expect(md).toBe(
      `### Code review comments (1)\n\n---\n\n#### C1: a.ts:1\n\n${body.trim()}\n\n<sub><sup><small>*-- end of C1 --*</small></sup></sub>`,
    );
  });

  it("orders by path, then start line, then creation order", () => {
    const ordered = sortComments([
      comment("z.ts", "new", 1, 1, "z", 10),
      comment("a.ts", "new", 20, 20, "a20", 11),
      comment("a.ts", "new", 5, 5, "a5-late", 13),
      comment("a.ts", "new", 5, 5, "a5-early", 12),
    ]).map((entry) => entry.body);
    expect(ordered).toEqual(["a5-early", "a5-late", "a20", "z"]);
  });
});
