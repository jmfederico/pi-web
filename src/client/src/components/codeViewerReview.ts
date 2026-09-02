import { Decoration, type DecorationSet, EditorView, WidgetType, type BlockInfo } from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, type Transaction } from "@codemirror/state";
import { hashSource } from "../review/reviewHash";
import type { ReviewComment } from "../review/reviewTypes";
import type { WorkspaceReview, WorkspaceReviewDraft } from "../plugins/types";
import "./ReviewThread";

/**
 * Normalizes a gutter drag gesture (anchor line + current pointer line) into
 * an ordered `{start, end}` line range, regardless of drag direction. Pure,
 * unit-tested in isolation from any CM6/DOM plumbing.
 */
export function computeDragRange(anchorLine: number, currentLine: number): { start: number; end: number } {
  return { start: Math.min(anchorLine, currentLine), end: Math.max(anchorLine, currentLine) };
}

/** Options shared by the gutter handlers and the decoration/widget extensions. */
export interface CodeViewerReviewOptions {
  /** Workspace-relative path of the file shown in this viewer. */
  filePath: string;
  /** Gesture-agnostic review service (same instance used by plugin surfaces). */
  review: WorkspaceReview;
}

/**
 * `CodeViewer`'s `review` property type: `WorkspaceReview` plus an optional
 * core-only `invalidateFile` (staleness drop), withheld from the public
 * plugin-facing type but needed by `CodeViewer` itself.
 */
export interface CodeViewerReview extends WorkspaceReview {
  invalidateFile?(path: string, currentHash: string): void;
}

/**
 * Dispatched (with no payload) whenever review data may have changed for
 * reasons CM6 cannot observe on its own -- e.g. a `<pi-web-review-thread>`
 * callback mutated the controller's comments/draft outside of any CM6
 * transaction. The widgets `ViewPlugin` recomputes its decorations whenever a
 * transaction carries this effect. This is the "refresh decorations without a
 * full `recreateEditor()`" mechanism referenced in the design.
 */
export const reviewRefreshEffect = StateEffect.define<undefined>();

/** Tracks the in-progress gutter drag gesture (anchor + current line), local to this editor instance. */
const dragEffect = StateEffect.define<{ anchor: number; current: number } | undefined>();

const dragField = StateField.define<{ anchor: number; current: number } | undefined>({
  create: () => undefined,
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(dragEffect)) next = effect.value;
    }
    return next;
  },
});

/** 1-based line number under a resolved gutter `BlockInfo`. */
function lineNumberOf(view: EditorView, line: BlockInfo): number {
  return view.state.doc.lineAt(line.from).number;
}

/**
 * Gutter `domEventHandlers` (installed on the `lineNumbers()` gutter by
 * `CodeViewer`) driving the shared `review` selection state machine. Always
 * `side: "new"` -- the Files raw view only ever shows current file lines.
 */
export function reviewGutterDomEventHandlers(options: CodeViewerReviewOptions): {
  mousedown: (view: EditorView, line: BlockInfo, event: Event) => boolean;
  mousemove: (view: EditorView, line: BlockInfo, event: Event) => boolean;
  mouseup: (view: EditorView, line: BlockInfo, event: Event) => boolean;
} {
  const { filePath, review } = options;
  return {
    mousedown(view, line, event) {
      if (!(event instanceof MouseEvent) || event.button !== 0) return false;
      const lineNumber = lineNumberOf(view, line);
      review.beginSelection(filePath, { side: "new", line: lineNumber });
      view.dispatch({ effects: dragEffect.of({ anchor: lineNumber, current: lineNumber }) });
      return true;
    },
    mousemove(view, line, event) {
      if (!(event instanceof MouseEvent) || event.buttons !== 1) return false;
      const drag = view.state.field(dragField);
      if (drag === undefined) return false;
      const lineNumber = lineNumberOf(view, line);
      review.extendSelection({ side: "new", line: lineNumber });
      view.dispatch({ effects: dragEffect.of({ anchor: drag.anchor, current: lineNumber }) });
      return true;
    },
    mouseup(view, line) {
      const drag = view.state.field(dragField);
      if (drag === undefined) return false;
      const lineNumber = lineNumberOf(view, line);
      // Cover the plain-click case (no intervening mousemove) and the case
      // where the pointer jumped straight to the final line without firing a
      // gutter mousemove in between: extend once more to the mouseup line
      // before committing, so the committed range always reflects where the
      // gesture actually ended.
      review.extendSelection({ side: "new", line: lineNumber });
      review.commitSelection(hashSource(view.state.doc.toString()));
      view.dispatch({ effects: [dragEffect.of(undefined), reviewRefreshEffect.of(undefined)] });
      return true;
    },
  };
}

