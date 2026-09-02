// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { computeDragRange, buildReviewExtensions, reviewGutterDomEventHandlers, reviewRefreshEffect, reviewThemeSpec, reviewWidgetHostStyle } from "./codeViewerReview";
import { hashSource } from "../review/reviewHash";
import type { ReviewComment } from "../review/reviewTypes";
import type { WorkspaceReview, WorkspaceReviewDraft, WorkspaceReviewLineRef } from "../plugins/types";
import "./ReviewThread";

describe("computeDragRange", () => {
  it("normalizes forward drags", () => {
    expect(computeDragRange(3, 7)).toEqual({ start: 3, end: 7 });
  });

  it("normalizes backward drags", () => {
    expect(computeDragRange(7, 3)).toEqual({ start: 3, end: 7 });
  });

  it("handles a single line (no movement)", () => {
    expect(computeDragRange(5, 5)).toEqual({ start: 5, end: 5 });
  });
});

/**
 * Builds a fake `WorkspaceReview` alongside its individual spies, kept as
 * plain standalone function variables (not accessed as `review.method` in
 * assertions) so `@typescript-eslint/unbound-method` does not flag the
 * `expect(...)` calls -- `WorkspaceReview` declares its members with method
 * syntax, and ESLint treats any later `review.foo` reference as an unbound
 * method access regardless of how it's wrapped.
 */
function fakeReview(overrides: {
  commentsForLine?: (path: string, ref: WorkspaceReviewLineRef) => readonly ReviewComment[];
  draftForLine?: (path: string, ref: WorkspaceReviewLineRef) => WorkspaceReviewDraft | null;
  lineState?: (path: string, ref: WorkspaceReviewLineRef) => { selected: boolean; commented: boolean };
} = {}) {
  const spies = {
    total: vi.fn(() => 0),
    countForFile: vi.fn(() => 0),
    commentsForLine: vi.fn(overrides.commentsForLine ?? (() => [])),
    draftForLine: vi.fn(overrides.draftForLine ?? (() => null)),
    lineState: vi.fn(overrides.lineState ?? (() => ({ selected: false, commented: false }))),
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
  };
  const review: WorkspaceReview = { ...spies };
  return { review, spies };
}

function makeView(doc: string, review: WorkspaceReview, filePath = "src/a.ts"): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  return new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: buildReviewExtensions({ filePath, review }),
    }),
  });
}

/**
 * Real mouse-event dispatch through CM6's gutter DOM in happy-dom is brittle
 * (no real layout/hit-testing, `posAtCoords` relies on measured geometry
 * that happy-dom does not compute). Instead this tests the wiring at the
 * level CM6 itself exposes for it: the `domEventHandlers` functions are
 * plain `(view, line, event) => boolean` callbacks that CM6 invokes with a
 * resolved `BlockInfo` for the line under the pointer -- so we call them
 * directly with a real `EditorView`/`BlockInfo` (obtained via
 * `view.lineBlockAt`), which exercises the exact same line-number math and
 * controller calls production code uses, without depending on happy-dom's
 * (non-existent) layout engine.
 */
