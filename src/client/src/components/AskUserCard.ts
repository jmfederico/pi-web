import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { uiButtonStyles } from "./ui/controlStyles";
import { uiTranscriptStyles } from "./ui/transcriptStyles";
import { uiTranscriptCardStyles } from "./ui/transcriptCardStyles";
import { uiFormStyles } from "./ui/formStyles";
import {
  ASK_USER_OTHER_TEXT_MAX_LENGTH,
  type AskUserOutcome,
  type AskUserQuestion,
  type AskUserQuestionRecord,
  type AskUserSubmission,
  type AskUserRequest,
} from "../../../shared/apiTypes";
import {
  answeredCount,
  loadAskDraft,
  saveAskDraft,
  toSubmission,
  unansweredQuestions,
  type AskDraftAnswer,
  type AskDraftAnswers,
} from "../askDrafts";

export type AskUserSubmitCallback = (askId: string, submission: AskUserSubmission) => void | Promise<void>;

interface DisplayedRecordAnswer {
  values: string[];
  otherText?: string;
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
          <h2 id="ask-user-heading">Questions</h2>
          <span class="ui-transcript-card-status header-status" role="status" aria-live="polite" aria-atomic="true">
            ${count} of ${ask.questions.length} answered
          </span>
        </header>
        <form class="ask-form" @submit=${(event: SubmitEvent) => { this.handleSubmit(event, ask); }}>
          <div class="questions">
            ${ask.questions.map((question, index) => this.renderQuestion(ask, question, index))}
          </div>
          <footer class="form-footer">
            <button class="ui-button ui-button--compact secondary-action skip-questions" type="button" ?disabled=${this.submitting}
              @click=${() => { this.submitAnswers(ask, { answers: [] }); }}>Skip questions</button>
            ${this.confirmingPartialSubmit && unanswered.length > 0
              ? this.renderPartialSubmitConfirmation(ask, unanswered)
              : html`
                  <button class="ui-button ui-button--primary primary-action" type="submit" ?disabled=${this.submitting}>
                    ${this.submitting ? "Sending…" : "Send answers"}
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
    const customSelected = freeTextOnly || this.isOtherSelected(question, answer);
    const inputType = question.multiple === true ? "checkbox" : "radio";
    return html`
      <fieldset
        id=${this.questionFieldsetId(index)}
        class=${`question${answered ? " answered" : ""}`}
        aria-describedby=${ifDefined(detailId)}
        tabindex="-1"
      >
        <legend>
          <span class="question-number">${String(index + 1)}.</span>
          <span>${question.question}</span>
        </legend>
        ${question.detail === undefined ? null : html`<p class="question-detail" id=${detailId}>${question.detail}</p>`}
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
                <span class="option-label">${option.label}</span>
                ${option.detail === undefined ? null : html`<span class="option-detail">${option.detail}</span>`}
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
              <span class="option-copy"><span class="option-label">Custom</span></span>
            </label>
          `}
          ${customSelected ? html`
            <label class="other-answer" for=${this.otherInputId(index)}>
              <span>Custom answer</span>
              <textarea class="ui-input"
                id=${this.otherInputId(index)}
                rows="3"
                maxlength=${String(ASK_USER_OTHER_TEXT_MAX_LENGTH)}
                .value=${answer?.otherText ?? ""}
                @input=${(event: Event) => { this.changeOtherText(question, event); }}
              ></textarea>
            </label>
          ` : null}
        </div>
      </fieldset>
    `;
  }

  private renderPartialSubmitConfirmation(ask: AskUserRequest, unanswered: AskUserQuestion[]): TemplateResult {
    return html`
      <div class="partial-confirmation" role="group" aria-label="Confirm partial answers">
        <p>
          <strong>Send without answering:</strong>
          ${unanswered.map((question, index) => html`${index === 0 ? " " : ", "}<button
            class="question-jump"
            type="button"
            @click=${() => { this.focusQuestion(ask.questions.indexOf(question)); }}
          >${question.question}</button>`)}?
        </p>
        <div class="confirmation-actions">
          <button class="ui-button ui-button--compact secondary-action" type="button" @click=${() => { this.keepEditing(ask, unanswered); }}>Keep editing</button>
          <button class="ui-button ui-button--primary primary-action send-anyway" type="button" ?disabled=${this.submitting} @click=${() => { this.submitAnswers(ask); }}>
            ${this.submitting ? "Sending…" : "Send anyway"}
          </button>
        </div>
      </div>
    `;
  }