/**
 * Raw style-mod spec (the plain object CM6's `EditorView.theme()` compiles),
 * exported so tests can assert on the intended rules directly -- happy-dom
 * does not evaluate `:hover` against real layout.
 */
export const reviewThemeSpec = {
  ".cm-review-selected": { backgroundColor: "var(--pi-selection-bg)" },
  ".cm-review-commented": { borderLeft: "2px solid var(--pi-accent)", paddingLeft: "calc(0.5ch - 2px)" },
  ".cm-lineNumbers .cm-gutterElement": { position: "relative", cursor: "default", paddingRight: "1.6ch" },
  ".cm-lineNumbers .cm-gutterElement:hover": { cursor: "pointer", color: "var(--pi-accent)" },
  ".cm-lineNumbers .cm-gutterElement:hover::after": { content: "\"+\"", position: "absolute", right: "2px", color: "var(--pi-accent)" },
} as const satisfies Record<string, Record<string, string>>;

function reviewLineHighlightTheme(): Extension {
  return EditorView.theme(reviewThemeSpec);
}

const reviewSelectionLineDecoration = Decoration.line({ class: "cm-review-selected" });
const reviewCommentedLineDecoration = Decoration.line({ class: "cm-review-commented" });

/**
 * Inline style applied to the `<pi-web-review-thread>` element mounted by
 * {@link ReviewThreadWidget}. Exported as a plain string (assigned wholesale
 * via `style.cssText`) rather than individual `style.<prop> = ...`
 * assignments so it is directly testable as source-of-truth text: some test
 * environments' `CSSStyleDeclaration` implementations reject the (valid,
 * broadly browser-supported) `cqw` container-query unit outright and silently
 * drop the whole declaration, making `element.style.width` an unreliable
 * read-back target regardless of how the property was set.
 *
 * BUG FIX: this used to be `width: 100cqw; ...; left: 0;` with no `right`.
 * `left: 0` alone pins the sticky box's LEFT edge to the scrolled viewport,
 * but an explicit `width: 100cqw` keeps its width equal to the *unscrolled*
 * full scroller width -- once the user scrolls the code horizontally, the
 * box's right edge necessarily extends past the visible viewport by exactly
 * the scroll offset (confirmed live via CDP: a ~39px scroll produced a
 * ~39px right-edge overflow). Setting both `left: 0` and `right: 0` with no
 * explicit width instead lets the sticky box stretch to fill exactly the
 * visible inline space, which stays correct at any scroll offset.
 */
export const reviewWidgetHostStyle = "box-sizing: border-box; position: sticky; left: 0; right: 0;";

/**
 * Block widget hosting one `<pi-web-review-thread>` element for a single
 * anchor line, bound to that line's saved comments and/or open draft. A new
 * `ReviewThreadWidget` instance is constructed on every decoration rebuild,
 * but `eq()` compares the actual comment/draft content so CM6 reuses the
 * existing DOM node (and the element's internal edit/menu state) whenever
 * nothing for this line actually changed.
 */
class ReviewThreadWidget extends WidgetType {
  constructor(
    private readonly filePath: string,
    private readonly comments: readonly ReviewComment[],
    private readonly draft: WorkspaceReviewDraft | null,
    private readonly review: WorkspaceReview,
  ) {
    super();
  }

  override eq(other: ReviewThreadWidget): boolean {
    return this.filePath === other.filePath && this.signature() === other.signature();
  }

  private signature(): string {
    const comments = this.comments.map((comment) => `${comment.id}:${String(comment.updatedAt)}:${comment.body}`).join("|");
    const draft = this.draft === null ? "" : this.draft.body;
    return `${comments}//${draft}`;
  }