describe("reviewGutterDomEventHandlers", () => {
  it("mousedown begins a single-line selection", () => {
    const { review, spies } = fakeReview();
    const view = makeView("a\nb\nc\n", review);
    const handlers = reviewGutterDomEventHandlers({ filePath: "src/a.ts", review });
    const line = view.lineBlockAt(view.state.doc.line(2).from);
    handlers.mousedown(view, line, new MouseEvent("mousedown", { button: 0 }));
    expect(spies.beginSelection).toHaveBeenCalledWith("src/a.ts", { side: "new", line: 2 });
    view.destroy();
  });

  it("mousemove while dragging extends the selection", () => {
    const { review, spies } = fakeReview();
    const view = makeView("a\nb\nc\n", review);
    const handlers = reviewGutterDomEventHandlers({ filePath: "src/a.ts", review });
    const line2 = view.lineBlockAt(view.state.doc.line(2).from);
    const line3 = view.lineBlockAt(view.state.doc.line(3).from);
    handlers.mousedown(view, line2, new MouseEvent("mousedown", { button: 0 }));
    handlers.mousemove(view, line3, new MouseEvent("mousemove", { buttons: 1 }));
    expect(spies.extendSelection).toHaveBeenCalledWith({ side: "new", line: 3 });
    view.destroy();
  });

  it("mousemove without a held button does not extend", () => {
    const { review, spies } = fakeReview();
    const view = makeView("a\nb\nc\n", review);
    const handlers = reviewGutterDomEventHandlers({ filePath: "src/a.ts", review });
    const line2 = view.lineBlockAt(view.state.doc.line(2).from);
    handlers.mousedown(view, line2, new MouseEvent("mousedown", { button: 0 }));
    handlers.mousemove(view, line2, new MouseEvent("mousemove", { buttons: 0 }));
    expect(spies.extendSelection).not.toHaveBeenCalled();
    view.destroy();
  });

  it("mouseup commits the selection with the current doc hash", () => {
    const { review, spies } = fakeReview();
    const doc = "a\nb\nc\n";
    const view = makeView(doc, review);
    const handlers = reviewGutterDomEventHandlers({ filePath: "src/a.ts", review });
    const line1 = view.lineBlockAt(view.state.doc.line(1).from);
    handlers.mousedown(view, line1, new MouseEvent("mousedown", { button: 0 }));
    handlers.mouseup(view, line1, new MouseEvent("mouseup", {}));
    expect(spies.commitSelection).toHaveBeenCalledWith(hashSource(doc));
    view.destroy();
  });

  it("a plain click (mousedown+mouseup, same line, no move) commits a single-line selection", () => {
    const { review, spies } = fakeReview();
    const view = makeView("a\nb\nc\n", review);
    const handlers = reviewGutterDomEventHandlers({ filePath: "src/a.ts", review });
    const line2 = view.lineBlockAt(view.state.doc.line(2).from);
    handlers.mousedown(view, line2, new MouseEvent("mousedown", { button: 0 }));
    handlers.mouseup(view, line2, new MouseEvent("mouseup", {}));
    expect(spies.beginSelection).toHaveBeenCalledWith("src/a.ts", { side: "new", line: 2 });
    expect(spies.extendSelection).toHaveBeenCalledWith({ side: "new", line: 2 });
    expect(spies.commitSelection).toHaveBeenCalled();
    view.destroy();
  });

  it("ignores mousedown for non-primary buttons", () => {
    const { review, spies } = fakeReview();
    const view = makeView("a\nb\n", review);
    const handlers = reviewGutterDomEventHandlers({ filePath: "src/a.ts", review });
    const line1 = view.lineBlockAt(view.state.doc.line(1).from);
    handlers.mousedown(view, line1, new MouseEvent("mousedown", { button: 2 }));
    expect(spies.beginSelection).not.toHaveBeenCalled();
    view.destroy();
  });
});

describe("buildReviewExtensions widgets", () => {
  it("mounts a pi-web-review-thread widget after a line with a saved comment", () => {
    const comment: ReviewComment = {
      id: "review-1",
      anchor: { filePath: "src/a.ts", range: { side: "new", start: 2, end: 2 } },
      body: "hello",
      createdAt: 0,
      updatedAt: 0,
      sourceHash: "x",
    };
    const { review } = fakeReview({
      commentsForLine: (_path, ref) => (ref.line === 2 ? [comment] : []),
    });
    const view = makeView("a\nb\nc\n", review);
    expect(view.dom.querySelector("pi-web-review-thread")).not.toBeNull();
    view.destroy();
  });

  it("does not mount a widget for a line without comments or a draft", () => {
    const { review } = fakeReview();
    const view = makeView("a\nb\nc\n", review);
    expect(view.dom.querySelector("pi-web-review-thread")).toBeNull();
    view.destroy();
  });

  it("mounts a widget for an open draft anchored at a line", () => {
    const draft: WorkspaceReviewDraft = { anchor: { filePath: "src/a.ts", range: { side: "new", start: 1, end: 1 } }, body: "" };
    const { review } = fakeReview({
      draftForLine: (_path, ref) => (ref.line === 1 ? draft : null),
    });
    const view = makeView("a\nb\nc\n", review);
    expect(view.dom.querySelector("pi-web-review-thread")).not.toBeNull();
    view.destroy();
  });

  it("re-renders widgets after reviewRefreshEffect is dispatched", () => {
    let comments: ReviewComment[] = [];
    const { review } = fakeReview({
      commentsForLine: (_path, ref) => (ref.line === 1 ? comments : []),
    });
    const view = makeView("a\nb\n", review);
    expect(view.dom.querySelector("pi-web-review-thread")).toBeNull();
    comments = [{
      id: "review-2",
      anchor: { filePath: "src/a.ts", range: { side: "new", start: 1, end: 1 } },
      body: "added later",
      createdAt: 0,
      updatedAt: 0,
      sourceHash: "x",
    }];
    view.dispatch({ effects: reviewRefreshEffect.of(undefined) });
    expect(view.dom.querySelector("pi-web-review-thread")).not.toBeNull();
    view.destroy();
  });
});

