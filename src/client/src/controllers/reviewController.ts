import { machineSessionKey } from "../machineKeys";
import {
  clearComments as defaultClearComments,
  loadComments as defaultLoadComments,
  moveComments as defaultMoveComments,
  saveComments as defaultSaveComments,
} from "../review/reviewCommentStorage";
import { hashSource as defaultHashSource } from "../review/reviewHash";
import { buildReviewMarkdown } from "../review/reviewMarkdown";
import type { ReviewAnchor, ReviewComment, ReviewLineRef, ReviewSide } from "../review/reviewTypes";
import { selectedMachineId, type GetState, type SetState } from "./types";

interface ReviewCommentStorage {
  loadComments: typeof defaultLoadComments;
  saveComments: typeof defaultSaveComments;
  clearComments: typeof defaultClearComments;
  moveComments: typeof defaultMoveComments;
}

export interface ReviewControllerDependencies {
  storage?: ReviewCommentStorage;
  now?: () => number;
  idFactory?: () => string;
  hashSource?: (text: string) => string;
  /** Surfaces a transient human-readable notice, e.g. on staleness drop. No-op by default. */
  notify?: (message: string) => void;
}

/**
 * Result of {@link ReviewController.beginSend}: the ids present at send time
 * plus the markdown built from them. {@link ReviewController.completeSend}
 * removes exactly these ids on confirmed success; the caller (a session
 * currently locked via `reviewSendLocked`) cannot add more comments in
 * between (`canAuthor()` is false while locked), so the snapshot and the
 * store agree.
 */
export interface ReviewSendSnapshot {
  ids: string[];
  markdown: string;
}

/**
 * Owns the selected session's pending review comments plus the single active
 * selection/draft/send-lock. Every mutation persists to
 * `reviewCommentStorage` (localStorage) AND replaces the relevant `AppState`
 * fields immutably via `setState`.
 */