  override toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("pi-web-review-thread");
    // Width containment (bug fix): `.cm-content` is exactly as wide as the
    // widest line (`.cm-scroller` scrolls horizontally when lines are long),
    // so a plain 100%-width block widget would match that full scrollable
    // width rather than the visible viewport. `position: sticky; left: 0;
    // right: 0` (see `reviewWidgetHostStyle`'s doc comment) stretches the
    // box to exactly the visible inline space and keeps it on-screen while
    // the user has scrolled the line content horizontally.
    el.style.cssText = reviewWidgetHostStyle;
    el.comments = this.comments;
    el.draft = this.draft ?? undefined;
    const refresh = () => { view.dispatch({ effects: reviewRefreshEffect.of(undefined) }); };
    el.onSubmitDraft = (body, anchor) => { this.review.setDraftBody(body); this.review.submitDraft(anchor); refresh(); };
    el.onCancelDraft = () => { this.review.cancelDraft(); refresh(); };
    el.onUpdate = (id, body, anchor) => { this.review.updateComment(id, body, anchor); refresh(); };
    el.onRemove = (id) => { this.review.removeComment(id); refresh(); };
    return el;
  }
}

/**
 * Builds decorations for every doc line: a highlight (selected and/or
 * commented, from {@link WorkspaceReview.lineState}) covering the WHOLE
 * range of an active selection, an open draft, or a saved comment -- not
 * just their anchor line -- plus a `<pi-web-review-thread>` widget anchored
 * after each comment/draft's LAST line (so a multi-line range only mounts
 * one widget, at its end). Only `new`-side data is ever requested here: the
 * Files raw view has no concept of an "old" side (that only exists in the
 * Git diff), so every call below is explicitly `side: "new"` -- deleted-line
 * comments are a Git-tab-only concern.
 */
function buildCommentDecorations(state: EditorState, options: CodeViewerReviewOptions): DecorationSet {
  const { filePath, review } = options;
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const ref = { side: "new" as const, line: lineNumber };
    const line = doc.line(lineNumber);
    const { selected, commented } = review.lineState(filePath, ref);
    if (selected) builder.add(line.from, line.from, reviewSelectionLineDecoration);
    else if (commented) builder.add(line.from, line.from, reviewCommentedLineDecoration);

    const comments = review.commentsForLine(filePath, ref).filter((comment) => comment.anchor.range.end === lineNumber);
    const draftAtLine = review.draftForLine(filePath, ref);
    const draft = draftAtLine !== null && draftAtLine.anchor.range.end === lineNumber ? draftAtLine : null;
    if (comments.length === 0 && draft === null) continue;
    const widget = new ReviewThreadWidget(filePath, comments, draft, review);
    builder.add(line.to, line.to, Decoration.widget({ widget, block: true, side: 1 }));
  }
  return builder.finish();
}

/**
 * Block widgets must be provided via a `StateField` (CM6 rejects block
 * decorations sourced from a `ViewPlugin`), so comment/draft widgets and the
 * selection/comment highlight are recomputed inside the field's `update()`
 * whenever: the doc changes, a gutter drag extends the live selection (the
 * `dragEffect` a mousemove/mouseup dispatches after mutating the controller's
 * `reviewSelection`), or a transaction carries {@link reviewRefreshEffect}
 * (dispatched after any `<pi-web-review-thread>` callback mutates comments/
 * drafts outside of a CM6 transaction).
 */
function commentWidgetsExtension(options: CodeViewerReviewOptions): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => buildCommentDecorations(state, options),
    update(value, tr: Transaction) {
      const shouldRebuild = tr.docChanged
        || tr.effects.some((effect) => effect.is(reviewRefreshEffect) || effect.is(dragEffect));
      return shouldRebuild ? buildCommentDecorations(tr.state, options) : value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  return field;
}

/**
 * All CM6 extensions needed for gutter-driven review authoring + inline
 * comment/draft rendering on a single file. `CodeViewer` includes this array
 * only when `review`/`reviewFilePath` are set; the gutter's `domEventHandlers`
 * (built separately via {@link reviewGutterDomEventHandlers}) are installed
 * on the `lineNumbers()` gutter itself by the caller.
 */
export function buildReviewExtensions(options: CodeViewerReviewOptions): Extension[] {
  return [dragField, reviewLineHighlightTheme(), commentWidgetsExtension(options)];
}