describe("buildReviewExtensions line highlighting", () => {
  it("highlights every line of an open draft's range, not only its anchor line", () => {
    // Draft spans lines 1-2 of a 3-line doc; `lineState` (the same query the
    // Git tab already drives its row classes from) reports `commented: true`
    // for both -- the highlight must not be limited to just the widget's
    // anchor line (line 2).
    const { review } = fakeReview({
      lineState: (_path, ref) => ({ selected: false, commented: ref.line === 1 || ref.line === 2 }),
    });
    const view = makeView("a\nb\nc\n", review);
    const lines = [...view.dom.querySelectorAll(".cm-line")];
    expect(lines[0]?.classList.contains("cm-review-commented")).toBe(true);
    expect(lines[1]?.classList.contains("cm-review-commented")).toBe(true);
    expect(lines[2]?.classList.contains("cm-review-commented")).toBe(false);
    view.destroy();
  });

  it("highlights every line of a saved comment's range", () => {
    const comment: ReviewComment = {
      id: "review-1",
      anchor: { filePath: "src/a.ts", range: { side: "new", start: 2, end: 3 } },
      body: "hello",
      createdAt: 0,
      updatedAt: 0,
      sourceHash: "x",
    };
    const { review } = fakeReview({
      commentsForLine: (_path, ref) => (ref.line >= 2 && ref.line <= 3 ? [comment] : []),
      lineState: (_path, ref) => ({ selected: false, commented: ref.line >= 2 && ref.line <= 3 }),
    });
    const view = makeView("a\nb\nc\n", review);
    const lines = [...view.dom.querySelectorAll(".cm-line")];
    expect(lines[0]?.classList.contains("cm-review-commented")).toBe(false);
    expect(lines[1]?.classList.contains("cm-review-commented")).toBe(true);
    expect(lines[2]?.classList.contains("cm-review-commented")).toBe(true);
    view.destroy();
  });

  it("highlights every line of an active (uncommitted) selection with cm-review-selected", () => {
    const { review } = fakeReview({
      lineState: (_path, ref) => ({ selected: ref.line === 1 || ref.line === 2, commented: false }),
    });
    const view = makeView("a\nb\nc\n", review);
    const lines = [...view.dom.querySelectorAll(".cm-line")];
    expect(lines[0]?.classList.contains("cm-review-selected")).toBe(true);
    expect(lines[1]?.classList.contains("cm-review-selected")).toBe(true);
    expect(lines[2]?.classList.contains("cm-review-selected")).toBe(false);
    view.destroy();
  });

  it("recomputes line highlighting when a gutter drag extends the selection", () => {
    // Simulate the controller's live selection growing as the drag extends:
    // `review.lineState` is queried fresh on every recompute, so wire it to a
    // mutable "current extent" the test controls directly, updated the same
    // way `reviewGutterDomEventHandlers`'s mousemove handler does (dispatch a
    // drag effect after calling `extendSelection`).
    let extent = 1;
    const { review: liveReview } = fakeReview({
      lineState: (_path, ref) => ({ selected: ref.line <= extent, commented: false }),
    });
    const view = makeView("a\nb\nc\n", liveReview, "src/a.ts");
    const handlers = reviewGutterDomEventHandlers({ filePath: "src/a.ts", review: liveReview });
    const line1 = view.lineBlockAt(view.state.doc.line(1).from);
    const line2 = view.lineBlockAt(view.state.doc.line(2).from);
    handlers.mousedown(view, line1, new MouseEvent("mousedown", { button: 0 }));
    extent = 2;
    handlers.mousemove(view, line2, new MouseEvent("mousemove", { buttons: 1 }));
    const lines = [...view.dom.querySelectorAll(".cm-line")];
    expect(lines[0]?.classList.contains("cm-review-selected")).toBe(true);
    expect(lines[1]?.classList.contains("cm-review-selected")).toBe(true);
    expect(lines[2]?.classList.contains("cm-review-selected")).toBe(false);
    view.destroy();
  });
});

