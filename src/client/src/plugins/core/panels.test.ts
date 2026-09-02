import { describe, expect, it, vi } from "vitest";
import { filesTabBadge } from "./panels";
import type { WorkspaceReview } from "../types";

function fakeReview(total: number): WorkspaceReview {
  return {
    total: vi.fn(() => total),
    countForFile: () => 0,
    commentsForLine: () => [],
    draftForLine: () => null,
    lineState: () => ({ selected: false, commented: false }),
    canAuthor: () => false,
    beginSelection: () => { /* unused */ },
    extendSelection: () => { /* unused */ },
    commitSelection: () => { /* unused */ },
    cancelSelection: () => { /* unused */ },
    setDraftBody: () => { /* unused */ },
    submitDraft: () => { /* unused */ },
    cancelDraft: () => { /* unused */ },
    updateComment: () => { /* unused */ },
    removeComment: () => { /* unused */ },
  };
}

describe("filesTabBadge", () => {
  it("shows the shared review total when > 0", () => {
    expect(filesTabBadge(fakeReview(3))).toBe(3);
  });

  it("hides the badge when the review total is zero", () => {
    expect(filesTabBadge(fakeReview(0))).toBeUndefined();
  });
});