  private renderClosedAsk(ask: AskUserRequest): TemplateResult {
    return html`
      <details class="ui-transcript-surface card closed-card">
        <summary class="ui-transcript-disclosure ui-transcript-card-header card-header"><h2>Questions</h2><span class="ui-transcript-card-status header-status">Closed · ${ask.questions.length} questions</span></summary>
        ${this.outcomes.map((outcome) => html`<p class="record-summary">${outcome.summary}</p>`)}
        <div class="record-questions">
          ${ask.questions.map((question, index) => html`
            <section class="record-question" aria-labelledby=${this.recordQuestionHeadingId(index)}>
              <h3 id=${this.recordQuestionHeadingId(index)}><span class="question-number">${String(index + 1)}.</span><span>${question.question}</span></h3>
              ${question.detail === undefined ? null : html`<p class="question-detail">${question.detail}</p>`}
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
    return html`${question.multiple === true ? html`<p class="question-detail">Multiple choices allowed</p>` : null}<ul class="offered-options">
      ${question.options.map((option) => html`<li><span>${option.label}</span>${option.detail === undefined ? null : html`<p class="option-detail">${option.detail}</p>`}</li>`)}
      <li>${question.options.length === 0 ? "Custom answer" : "Custom"}</li>
    </ul>`;
  }

  private renderRecord(outcome: AskUserOutcome): TemplateResult {
    const recordLabel = outcome.reason === "submitted"
      ? outcome.answeredCount === 0 ? "Questions skipped" : "Answers sent"
      : outcome.reason === "superseded"
        ? "Superseded"
        : "Cancelled";
    return html`
      <article class="ui-transcript-surface card record-card" aria-labelledby="ask-user-record-heading">
        <header class="ui-transcript-card-header card-header">
          <h2 id="ask-user-record-heading">${this.compact ? "Answers" : "Questions"}</h2>
          <span class=${`ui-transcript-card-status header-status ${outcome.reason} ${outcome.reason === "submitted" ? "ui-transcript-card-status--success" : outcome.reason === "superseded" ? "ui-transcript-card-status--warning" : ""}`}>${recordLabel}</span>
        </header>
        <p class="record-summary">
          ${outcome.reason === "superseded"
            ? "A newer question set replaced this one. Draft answers shown below were not sent to the model."
            : outcome.summary}
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
          <span class="question-number">${String(index + 1)}.</span>
          <span>${record.question.question}</span>
        </h3>
        ${record.question.detail === undefined ? null : html`<p class="question-detail">${record.question.detail}</p>`}
        ${this.compact ? null : this.renderOfferedOptions(record.question)}
        ${this.renderRecordedAnswer(outcome, record)}
      </section>
    `;
  }

  private renderRecordedAnswer(outcome: AskUserOutcome | undefined, record: AskUserQuestionRecord): TemplateResult {
    const answer = this.displayedRecordAnswer(outcome, record);
    return html`
        ${answer === undefined
          ? html`<p class="unanswered-record">Unanswered</p>`
          : html`
              <ul class="record-answers">
                ${answer.values.map((value) => html`<li>${this.optionLabel(record.question, value)}</li>`)}
                ${answer.otherText === undefined ? null : html`<li><strong>Custom:</strong> <span class="other-record-text">${answer.otherText}</span></li>`}
              </ul>
              ${answer.fromDraft ? html`<p class="draft-note">Draft answer · not sent</p>` : null}
            `}
    `;
  }