describe("review gutter hover affordance", () => {
  it("shows a pointer cursor and a '+' hint on hover, only for the line-numbers gutter", () => {
    // Asserted against the raw theme spec object (not CM6's generated/scoped
    // CSS text) since happy-dom does not evaluate `:hover` against real
    // layout -- this is the same pragmatic level this codebase already tests
    // `EditorView.theme`-driven behavior at (see `cm-review-selected`/
    // `cm-review-commented`, verified via applied classList above, not via
    // reading back computed styles).
    const hoverRule = reviewThemeSpec[".cm-lineNumbers .cm-gutterElement:hover"];
    expect(hoverRule.cursor).toBe("pointer");

    // Positioned with a POSITIVE offset from the right edge (`::after`, not
    // `::before`/negative-left) -- the line-numbers gutter is the leftmost
    // element in the scroller, so a negative `left` offset renders the glyph
    // off-screen, past the scroller's own left edge, entirely clipped.
    const hoverGlyphRule = reviewThemeSpec[".cm-lineNumbers .cm-gutterElement:hover::after"];
    expect(hoverGlyphRule.content).toBe("\"+\"");
    expect(hoverGlyphRule.right).toBeDefined();
    expect("left" in hoverGlyphRule).toBe(false);
  });
});

describe("review widget host width containment", () => {
  it("declares sticky positioning stretched between both edges, not a fixed width, against the scroller's container-query context", () => {
    // Source-of-truth string check (see `reviewWidgetHostStyle`'s doc comment):
    // some `CSSStyleDeclaration` test-environment implementations reject the
    // (valid, broadly browser-supported) `cqw` unit outright and silently
    // drop the declaration, making a DOM read-back of `element.style.width`
    // unreliable here regardless of how the property was actually set.
    //
    // BUG FIX: `left: 0` alone (with an explicit `width: 100cqw`) pins the
    // LEFT edge to the scrolled viewport but keeps the box's width equal to
    // the *unscrolled* full scroller width -- once the user scrolls the
    // code horizontally, the box's right edge necessarily extends past the
    // visible viewport by exactly the scroll offset (confirmed live: a
    // ~39px right-edge overflow after a ~39px horizontal scroll). Setting
    // BOTH `left: 0` and `right: 0` with no explicit `width` lets the
    // sticky box stretch to fill exactly the visible inline space instead,
    // which stays correct at any scroll offset.
    expect(reviewWidgetHostStyle).not.toContain("width:");
    expect(reviewWidgetHostStyle).toContain("box-sizing: border-box");
    expect(reviewWidgetHostStyle).toContain("position: sticky");
    expect(reviewWidgetHostStyle).toContain("left: 0");
    expect(reviewWidgetHostStyle).toContain("right: 0");
  });

  it("applies the width-containment style to the mounted review-thread element", () => {
    const comment: ReviewComment = {
      id: "review-1",
      anchor: { filePath: "src/a.ts", range: { side: "new", start: 1, end: 1 } },
      body: "hello",
      createdAt: 0,
      updatedAt: 0,
      sourceHash: "x",
    };
    const { review } = fakeReview({
      commentsForLine: (_path, ref) => (ref.line === 1 ? [comment] : []),
    });
    const view = makeView("a\nb\nc\n", review);
    const thread = view.dom.querySelector("pi-web-review-thread");
    if (thread === null || !(thread instanceof HTMLElement)) throw new Error("Expected a mounted review thread");
    // The parts of `reviewWidgetHostStyle` the test environment's CSS parser
    // does retain (everything except the `cqw`-valued `width` declaration,
    // see above) confirm `style.cssText` was actually assigned on this
    // element, not just that the exported constant looks right in isolation.
    expect(thread.style.boxSizing).toBe("border-box");
    expect(thread.style.position).toBe("sticky");
    expect(thread.style.left).toBe("0px");
    expect(thread.style.right).toBe("0px");
    view.destroy();
  });
});