export class ReviewController {
  private readonly storage: ReviewCommentStorage;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly hashSource: (text: string) => string;
  private readonly notify: (message: string) => void;
  private sequence = 0;
  /**
   * `submitDraft()` creates the comment with a `sourceHash`, but
   * `AppState.reviewDraft` only carries `{ anchor, body }` -- there's no
   * field for it there. `commitSelection` takes a required `sourceHash`
   * parameter (the hash of the content the selection was made against) and
   * keeps it here, as controller-private bookkeeping for the *current* draft
   * only, rather than widening the public `ReviewDraft` shape. It is
   * cleared whenever the draft is cleared (submit/cancel/replace/adopt/
   * rename/forget).
   */
  private draftSourceHash: string | undefined;

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    deps: ReviewControllerDependencies = {},
  ) {
    this.storage = deps.storage ?? {
      loadComments: defaultLoadComments,
      saveComments: defaultSaveComments,
      clearComments: defaultClearComments,
      moveComments: defaultMoveComments,
    };
    this.now = deps.now ?? (() => Date.now());
    this.idFactory = deps.idFactory ?? (() => {
      this.sequence += 1;
      return `review-${String(this.sequence)}`;
    });
    this.hashSource = deps.hashSource ?? defaultHashSource;
    this.notify = deps.notify ?? (() => { /* no-op by default */ });
  }

  // --- Data / query ---------------------------------------------------

  list(): readonly ReviewComment[] {
    return this.getState().reviewComments;
  }

  forFile(path: string): readonly ReviewComment[] {
    return this.list().filter((comment) => comment.anchor.filePath === path);
  }

  countForFile(path: string): number {
    return this.forFile(path).length;
  }

  total(): number {
    return this.list().length;
  }

  commentsForLine(path: string, ref: ReviewLineRef): readonly ReviewComment[] {
    return this.forFile(path).filter((comment) => lineRefInRange(comment.anchor.range, ref));
  }

  lineState(path: string, ref: ReviewLineRef): { selected: boolean; commented: boolean } {
    const selection = this.getState().reviewSelection;
    const selected = selection?.filePath === path
      && selection.side === ref.side
      && ref.line >= Math.min(selection.anchorLine, selection.currentLine)
      && ref.line <= Math.max(selection.anchorLine, selection.currentLine);
    // "commented" covers both saved comments AND an open (not yet submitted)
    // draft overlapping this line: while a draft's form is showing, the live
    // `reviewSelection` has already been cleared by `commitSelection`, so
    // without this the range would go dark for the entire authoring window.
    const commented = this.commentsForLine(path, ref).length > 0 || this.draftForLine(path, ref) !== undefined;
    return { selected, commented };
  }

  // --- Authoring --------------------------------------------------------

  canAuthor(): boolean {
    const state = this.getState();
    return state.selectedSession !== undefined && !state.reviewSendLocked;
  }

  beginSelection(path: string, ref: ReviewLineRef): void {
    if (!this.canAuthor()) return;
    this.setState({ reviewSelection: { filePath: path, side: ref.side, anchorLine: ref.line, currentLine: ref.line } });
  }

  /** Clamped to the anchor's side: a ref on a different side is ignored. */
  extendSelection(ref: ReviewLineRef): void {
    const selection = this.getState().reviewSelection;
    if (selection?.side !== ref.side) return;
    this.setState({ reviewSelection: { ...selection, currentLine: ref.line } });
  }

  cancelSelection(): void {
    this.setState({ reviewSelection: undefined });
  }

  /**
   * Opens the draft at the current selection. `sourceHash` is the fingerprint
   * of the content the selection was made against (e.g. `hashSource(fileText)`
   * for `new`-side, or a diff-text hash for `old`-side); the caller (the
   * Files/Git surface) computes it since only it has the content at commit
   * time. Overwrites any already-open draft: UI-level confirm-before-discard
   * is the caller's responsibility, not this pure controller's. No-ops when
   * there is no active selection or authoring is not allowed.
   */
  commitSelection(sourceHash: string): void {
    const selection = this.getState().reviewSelection;
    if (selection === undefined || !this.canAuthor()) return;
    const start = Math.min(selection.anchorLine, selection.currentLine);
    const end = Math.max(selection.anchorLine, selection.currentLine);
    this.draftSourceHash = sourceHash;
    this.setState({
      reviewSelection: undefined,
      reviewDraft: {
        anchor: { filePath: selection.filePath, range: { side: selection.side, start, end } },
        body: "",
      },
    });
  }

  draft(): { anchor: ReviewComment["anchor"]; body: string } | undefined {
    return this.getState().reviewDraft;
  }

  draftForLine(path: string, ref: ReviewLineRef): { anchor: ReviewComment["anchor"]; body: string } | undefined {
    const draft = this.draft();
    if (draft?.anchor.filePath !== path) return undefined;
    return lineRefInRange(draft.anchor.range, ref) ? draft : undefined;
  }

  setDraftBody(text: string): void {
    const draft = this.getState().reviewDraft;
    if (draft === undefined) return;
    this.setState({ reviewDraft: { ...draft, body: text } });
  }

  /** Creates the comment from the current draft and persists it. No-ops without an open draft. */
  submitDraft(anchor?: ReviewAnchor): void {
    const draft = this.getState().reviewDraft;
    if (draft === undefined) return;
    const timestamp = this.now();
    const comment: ReviewComment = {
      id: this.idFactory(),
      anchor: anchor ?? draft.anchor,
      body: draft.body,
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceHash: this.draftSourceHash ?? "",
    };
    this.persistComments([...this.getState().reviewComments, comment]);
    this.draftSourceHash = undefined;
    this.setState({ reviewDraft: undefined });
  }

  cancelDraft(): void {
    this.draftSourceHash = undefined;
    this.setState({ reviewDraft: undefined });
  }

  update(id: string, body: string, anchor: ReviewAnchor): void {
    const timestamp = this.now();
    this.persistComments(this.getState().reviewComments.map((comment) => (comment.id === id ? { ...comment, body, anchor, updatedAt: timestamp } : comment)));
  }

  remove(id: string): void {
    this.persistComments(this.getState().reviewComments.filter((comment) => comment.id !== id));
  }

  // --- Staleness -----------------------------------------------------------

  invalidateFile(path: string, currentHash: string): void {
    const comments = this.getState().reviewComments;
    const kept = comments.filter((comment) => comment.anchor.filePath !== path || comment.sourceHash === currentHash);
    const droppedCount = comments.length - kept.length;
    if (droppedCount === 0) return;
    this.persistComments(kept);
    this.notify(`Discarded ${String(droppedCount)} stale review ${droppedCount === 1 ? "comment" : "comments"} on ${path}: the content changed.`);
  }

  // --- Send lifecycle -------------------------------------------------------

  beginSend(): ReviewSendSnapshot {
    this.cancelDraft();
    const comments = this.getState().reviewComments;
    this.setState({ reviewSendLocked: true });
    return { ids: comments.map((comment) => comment.id), markdown: buildReviewMarkdown(comments) };
  }

  completeSend(ids: readonly string[]): void {
    const sent = new Set(ids);
    this.persistComments(this.getState().reviewComments.filter((comment) => !sent.has(comment.id)));
    this.setState({ reviewSendLocked: false });
  }

  abortSend(): void {
    this.setState({ reviewSendLocked: false });
  }

  // --- Session lifecycle ---------------------------------------------------

  adoptSession(machineId: string, sessionId: string): void {
    this.draftSourceHash = undefined;
    const comments = this.storage.loadComments(machineSessionKey(machineId, sessionId));
    this.setState({ reviewComments: comments, reviewDraft: undefined, reviewSelection: undefined });
  }

  /** No session selected: reset in-memory review state only -- storage is untouched, so a reselected session's comments reload via `adoptSession`. */
  clearActiveSession(): void {
    this.draftSourceHash = undefined;
    this.setState({ reviewComments: [], reviewDraft: undefined, reviewSelection: undefined });
  }

  /**
   * Moves the store from one session key to another. Mirrors
   * `moveDraft`/`moveStagedAttachments`, which `sessionController` already
   * calls with pre-built `machineSessionKey(machineId, sessionId)` keys at
   * its rename call sites (temp-id -> real id, cached-new -> replacement).
   */
  renameSession(oldSessionKey: string, newSessionKey: string): void {
    this.storage.moveComments(oldSessionKey, newSessionKey);
  }

  forgetSession(machineId: string, sessionId: string): void {
    this.storage.clearComments(machineSessionKey(machineId, sessionId));
  }

  private persistComments(comments: readonly ReviewComment[]): void {
    const machineId = selectedMachineId(this.getState());
    const sessionId = this.getState().selectedSession?.id;
    this.setState({ reviewComments: comments });
    if (sessionId === undefined) return;
    this.storage.saveComments(machineSessionKey(machineId, sessionId), comments);
  }
}

function lineRefInRange(range: { side: ReviewSide; start: number; end: number }, ref: ReviewLineRef): boolean {
  return range.side === ref.side && ref.line >= Math.min(range.start, range.end) && ref.line <= Math.max(range.start, range.end);
}
