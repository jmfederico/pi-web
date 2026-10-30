import { stylesheetIntegrationCapability } from "../plugins/styles";
import { localization, LocalizationController } from "../localization/browser";
import definitions from "./askUser.messages";
import { LitElement, css, html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { uiButtonStyles } from "./ui/controlStyles";
import { uiTranscriptStyles } from "./ui/transcriptStyles";
import { uiTranscriptCardStyles } from "./ui/transcriptCardStyles";
import { uiFormStyles } from "./ui/formStyles";
import {
  ASK_USER_COMMENT_MAX_LENGTH,
  ASK_USER_OTHER_TEXT_MAX_LENGTH,
  type AskUserOutcome,
  type AskUserQuestion,
  type AskUserQuestionRecord,
  type AskUserSubmission,
  type AskUserRequest,
} from "../../../shared/apiTypes";
import {
  answeredCount,
  isCommentOpen,
  isCustomAnswerSelected,
  loadAskDraft,
  saveAskDraft,
  toSubmission,
  unansweredQuestions,
  type AskDraftAnswer,
  type AskDraftAnswers,
} from "../askDrafts";

export const askUserMessages = localization.registerMessages("core.askUser", definitions);

/** Structured outcome fields own browser presentation; the stored summary is model-facing text. */
export function askUserOutcomeSummary(outcome: AskUserOutcome): string {
  const counts = { answered: outcome.answeredCount, total: outcome.questions.length };
  return outcome.unansweredIds.length === 0
    ? askUserMessages.t("completeSummary", counts)
    : askUserMessages.t("partialSummary", { ...counts, ids: localization.list(outcome.unansweredIds) });
}

export type AskUserSubmitCallback = (askId: string, submission: AskUserSubmission) => void | Promise<void>;

interface DisplayedRecordAnswer {
  values: string[];
  otherText?: string;
  comment?: string;
  fromDraft: boolean;
}

/**
 * One question set posted by `ask_user`.
 *
 * The transcript projection owns availability. This component owns only local
 * drafts; closed requests and response records never expose answer controls.
 */
@customElement("ask-user-card")
export class AskUserCard extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @property({ attribute: false }) ask?: AskUserRequest;
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) outcomes: readonly AskUserOutcome[] = [];
  @property({ attribute: false }) outcome?: AskUserOutcome;
  /** A response alongside an original request need not repeat offered options. */
  @property({ type: Boolean }) compact = false;
  /** Machine-scoped session cache key used by the ask draft store. */
  @property({ attribute: false }) draftSessionId = "";
  @property({ attribute: false }) onSubmit: AskUserSubmitCallback | undefined;

  @state() private answers: AskDraftAnswers = {};
  @state() private confirmingPartialSubmit = false;
  @state() private submitting = false;
  private modelIdentity: string | undefined;

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has("ask") && !changed.has("outcome") && !changed.has("draftSessionId")) return;
    const identity = this.currentModelIdentity();
    if (identity === this.modelIdentity) return;
    this.modelIdentity = identity;
    this.answers = this.loadCurrentDraft();
    this.confirmingPartialSubmit = false;
    this.submitting = false;
  }

  override render(): TemplateResult | null {
    if (this.outcome !== undefined) return this.renderRecord(this.outcome);
    if (this.ask !== undefined) return this.open && this.onSubmit !== undefined
      ? this.renderOpenAsk(this.ask) : this.renderClosedAsk(this.ask);
    return null;
  }

  private renderOpenAsk(ask: AskUserRequest): TemplateResult {
    const count = answeredCount(ask.questions, this.answers);
    const unanswered = unansweredQuestions(ask.questions, this.answers);
    return html`
      <article class="ui-transcript-surface card open-card" aria-labelledby="ask-user-heading">
        <header class="ui-transcript-card-header card-header">
          <h2 id="ask-user-heading">${askUserMessages.t("questions")}</h2>
          <span class="ui-transcript-card-status header-status" role="status" aria-live="polite" aria-atomic="true">
            ${askUserMessages.t("progress", { answered: count, total: ask.questions.length })}
          </span>
        </header>
        <form class="ask-form" @submit=${(event: SubmitEvent) => { this.handleSubmit(event, ask); }}>
          <div class="questions">
            ${ask.questions.map((question, index) => this.renderQuestion(ask, question, index))}
          </div>
          <footer class="form-footer">
            <button class="ui-button ui-button--compact secondary-action skip-questions" type="button" ?disabled=${this.submitting}
              @click=${() => { this.submitAnswers(ask, { answers: [] }); }}>${askUserMessages.t("skip")}</button>
            ${this.confirmingPartialSubmit && unanswered.length > 0
              ? this.renderPartialSubmitConfirmation(ask, unanswered)
              : html`
                  <button class="ui-button ui-button--primary primary-action" type="submit" ?disabled=${this.submitting}>
                    ${askUserMessages.t(this.submitting ? "sending" : "send")}
                  </button>
                `}
          </footer>
        </form>
      </article>
    `;
  }

  private renderQuestion(ask: AskUserRequest, question: AskUserQuestion, index: number): TemplateResult {
    const answer = this.answers[question.id];
    const answered = answeredCount([question], this.answers) === 1;
    const detailId = question.detail === undefined ? undefined : this.questionDetailId(index);
    const freeTextOnly = question.options.length === 0;
    const customSelected = isCustomAnswerSelected(question, answer);
    const commentSelected = !customSelected && question.options.some((option) => answer?.values.includes(option.value) === true);
    const commentOpen = commentSelected && isCommentOpen(answer);
    const textInputId = customSelected ? this.otherInputId(index) : this.commentInputId(index);
    const inputType = question.multiple === true ? "checkbox" : "radio";
    return html`
      <fieldset
        id=${this.questionFieldsetId(index)}
        class=${`question${answered ? " answered" : ""}`}
        aria-describedby=${ifDefined(detailId)}
        tabindex="-1"
      >
        <legend>
          <span class="question-number">${askUserMessages.t("questionNumber", { number: index + 1 })}</span>
          <span dir="auto">${question.question}</span>
        </legend>
        ${question.detail === undefined ? null : html`<p class="question-detail" dir="auto" id=${detailId}>${question.detail}</p>`}
        <div class="options">
          ${question.options.map((option) => html`
            <label class="option">
              <input
                type=${inputType}
                name=${this.questionGroupName(ask, question)}
                value=${option.value}
                .checked=${answer?.values.includes(option.value) === true}
                @change=${(event: Event) => { this.changeOption(question, option.value, event); }}
              />
              <span class="option-copy">
                <span class="option-label" dir="auto">${option.label}</span>
                ${option.detail === undefined ? null : html`<span class="option-detail" dir="auto">${option.detail}</span>`}
              </span>
            </label>
          `)}
          ${freeTextOnly ? null : html`
            <label class="option other-option">
              <input
                type=${inputType}
                name=${this.questionGroupName(ask, question)}
                value="__pi_web_other__"
                .checked=${customSelected}
                @change=${(event: Event) => { this.changeOther(question, index, event); }}
              />
              <span class="option-copy"><span class="option-label">${askUserMessages.t("custom")}</span></span>
            </label>
          `}
          ${commentSelected && !commentOpen ? html`
            <button class="ui-button ui-button--small add-comment" type="button"
              @click=${() => { void this.addComment(question, index); }}>${askUserMessages.t("addComment")}</button>
          ` : null}
          ${customSelected || commentOpen ? html`
            <div class="answer-text">
              <div class="answer-text-header">
                <label for=${textInputId}>${askUserMessages.t(customSelected ? "customAnswer" : "comment")}</label>
                ${customSelected ? null : html`
                  <button class="ui-button ui-button--small ui-button--icon" type="button"
                    aria-label=${askUserMessages.t("closeComment")} title=${askUserMessages.t("closeCommentHint")}
                    @click=${() => { void this.closeComment(question, index); }}>×</button>
                `}
              </div>
              <textarea class="ui-input" dir="auto"
                id=${textInputId}
                rows=${customSelected ? "3" : "2"}
                maxlength=${String(customSelected ? ASK_USER_OTHER_TEXT_MAX_LENGTH : ASK_USER_COMMENT_MAX_LENGTH)}
                .value=${(customSelected ? answer?.otherText : answer?.comment) ?? ""}
                @input=${(event: Event) => {
                  if (customSelected) this.changeOtherText(question, event);
                  else this.changeComment(question, event);
                }}
              ></textarea>
            </div>
          ` : null}
        </div>
      </fieldset>
    `;
  }

  private renderPartialSubmitConfirmation(ask: AskUserRequest, unanswered: AskUserQuestion[]): TemplateResult {
    return html`
      <div class="partial-confirmation" role="group" aria-label=${askUserMessages.t("confirmPartial")}>
        <div class="partial-prompt">
          <p>${askUserMessages.t("partialPrompt")}</p>
          <ul>${unanswered.map((question) => html`<li><button
            class="question-jump"
            type="button"
            @click=${() => { this.focusQuestion(ask.questions.indexOf(question)); }}
            dir="auto"
          >${question.question}</button></li>`)}</ul>
        </div>
        <div class="confirmation-actions">
          <button class="ui-button ui-button--compact secondary-action" type="button" @click=${() => { this.keepEditing(ask, unanswered); }}>${askUserMessages.t("keepEditing")}</button>
          <button class="ui-button ui-button--primary primary-action send-anyway" type="button" ?disabled=${this.submitting} @click=${() => { this.submitAnswers(ask); }}>
            ${askUserMessages.t(this.submitting ? "sending" : "sendAnyway")}
          </button>
        </div>
      </div>
    `;
  }

  private renderClosedAsk(ask: AskUserRequest): TemplateResult {
    return html`
      <details class="ui-transcript-surface card closed-card">
        <summary class="ui-transcript-disclosure ui-transcript-card-header card-header"><h2>${askUserMessages.t("questions")}</h2><span class="ui-transcript-card-status header-status">${askUserMessages.t("closed", { total: ask.questions.length })}</span></summary>
        ${this.outcomes.map((outcome) => html`<p class="record-summary">${askUserOutcomeSummary(outcome)}</p>`)}
        <div class="record-questions">
          ${ask.questions.map((question, index) => html`
            <section class="record-question" aria-labelledby=${this.recordQuestionHeadingId(index)}>
              <h3 id=${this.recordQuestionHeadingId(index)}><span class="question-number">${askUserMessages.t("questionNumber", { number: index + 1 })}</span><span dir="auto">${question.question}</span></h3>
              ${question.detail === undefined ? null : html`<p class="question-detail" dir="auto">${question.detail}</p>`}
              ${this.renderOfferedOptions(question)}
              ${this.outcomes.length === 0
                ? this.renderRecordedAnswer(undefined, { question, answered: false, values: [] })
                : this.outcomes.map((outcome) => {
                    const record = outcome.questions.find((item) => item.question.id === question.id);
                    return record === undefined ? null : this.renderRecordedAnswer(outcome, record);
                  })}
            </section>
          `)}
        </div>
      </details>
    `;
  }

  private renderOfferedOptions(question: AskUserQuestion): TemplateResult {
    return html`${question.multiple === true ? html`<p class="question-detail">${askUserMessages.t("multiple")}</p>` : null}<ul class="offered-options">
      ${question.options.map((option) => html`<li><span dir="auto">${option.label}</span>${option.detail === undefined ? null : html`<p class="option-detail" dir="auto">${option.detail}</p>`}</li>`)}
      <li>${askUserMessages.t(question.options.length === 0 ? "customAnswer" : "custom")}</li>
    </ul>`;
  }

  private renderRecord(outcome: AskUserOutcome): TemplateResult {
    const recordLabel = outcome.reason === "submitted"
      ? askUserMessages.t(outcome.answeredCount === 0 ? "skipped" : "sent")
      : askUserMessages.t(outcome.reason === "superseded" ? "superseded" : "cancelled");
    return html`
      <article class="ui-transcript-surface card record-card" aria-labelledby="ask-user-record-heading">
        <header class="ui-transcript-card-header card-header">
          <h2 id="ask-user-record-heading">${askUserMessages.t(this.compact ? "answers" : "questions")}</h2>
          <span class=${`ui-transcript-card-status header-status ${outcome.reason} ${outcome.reason === "submitted" ? "ui-transcript-card-status--success" : outcome.reason === "superseded" ? "ui-transcript-card-status--warning" : ""}`}>${recordLabel}</span>
        </header>
        <p class="record-summary">
          ${outcome.reason === "superseded"
            ? askUserMessages.t("supersededSummary")
            : askUserOutcomeSummary(outcome)}
        </p>
        <div class="record-questions">
          ${outcome.questions.map((record, index) => this.renderQuestionRecord(outcome, record, index))}
        </div>
      </article>
    `;
  }

  private renderQuestionRecord(outcome: AskUserOutcome, record: AskUserQuestionRecord, index: number): TemplateResult {
    return html`
      <section class="record-question" aria-labelledby=${this.recordQuestionHeadingId(index)}>
        <h3 id=${this.recordQuestionHeadingId(index)}>
          <span class="question-number">${askUserMessages.t("questionNumber", { number: index + 1 })}</span>
          <span dir="auto">${record.question.question}</span>
        </h3>
        ${record.question.detail === undefined ? null : html`<p class="question-detail" dir="auto">${record.question.detail}</p>`}
        ${this.compact ? null : this.renderOfferedOptions(record.question)}
        ${this.renderRecordedAnswer(outcome, record)}
      </section>
    `;
  }

  private renderRecordedAnswer(outcome: AskUserOutcome | undefined, record: AskUserQuestionRecord): TemplateResult {
    const answer = this.displayedRecordAnswer(outcome, record);
    return html`
        ${answer === undefined
          ? html`<p class="unanswered-record">${askUserMessages.t("unanswered")}</p>`
          : html`
              <ul class="record-answers">
                ${answer.values.map((value) => html`<li><span dir="auto">${this.optionLabel(record.question, value)}</span></li>`)}
                ${answer.otherText === undefined ? null : html`<li class="other-record-text"><span dir="auto">${askUserMessages.t("customRecord", { answer: answer.otherText })}</span></li>`}
                ${answer.comment === undefined ? null : html`<li class="other-record-text"><span dir="auto">${askUserMessages.t("commentRecord", { comment: answer.comment })}</span></li>`}
              </ul>
              ${answer.fromDraft ? html`<p class="draft-note">${askUserMessages.t("draft")}</p>` : null}
            `}
    `;
  }

  private changeOption(question: AskUserQuestion, value: string, event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    if (question.multiple !== true) {
      if (input.checked) this.setAnswer(question, { values: [value], customSelected: false });
      return;
    }
    const current = this.answers[question.id];
    const values = input.checked
      ? [...new Set([...(current?.values ?? []), value])]
      : (current?.values ?? []).filter((selected) => selected !== value);
    this.setAnswer(question, { values });
  }

  private changeOther(question: AskUserQuestion, index: number, event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    if (question.multiple === true) {
      this.setAnswer(question, { customSelected: input.checked });
    } else if (input.checked) {
      this.setAnswer(question, { values: [], customSelected: true });
    }
    if (input.checked) void this.focusOtherInput(index);
  }

  private changeOtherText(question: AskUserQuestion, event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLTextAreaElement)) return;
    this.setAnswer(question, {
      otherText: input.value.slice(0, ASK_USER_OTHER_TEXT_MAX_LENGTH),
      customSelected: true,
    });
  }

  private async addComment(question: AskUserQuestion, index: number): Promise<void> {
    this.setAnswer(question, { commentOpen: true });
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>(`#${this.commentInputId(index)}`)?.focus();
  }

  private async closeComment(question: AskUserQuestion, index: number): Promise<void> {
    this.setAnswer(question, { commentOpen: false });
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>(`#${this.questionFieldsetId(index)} .add-comment`)?.focus();
  }

  /**
   * A comment is an addition to the answer, never a replacement for it, so it
   * leaves the question's selection and custom text exactly as they were.
   */
  private changeComment(question: AskUserQuestion, event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLTextAreaElement)) return;
    this.setAnswer(question, { comment: input.value.slice(0, ASK_USER_COMMENT_MAX_LENGTH), commentOpen: true });
  }

  private setAnswer(question: AskUserQuestion, patch: Partial<AskDraftAnswer>): void {
    // Keep editing buffers independent of which controls are active. Only
    // toSubmission decides what is sent; switching controls never erases text.
    const answer: AskDraftAnswer = { values: [], ...this.answers[question.id], ...patch };
    const next: AskDraftAnswers = { ...this.answers, [question.id]: answer };
    this.answers = next;
    this.confirmingPartialSubmit = false;
    if (this.ask !== undefined && this.draftSessionId !== "") saveAskDraft(this.draftSessionId, this.ask.askId, next);
  }

  private handleSubmit(event: SubmitEvent, ask: AskUserRequest): void {
    event.preventDefault();
    if (this.submitting) return;
    if (unansweredQuestions(ask.questions, this.answers).length > 0) {
      void this.showPartialSubmitConfirmation();
      return;
    }
    this.submitAnswers(ask);
  }

  private submitAnswers(ask: AskUserRequest, submission = toSubmission(ask.questions, this.answers)): void {
    if (this.submitting || !this.open) return;
    this.submitting = true;
    const callback = this.onSubmit;
    if (callback === undefined) {
      this.submitting = false;
      return;
    }
    const askId = ask.askId;
    void Promise.resolve()
      .then(() => callback(askId, submission))
      .catch(() => {
        // The parent controller owns the visible transport error. Keeping this
        // card and its draft intact is the only recovery needed at this boundary.
      })
      .finally(() => {
        if (this.ask?.askId === askId) this.submitting = false;
      });
  }

  private async showPartialSubmitConfirmation(): Promise<void> {
    this.confirmingPartialSubmit = true;
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>(".send-anyway")?.focus();
  }

  private keepEditing(ask: AskUserRequest, unanswered: AskUserQuestion[]): void {
    this.confirmingPartialSubmit = false;
    const first = unanswered[0];
    if (first !== undefined) this.focusQuestion(ask.questions.indexOf(first));
  }

  private focusQuestion(index: number): void {
    if (index < 0) return;
    void this.updateComplete.then(() => {
      const fieldset = this.renderRoot.querySelector<HTMLElement>(`#${this.questionFieldsetId(index)}`);
      const firstControl = fieldset?.querySelector<HTMLElement>("input, textarea");
      (firstControl ?? fieldset)?.focus();
    });
  }

  private async focusOtherInput(index: number): Promise<void> {
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>(`#${this.otherInputId(index)}`)?.focus();
  }

  private displayedRecordAnswer(outcome: AskUserOutcome | undefined, record: AskUserQuestionRecord): DisplayedRecordAnswer | undefined {
    if (record.answered) {
      return {
        values: [...record.values],
        ...(record.otherText === undefined ? {} : { otherText: record.otherText }),
        ...(record.comment === undefined ? {} : { comment: record.comment }),
        fromDraft: false,
      };
    }
    if (outcome !== undefined && outcome.reason !== "superseded") return undefined;
    const answer = toSubmission([record.question], this.answers).answers[0];
    if (answer === undefined) return undefined;
    return {
      values: [...answer.values],
      ...(answer.otherText === undefined ? {} : { otherText: answer.otherText }),
      ...(answer.comment === undefined ? {} : { comment: answer.comment }),
      fromDraft: true,
    };
  }

  private optionLabel(question: AskUserQuestion, value: string): string {
    return question.options.find((option) => option.value === value)?.label ?? value;
  }

  private currentModelIdentity(): string | undefined {
    if (this.outcome !== undefined) return `record:${this.draftSessionId}:${this.outcome.askId}`;
    if (this.ask !== undefined) return `request:${this.draftSessionId}:${this.ask.askId}`;
    return undefined;
  }

  private loadCurrentDraft(): AskDraftAnswers {
    const askId = this.outcome?.askId ?? this.ask?.askId;
    if (askId === undefined || this.draftSessionId === "") return {};
    return loadAskDraft(this.draftSessionId, askId);
  }

  private questionGroupName(ask: AskUserRequest, question: AskUserQuestion): string {
    return `ask-user:${ask.askId}:${question.id}`;
  }

  private questionFieldsetId(index: number): string {
    return `ask-user-question-${String(index)}`;
  }

  private questionDetailId(index: number): string {
    return `ask-user-question-detail-${String(index)}`;
  }

  private otherInputId(index: number): string {
    return `ask-user-other-${String(index)}`;
  }

  private commentInputId(index: number): string {
    return `ask-user-comment-${String(index)}`;
  }

  private recordQuestionHeadingId(index: number): string {
    return `ask-user-record-question-${String(index)}`;
  }

  static override styles = [uiButtonStyles, uiFormStyles, uiTranscriptStyles, uiTranscriptCardStyles, css`
    :host {
      display: block;
      box-sizing: border-box;
      width: 100%;
      margin: 0 0 14px;
      color: var(--pi-text);
      font: 14px var(--pi-font, system-ui, sans-serif);
      container-type: inline-size;
    }
    .card {
      --question-number-column: 25px;
      --question-copy-gap: 5px;
    }
    .card { --ui-transcript-card-header-padding: 7px 10px 6px; }
    h2, h3, p { margin-top: 0; }
    h2 {
      margin-bottom: 0;
      color: var(--pi-accent);
      font-size: 12px;
      line-height: 1.3;
      text-transform: uppercase;
    }
    .questions { display: grid; padding-top: 8px; }
    fieldset.question {
      min-width: 0;
      margin: 0;
      border: 0;
      border-top: 1px solid var(--pi-border-muted);
      padding: 0 16px 16px;
      background: transparent;
    }
    fieldset.question:first-child { border-top: 0; }
    fieldset.question:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -3px; }
    legend {
      box-sizing: border-box;
      width: 100%;
      display: grid;
      grid-template-columns: var(--question-number-column) minmax(0, 1fr);
      align-items: start;
      gap: var(--question-copy-gap);
      color: var(--pi-text);
      padding: 0;
      font-weight: 650;
      line-height: 1.35;
    }
    .question-number { justify-self: end; color: var(--pi-muted); }
    fieldset.question.answered .question-number { color: var(--pi-success); }
    .question-detail {
      margin: 4px 0 10px;
      color: var(--pi-muted);
      font-size: 12px;
      line-height: 1.4;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    fieldset.question > .question-detail, .record-question > .question-detail {
      padding-inline-start: calc(var(--question-number-column) + var(--question-copy-gap));
    }
    .options { display: grid; gap: 0; }
    legend + .options { margin-top: 10px; }
    .option {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: start;
      gap: 8px;
      box-sizing: border-box;
      width: 100%;
      min-height: 44px;
      padding: 10px 8px;
      cursor: pointer;
    }
    .option:hover { background: var(--pi-surface-hover); }
    .option:has(input:checked) { background: var(--pi-selection-bg); }
    .option:has(input:focus-visible) { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    input { margin: 2px 0 0; accent-color: var(--pi-accent); }
    input:focus-visible, .question-jump:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .option-copy { min-width: 0; display: grid; gap: 2px; }
    .option-label { line-height: 1.35; }
    .option-detail { color: var(--pi-muted); font-size: 12px; line-height: 1.35; white-space: pre-wrap; overflow-wrap: anywhere; }
    .add-comment { justify-self: start; margin-inline-start: 26px; }
    .answer-text { display: grid; gap: 5px; color: var(--pi-muted); font-size: 12px; padding-block: 4px; padding-inline: 32px 8px; }
    .answer-text:only-child { padding-inline: 0; }
    .answer-text-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    textarea { min-height: 52px; resize: vertical; }
    .form-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
      border-top: 1px solid var(--pi-border-muted);
      padding: 12px 16px;
    }
    .partial-confirmation { min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
    .partial-prompt { min-width: 0; color: var(--pi-warning); font-size: 12px; line-height: 1.4; }
    .partial-prompt p { margin: 0; }
    .partial-prompt ul { margin: 4px 0 0; padding-inline-start: 18px; }
    .partial-prompt li { overflow-wrap: anywhere; }
    .question-jump {
      display: inline;
      border: 0;
      border-radius: 3px;
      background: transparent;
      color: inherit;
      padding: 0;
      font: inherit;
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .confirmation-actions { display: flex; flex-wrap: wrap; align-items: stretch; justify-content: flex-end; gap: 0; }
    .card-header { flex-wrap: wrap; }
    .card-header h2, .header-status { overflow-wrap: anywhere; min-width: 0; }
    legend > span:last-child, .option-label, .record-question h3 > span:last-child { overflow-wrap: anywhere; }
    .closed-card > summary { cursor: pointer; position: static; }
    .offered-options { display: grid; gap: 5px; margin: 0 0 12px; padding-inline-start: 22px; color: var(--pi-muted); }
    .offered-options .option-detail { margin: 2px 0 0; }
    .record-summary { margin: 0; color: var(--pi-muted); padding: 12px 16px; font-size: 12px; }
    .record-questions { display: grid; }
    .record-question { min-width: 0; padding: 14px 16px; }
    .record-question + .record-question { border-top: 1px solid var(--pi-border-muted); }
    .record-question h3 { display: grid; grid-template-columns: var(--question-number-column) minmax(0, 1fr); align-items: start; gap: var(--question-copy-gap); margin-bottom: 8px; font-size: 14px; line-height: 1.35; }
    .record-answers { display: grid; gap: 4px; margin: 0; padding-inline-start: 22px; line-height: 1.4; }
    .record-answers li, .offered-options li { overflow-wrap: anywhere; }
    .other-record-text { white-space: pre-wrap; overflow-wrap: anywhere; }
    .unanswered-record { margin: 0; color: var(--pi-muted); font-style: italic; }
    .draft-note { margin: 7px 0 0; color: var(--pi-warning); font-size: 11px; }
    @container (max-width: 580px) {
      fieldset.question { padding: 0 12px 14px; }
      .record-question { padding: 14px 12px; }
      .record-summary { padding-inline: 12px; }
      .form-footer { align-items: stretch; flex-direction: column; padding: 12px; }
      .partial-confirmation { align-items: stretch; flex-direction: column; }
      .confirmation-actions { justify-content: flex-end; }
    }
  `];
}

declare global {
  interface HTMLElementTagNameMap {
    "ask-user-card": AskUserCard;
  }
}
