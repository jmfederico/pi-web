import { LitElement, css, html, type PropertyValues, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { customElement, property, state } from "lit/decorators.js";
import { formatAnchorLabel } from "../review/reviewCoordinates";
import type { ReviewAnchor, ReviewComment } from "../review/reviewTypes";
import { actionMenuPanelStyle } from "./actionMenu";
import { createMobilePromptEnterMedia, readPromptEnterPreference, shouldSendPromptOnEnterShortcut } from "../promptEnterBehavior";
import { toSafeMarkdownHtml } from "../formatting/markdown";

/** An in-progress, not-yet-saved comment rendered alongside saved ones. */
export interface ReviewThreadDraft {
  anchor: ReviewAnchor;
  body: string;
}

/**
 * Inline comment card: renders saved comments for a line/anchor plus an
 * optional in-progress draft. Registered as a standalone custom element so
 * it mounts from a CM6 block widget or a plugin's own DOM tree.
 */
@customElement("pi-web-review-thread")
export class ReviewThread extends LitElement {
  @property({ attribute: false }) comments: readonly ReviewComment[] = [];
  @property({ attribute: false }) draft: ReviewThreadDraft | undefined;
  @property({ attribute: false }) onSubmitDraft?: (body: string, anchor: ReviewAnchor) => void;
  @property({ attribute: false }) onCancelDraft?: () => void;
  @property({ attribute: false }) onUpdate?: (id: string, body: string, anchor: ReviewAnchor) => void;
  @property({ attribute: false }) onRemove?: (id: string) => void;

  /** Which saved comment (if any) is currently swapped into edit mode. */
  @state() private editingCommentId: string | undefined;
  @state() private editingBody = "";
  @state() private draftBody = "";
  @state() private openMenuCommentId: string | undefined;
  @state() private menuStyle = "";
  @state() private lineRangeEditOpen = false;
  @state() private lineEditStartLine: number | undefined;
  @state() private lineEditEndLine: number | undefined;

  private readonly mobilePromptEnterMedia = createMobilePromptEnterMedia();

  private readonly onDocumentClick = (event: MouseEvent) => {
    if (event.composedPath().includes(this)) return;
    this.openMenuCommentId = undefined;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onDocumentClick);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.onDocumentClick);
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("draft")) this.draftBody = this.draft?.body ?? "";
    if (changed.has("comments") && this.editingCommentId !== undefined && !this.comments.some((comment) => comment.id === this.editingCommentId)) {
      this.editingCommentId = undefined;
    }
  }

  override render(): TemplateResult {
    return html`
      <div class="thread">
        ${this.comments.map((comment) => this.renderComment(comment))}
        ${this.draft === undefined ? null : this.renderDraft(this.draft)}
      </div>
    `;
  }

  private renderComment(comment: ReviewComment): TemplateResult {
    if (this.editingCommentId === comment.id) return this.renderEditingComment(comment);
    const menuOpen = this.openMenuCommentId === comment.id;
    return html`
      <div class="card">
        <div class="card-header">
          <small class="caption">${formatAnchorLabel(comment.anchor)}</small>
          <div class="action-menu">
            <button
              type="button"
              class="action-menu-toggle"
              title="Comment actions"
              aria-label="Comment actions"
              aria-expanded=${String(menuOpen)}
              @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(comment.id, event.currentTarget); }}
            >⋯</button>
            ${menuOpen ? html`
              <div class="action-menu-panel" style=${this.menuStyle} @click=${(event: MouseEvent) => { event.stopPropagation(); }}>
                <button type="button" @click=${() => { this.beginEdit(comment); }}>Edit</button>
                <button type="button" class="danger" @click=${() => { this.openMenuCommentId = undefined; this.onRemove?.(comment.id); }}>Delete</button>
              </div>
            ` : null}
          </div>
        </div>
        <div class="body">${unsafeHTML(toSafeMarkdownHtml(comment.body))}</div>
      </div>
    `;
  }

  private renderEditingComment(comment: ReviewComment): TemplateResult {
    return html`
      <div class="card">
        <small class="caption">${this.renderEditingCaption(comment.anchor)}</small>
        <textarea
          class="editor"
          rows="3"
          .value=${this.editingBody}
          @input=${(event: Event) => { if (event.target instanceof HTMLTextAreaElement) this.editingBody = event.target.value; }}
          @keydown=${(event: KeyboardEvent) => { this.handleEditingKeydown(event); }}
        ></textarea>
        <div class="editor-actions">
          <button type="button" class="primary" ?disabled=${this.editingBody.trim() === ""} @click=${() => { this.saveEdit(comment.id); }}>Save</button>
          <button type="button" @click=${() => { this.cancelEdit(); }}>Cancel</button>
        </div>
      </div>
    `;
  }

  private renderDraft(draft: ReviewThreadDraft): TemplateResult {
    return html`
      <div class="card draft">
        <small class="caption">${this.renderDraftCaption(draft)}</small>
        <textarea
          class="editor"
          rows="3"
          placeholder="Leave a comment…"
          .value=${this.draftBody}
          @input=${(event: Event) => { if (event.target instanceof HTMLTextAreaElement) this.draftBody = event.target.value; }}
          @keydown=${(event: KeyboardEvent) => { this.handleDraftKeydown(event); }}
        ></textarea>
        <div class="editor-actions">
          <button type="button" class="primary" ?disabled=${this.draftBody.trim() === ""} @click=${() => { this.submitDraft(); }}>Comment</button>
          <button type="button" @click=${() => { this.onCancelDraft?.(); }}>Cancel</button>
        </div>
      </div>
    `;
  }

  private renderDraftCaption(draft: ReviewThreadDraft): TemplateResult {
    const { filePath, range } = draft.anchor;
    const { start, end, side } = range;
    const sideLabel = side === "old" ? " (deleted)" : "";
    const isSingleLine = start === end;
    const startLine = this.lineEditStartLine ?? start;
    const endLine = this.lineEditEndLine ?? end;
    const maxLine = 9999;
    const isInvalid = startLine < 1 || endLine < 1 || startLine > endLine || startLine > maxLine || endLine > maxLine;

    if (this.lineRangeEditOpen) {
      return html`${filePath}:<span class="line-range-edit"><input type="number" min="1" max="${String(maxLine)}" .value=${String(startLine)} class="line-input ${isInvalid ? "invalid" : ""}" @input=${(event: Event) => { if (event.target instanceof HTMLInputElement) { this.lineEditStartLine = parseInt(event.target.value, 10) || 1; } }} /> – <input type="number" min="1" max="${String(maxLine)}" .value=${String(endLine)} class="line-input ${isInvalid ? "invalid" : ""}" @input=${(event: Event) => { if (event.target instanceof HTMLInputElement) { this.lineEditEndLine = parseInt(event.target.value, 10) || 1; } }} />${sideLabel}</span>`;
    }
    const lineLabel = isSingleLine ? String(start) : `${String(start)}-${String(end)}`;
    return html`${filePath}:<span class="line-range"><span class="line-number-clickable" @click=${() => { this.openDraftLineRangeEdit(); }}>${lineLabel}</span>${sideLabel}</span>`;
  }

  private openDraftLineRangeEdit(): void {
    const { start, end } = this.draft?.anchor.range ?? { start: 1, end: 1 };
    this.lineRangeEditOpen = true;
    this.lineEditStartLine = start;
    this.lineEditEndLine = end;
  }

  private renderEditingCaption(anchor: ReviewAnchor): TemplateResult {
    const { filePath, range } = anchor;
    const { start, end, side } = range;
    const sideLabel = side === "old" ? " (deleted)" : "";
    const isSingleLine = start === end;
    const startLine = this.lineEditStartLine ?? start;
    const endLine = this.lineEditEndLine ?? end;
    const maxLine = 9999;

    if (this.lineRangeEditOpen) {
      return html`${filePath}:<span class="line-range-edit"><input type="number" min="1" max="${String(maxLine)}" .value=${String(startLine)} class="line-input" @input=${(event: Event) => { if (event.target instanceof HTMLInputElement) { this.lineEditStartLine = parseInt(event.target.value, 10) || 1; } }} /> – <input type="number" min="1" max="${String(maxLine)}" .value=${String(endLine)} class="line-input" @input=${(event: Event) => { if (event.target instanceof HTMLInputElement) { this.lineEditEndLine = parseInt(event.target.value, 10) || 1; } }} />${sideLabel}</span>`;
    }
    const lineLabel = isSingleLine ? String(start) : `${String(start)}-${String(end)}`;
    return html`${filePath}:<span class="line-range"><span class="line-number-clickable" @click=${() => { this.openEditingLineRangeEdit(anchor); }}>${lineLabel}</span>${sideLabel}</span>`;
  }

  private openEditingLineRangeEdit(anchor: ReviewAnchor): void {
    const { start, end } = anchor.range;
    this.lineRangeEditOpen = true;
    this.lineEditStartLine = start;
    this.lineEditEndLine = end;
  }

  /** No-ops for a blank/whitespace-only body -- an empty comment carries no signal and is not worth persisting. Mirrors the `?disabled` guard on the "Comment" button as a belt-and-suspenders check. */
  private submitDraft(): void {
    if (this.draftBody.trim() === "") return;
    if (!this.draft) return;
    this.lineRangeEditOpen = false;
    const startLine = this.lineEditStartLine ?? this.draft.anchor.range.start;
    const endLine = this.lineEditEndLine ?? this.draft.anchor.range.end;
    const updatedAnchor: ReviewAnchor = {
      filePath: this.draft.anchor.filePath,
      range: {
        side: this.draft.anchor.range.side,
        start: startLine,
        end: endLine,
      },
    };
    this.onSubmitDraft?.(this.draftBody, updatedAnchor);
  }

  private toggleMenu(commentId: string, target: EventTarget | null): void {
    if (this.openMenuCommentId === commentId) {
      this.openMenuCommentId = undefined;
      return;
    }
    this.menuStyle = actionMenuPanelStyle(target, { constrainTo: "viewport" });
    this.openMenuCommentId = commentId;
  }

  private beginEdit(comment: ReviewComment): void {
    this.openMenuCommentId = undefined;
    this.editingCommentId = comment.id;
    this.editingBody = comment.body;
  }

  /** No-ops for a blank/whitespace-only body, mirroring `submitDraft`'s guard (belt-and-suspenders alongside the `?disabled` guard on the "Save" button). */
  private saveEdit(commentId: string): void {
    const body = this.editingBody;
    if (body.trim() === "") return;
    const comment = this.comments.find((c) => c.id === commentId);
    if (!comment) return;
    this.editingCommentId = undefined;
    this.lineRangeEditOpen = false;
    const startLine = this.lineEditStartLine ?? comment.anchor.range.start;
    const endLine = this.lineEditEndLine ?? comment.anchor.range.end;
    const updatedAnchor: ReviewAnchor = {
      filePath: comment.anchor.filePath,
      range: {
        side: comment.anchor.range.side,
        start: startLine,
        end: endLine,
      },
    };
    this.onUpdate?.(commentId, body, updatedAnchor);
  }

  private cancelEdit(): void {
    this.editingCommentId = undefined;
    this.lineRangeEditOpen = false;
  }

  private handleDraftKeydown(event: KeyboardEvent): void {
    this.handleCommentEditorKeydown(event, this.draftBody, () => { this.submitDraft(); });
  }

  private handleEditingKeydown(event: KeyboardEvent): void {
    const commentId = this.editingCommentId;
    if (commentId === undefined) return;
    this.handleCommentEditorKeydown(event, this.editingBody, () => { this.saveEdit(commentId); });
  }

  private handleCommentEditorKeydown(event: KeyboardEvent, body: string, onSubmit: () => void): void {
    if (event.key !== "Enter" || event.defaultPrevented || event.isComposing) return;
    const shouldSubmit = shouldSendPromptOnEnterShortcut(event.shiftKey, this.mobilePromptEnterMedia, readPromptEnterPreference());
    if (shouldSubmit && body.trim() !== "") {
      event.preventDefault();
      onSubmit();
    }
  }

  static override styles = css`
    /*
     * BUG FIX: this element is mounted as a light-DOM child of CodeMirror's
     * .cm-content (Files tab) or inside a diff row (Git tab), both of which
     * set white-space: break-spaces / pre for code display -- an INHERITED
     * property. Without an explicit reset here, :host inherits that value,
     * and the plain indentation/newline whitespace text nodes that Lit's
     * own multi-line html-tagged template literal produces around .thread
     * render as literal, visible, wrapped multi-line content instead of
     * collapsing (normal HTML whitespace behavior), adding an unexplained
     * gap above and below the actual card.
     */
    :host { display: block; white-space: normal; padding: 0.2em 0.4em; color: var(--pi-text); font: 13px system-ui, sans-serif; }
    .thread { display: flex; flex-direction: column; gap: 8px; }
    .card { box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 1px solid var(--pi-border-muted); border-radius: 8px; background: var(--pi-surface); }
    .card.draft { background: var(--pi-selection-bg); }
    .card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .caption { color: var(--pi-muted); font-size: 11px; overflow-wrap: anywhere; }
    .line-range, .line-range-edit { display: inline-flex; align-items: center; gap: 4px; }
    .line-number-clickable { color: var(--pi-accent); text-decoration: underline; cursor: pointer; }
    .line-input { width: 40px; padding: 2px 4px; border: 1px solid var(--pi-border-muted); border-radius: 3px; background: var(--pi-bg); color: var(--pi-text); font: 11px system-ui, sans-serif; }
    .line-input.invalid { border-color: var(--pi-danger); background: color-mix(in srgb, var(--pi-danger) 8%, var(--pi-bg)); }
    .body { margin: 0; overflow-wrap: anywhere; white-space: normal; line-height: 1.45; }
    .body p, .body ul, .body ol, .body pre, .body blockquote { margin: 0 0 8px; }
    .body :last-child { margin-bottom: 0; }
    .body ul, .body ol { padding-left: 20px; }
    .body li + li { margin-top: 2px; }
    .body code { border: 1px solid var(--pi-border-muted); border-radius: 3px; background: var(--pi-bg); padding: 1px 3px; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .body pre { border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-bg); padding: 8px; overflow-x: auto; }
    .body pre code { border: 0; padding: 0; background: transparent; }
    .body blockquote { border-left: 3px solid var(--pi-border-muted); padding-left: 8px; color: var(--pi-muted); }
    .body a { color: var(--pi-accent); }
    .body h1, .body h2, .body h3, .body h4 { margin: 10px 0 6px; line-height: 1.2; }
    .body h1:first-child, .body h2:first-child, .body h3:first-child, .body h4:first-child { margin-top: 0; }
    .body h1 { font-size: 15px; }
    .body h2 { font-size: 14px; }
    .body h3 { font-size: 13px; }
    .body h4 { font-size: 12px; }
    .action-menu { position: relative; align-self: flex-start; }
    .action-menu-toggle { display: grid; place-items: center; min-width: 24px; padding: 0 4px; border: 0; background: transparent; color: var(--pi-muted); cursor: pointer; }
    .action-menu-toggle:hover { color: var(--pi-text); }
    .action-menu-panel { position: fixed; z-index: 50; box-sizing: border-box; min-width: min(120px, calc(100vw - 16px)); overflow: auto; padding: 4px; border: 1px solid var(--pi-border-muted); border-radius: 8px; background: var(--pi-surface); }
    .action-menu-panel button { display: block; width: 100%; border: 0; border-radius: 5px; background: transparent; color: var(--pi-text); padding: 5px 7px; text-align: left; cursor: pointer; }
    .action-menu-panel button:hover { background: var(--pi-selection-bg); }
    .action-menu-panel button.danger { color: var(--pi-danger); }
    .editor { box-sizing: border-box; width: 100%; min-height: 54px; resize: vertical; border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-bg); color: var(--pi-text); caret-color: var(--pi-accent); padding: 6px 8px; font: inherit; }
    .editor-actions { display: flex; justify-content: flex-end; gap: 6px; }
    .editor-actions button { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 6px 10px; font: inherit; cursor: pointer; }
    .editor-actions button:hover { background: var(--pi-bg); }
    .editor-actions button.primary { border-color: var(--pi-accent); color: var(--pi-accent); }
    .editor-actions button.primary:hover { background: color-mix(in srgb, var(--pi-accent) 8%, var(--pi-surface)); }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "pi-web-review-thread": ReviewThread;
  }
}
