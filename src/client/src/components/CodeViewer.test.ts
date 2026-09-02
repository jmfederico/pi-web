// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import "./CodeViewer";
import type { CodeViewer } from "./CodeViewer";
import { hashSource } from "../review/reviewHash";
import type { ReviewComment } from "../review/reviewTypes";
import type { WorkspaceReview, WorkspaceReviewDraft, WorkspaceReviewLineRef } from "../plugins/types";

afterEach(() => {
  document.body.replaceChildren();
});

function fakeReview(overrides: {
  commentsForLine?: (path: string, ref: WorkspaceReviewLineRef) => readonly ReviewComment[];
  draftForLine?: (path: string, ref: WorkspaceReviewLineRef) => WorkspaceReviewDraft | null;
} = {}) {
  const spies = {
    total: vi.fn(() => 0),
    countForFile: vi.fn(() => 0),
    commentsForLine: vi.fn(overrides.commentsForLine ?? (() => [])),
    draftForLine: vi.fn(overrides.draftForLine ?? (() => null)),
    lineState: vi.fn(() => ({ selected: false, commented: false })),
    canAuthor: vi.fn(() => true),
    beginSelection: vi.fn(),
    extendSelection: vi.fn(),
    commitSelection: vi.fn(),
    cancelSelection: vi.fn(),
    setDraftBody: vi.fn(),
    submitDraft: vi.fn(),
    cancelDraft: vi.fn(),
    updateComment: vi.fn(),
    removeComment: vi.fn(),
    invalidateFile: vi.fn(),
  };
  const review: WorkspaceReview & { invalidateFile: typeof spies.invalidateFile } = { ...spies };
  return { review, spies };
}

async function mountCodeViewer(): Promise<CodeViewer> {
  const el = document.createElement("code-viewer");
  document.body.append(el);
  await el.updateComplete;
  return el;
}

describe("CodeViewer without review (regression)", () => {
  it("renders content with no gutter click handling and no thread widgets", async () => {
    const el = await mountCodeViewer();
    el.content = "line one\nline two\n";
    el.language = "typescript";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".cm-content")?.textContent).toContain("line one");
    expect(el.shadowRoot?.querySelector("pi-web-review-thread")).toBeNull();
  });

  it("still rebuilds on content change with review undefined", async () => {
    const el = await mountCodeViewer();
    el.content = "a\n";
    await el.updateComplete;
    el.content = "b\n";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".cm-content")?.textContent).toContain("b");
  });
});

describe("CodeViewer with review", () => {
  it("mounts inline comment widgets for the given file", async () => {
    const comment: ReviewComment = {
      id: "review-1",
      anchor: { filePath: "src/a.ts", range: { side: "new", start: 1, end: 1 } },
      body: "hi",
      createdAt: 0,
      updatedAt: 0,
      sourceHash: "x",
    };
    const { review } = fakeReview({ commentsForLine: (_path, ref) => (ref.line === 1 ? [comment] : []) });
    const el = await mountCodeViewer();
    el.review = review;
    el.reviewFilePath = "src/a.ts";
    el.content = "a\nb\n";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("pi-web-review-thread")).not.toBeNull();
  });

  it("invalidates the file's stale comments on every content change", async () => {
    const { review, spies } = fakeReview();
    const el = await mountCodeViewer();
    el.review = review;
    el.reviewFilePath = "src/a.ts";
    el.content = "first\n";
    await el.updateComplete;
    expect(spies.invalidateFile).toHaveBeenCalledWith("src/a.ts", hashSource("first\n"));
    el.content = "second\n";
    await el.updateComplete;
    expect(spies.invalidateFile).toHaveBeenCalledWith("src/a.ts", hashSource("second\n"));
  });

  it("does not rebuild the editor (no re-invalidate) when only review changes, content/language/reviewFilePath unchanged", async () => {
    const { review: reviewA, spies: spiesA } = fakeReview();
    const { review: reviewB, spies: spiesB } = fakeReview();
    const el = await mountCodeViewer();
    el.review = reviewA;
    el.reviewFilePath = "src/a.ts";
    el.content = "same\n";
    await el.updateComplete;
    expect(spiesA.invalidateFile).toHaveBeenCalledTimes(1);

    // Swap to a different `review` instance/reference with content/language/reviewFilePath unchanged.
    el.review = reviewB;
    await el.updateComplete;
    expect(spiesA.invalidateFile).toHaveBeenCalledTimes(1);
    expect(spiesB.invalidateFile).not.toHaveBeenCalled();
  });

  it("refreshes inline comment/draft widgets when review data changes externally (e.g. removed via the prompt chip, or cleared after a successful send), without recreating the editor", async () => {
    // Regression: comments removed/cleared through a path that never goes
    // through this CM6 view (the prompt-editor's review chip, or
    // `ReviewController.completeSend` after a successful send) previously
    // left the widget stuck showing stale data until *something else*
    // (e.g. switching tabs, which recreates the editor) forced a rebuild.
    // `review`/its query methods are the same live controller underneath,
    // so a change is only observable by re-querying it -- there is no
    // separate "comments changed" signal here, only the property being
    // reassigned (a fresh adapter object) on every app-level re-render.
    let comments: ReviewComment[] = [{
      id: "review-1",
      anchor: { filePath: "src/a.ts", range: { side: "new", start: 1, end: 1 } },
      body: "hello",
      createdAt: 0,
      updatedAt: 0,
      sourceHash: "x",
    }];
    const { review } = fakeReview({ commentsForLine: (_path, ref) => (ref.line === 1 ? comments : []) });
    const el = await mountCodeViewer();
    el.review = review;
    el.reviewFilePath = "src/a.ts";
    el.content = "a\nb\n";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("pi-web-review-thread")).not.toBeNull();

    // Comment removed externally; a fresh `review` adapter object (same
    // underlying controller/state) is assigned, as happens on every
    // app-level re-render.
    comments = [];
    el.review = { ...review };
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("pi-web-review-thread")).toBeNull();
  });
});