  private changeOption(question: AskUserQuestion, value: string, event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    if (question.multiple !== true) {
      if (input.checked) this.setAnswer(question, { values: [value] });
      return;
    }
    const current = this.answers[question.id];
    const values = input.checked
      ? [...new Set([...(current?.values ?? []), value])]
      : (current?.values ?? []).filter((selected) => selected !== value);
    this.setAnswer(question, {
      values,
      ...(current?.otherText === undefined ? {} : { otherText: current.otherText }),
    });
  }

  private changeOther(question: AskUserQuestion, index: number, event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    const current = this.answers[question.id];
    if (question.multiple === true) {
      this.setAnswer(question, {
        values: [...(current?.values ?? [])],
        ...(input.checked ? { otherText: current?.otherText ?? "" } : {}),
      });
    } else if (input.checked) {
      this.setAnswer(question, { values: [], otherText: this.isOtherSelected(question, current) ? current?.otherText ?? "" : "" });
    }
    if (input.checked) void this.focusOtherInput(index);
  }

  private changeOtherText(question: AskUserQuestion, event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLTextAreaElement)) return;
    const current = this.answers[question.id];
    this.setAnswer(question, {
      values: [...(current?.values ?? [])],
      otherText: input.value.slice(0, ASK_USER_OTHER_TEXT_MAX_LENGTH),
    });
  }

  private setAnswer(question: AskUserQuestion, answer: AskDraftAnswer): void {
    const next: AskDraftAnswers = answer.values.length === 0 && answer.otherText === undefined
      ? Object.fromEntries(Object.entries(this.answers).filter(([id]) => id !== question.id))
      : { ...this.answers, [question.id]: answer };
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

  private isOtherSelected(question: AskUserQuestion, answer: AskDraftAnswer | undefined): boolean {
    if (answer?.otherText === undefined) return false;
    return question.multiple === true || answer.values.length === 0;
  }

  private displayedRecordAnswer(outcome: AskUserOutcome | undefined, record: AskUserQuestionRecord): DisplayedRecordAnswer | undefined {
    if (record.answered) {
      return {
        values: [...record.values],
        ...(record.otherText === undefined ? {} : { otherText: record.otherText }),
        fromDraft: false,
      };
    }
    if (outcome !== undefined && outcome.reason !== "superseded") return undefined;
    const answer = toSubmission([record.question], this.answers).answers[0];
    if (answer === undefined) return undefined;
    return {
      values: [...answer.values],
      ...(answer.otherText === undefined ? {} : { otherText: answer.otherText }),
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
    .other-answer { display: grid; gap: 5px; color: var(--pi-muted); font-size: 12px; padding: 4px 8px 4px 32px; }
    .other-answer:only-child { padding-left: 0; padding-right: 0; }
    textarea { min-height: 68px; resize: vertical; }
    .form-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
      border-top: 1px solid var(--pi-border-muted);
      padding: 12px 16px;
    }
    .partial-confirmation { min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
    .partial-confirmation p { min-width: 0; margin: 0; color: var(--pi-warning); font-size: 12px; line-height: 1.4; }
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
    .confirmation-actions { flex: 0 0 auto; display: flex; align-items: stretch; gap: 0; }
    .closed-card > summary { cursor: pointer; position: static; }
    .offered-options { display: grid; gap: 5px; margin: 0 0 12px; padding-left: 22px; color: var(--pi-muted); }
    .offered-options .option-detail { margin: 2px 0 0; }
    .record-summary { margin: 0; color: var(--pi-muted); padding: 12px 16px; font-size: 12px; }
    .record-questions { display: grid; }
    .record-question { min-width: 0; padding: 14px 16px; }
    .record-question + .record-question { border-top: 1px solid var(--pi-border-muted); }
    .record-question h3 { display: grid; grid-template-columns: var(--question-number-column) minmax(0, 1fr); align-items: start; gap: var(--question-copy-gap); margin-bottom: 8px; font-size: 14px; line-height: 1.35; }
    .record-answers { display: grid; gap: 4px; margin: 0; padding-left: 22px; line-height: 1.4; }
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
