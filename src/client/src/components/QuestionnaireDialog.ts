import { LitElement, html, css, type TemplateResult, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { QuestionnaireQuestion, QuestionnaireAnswer, AskUserQuestionResult } from "../api";

interface DisplayOption {
  label: string;
  description: string;
  preview?: string;
  isCustom?: boolean;
  isChat?: boolean;
}

interface QuestionAnswerDraft {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "chat" | "multi";
  answer: string | null;
  selected?: string[];
}

@customElement("questionnaire-dialog")
export class QuestionnaireDialog extends LitElement {
  @property({ attribute: false }) questions: QuestionnaireQuestion[] = [];
  @property({ attribute: false }) onRespond?: (answers: AskUserQuestionResult) => void;
  @property({ attribute: false }) onDismiss?: () => void;

  @state() private currentTab = 0;
  @state() private answers = new Map<number, QuestionAnswerDraft>();
  @state() private customInput = "";
  @state() private showCustomInput = false;

  private get currentQuestion(): QuestionnaireQuestion | undefined {
    return this.questions[this.currentTab];
  }

  private get isMultiQuestion(): boolean {
    return this.questions.length > 1;
  }

  private get allAnswered(): boolean {
    return this.questions.every((_, i) => this.answers.has(i));
  }

  private get isSubmitTab(): boolean {
    return this.currentTab === this.questions.length;
  }

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("questions")) {
      this.currentTab = 0;
      this.answers = new Map();
      this.customInput = "";
      this.showCustomInput = false;
    }
  }

  private displayOptions(): DisplayOption[] {
    const q = this.currentQuestion;
    if (!q) return [];
    const opts: DisplayOption[] = q.options.map((o) => {
      const base: DisplayOption = { label: o.label, description: o.description };
      if (o.preview !== undefined) base.preview = o.preview;
      return base;
    });
    // Only show "Type something." for single-select questions without previews
    const hasMainPreview = q.options.some((o) => o.preview !== undefined && o.preview.length > 0);
    if (!q.multiSelect && !hasMainPreview) {
      opts.push({ label: "Type something.", description: "", isCustom: true });
    }
    // Always add "Chat about this"
    opts.push({ label: "Chat about this", description: "Abandon the questionnaire and continue in free-form conversation.", isChat: true });
    return opts;
  }

  private getAnswer(index: number): QuestionAnswerDraft | undefined {
    return this.answers.get(index);
  }

  private selectOption(option: DisplayOption): void {
    const q = this.currentQuestion;
    if (!q) return;

    if (option.isChat === true) {
      const answer: QuestionAnswerDraft = {
        questionIndex: this.currentTab,
        question: q.question,
        kind: "chat",
        answer: null,
      };
      this.answers.set(this.currentTab, answer);
      const result = this.buildResult();
      result.cancelled = true;
      this.onRespond?.(result);
      return;
    }

    if (option.isCustom === true) {
      this.showCustomInput = true;
      this.customInput = "";
      return;
    }

    if (q.multiSelect) {
      const existing = this.answers.get(this.currentTab);
      const selected = existing?.selected ? [...existing.selected] : [];
      const idx = selected.indexOf(option.label);
      if (idx >= 0) {
        selected.splice(idx, 1);
      } else {
        selected.push(option.label);
      }
      if (selected.length === 0) {
        this.answers.delete(this.currentTab);
      } else {
        this.answers.set(this.currentTab, {
          questionIndex: this.currentTab,
          question: q.question,
          kind: "multi",
          answer: null,
          selected,
        });
      }
      this.requestUpdate();
    } else {
      this.answers.set(this.currentTab, {
        questionIndex: this.currentTab,
        question: q.question,
        kind: "option",
        answer: option.label,
      });
      this.advanceTab();
    }
  }

  private submitCustomInput(): void {
    const q = this.currentQuestion;
    if (!q) return;
    const text = this.customInput.trim() || "(no input)";
    this.answers.set(this.currentTab, {
      questionIndex: this.currentTab,
      question: q.question,
      kind: "custom",
      answer: text,
    });
    this.showCustomInput = false;
    this.customInput = "";
    this.advanceTab();
  }

  private advanceTab(): void {
    if (this.currentTab < this.questions.length - 1) {
      this.currentTab++;
    } else if (this.questions.length > 0) {
      this.currentTab = this.questions.length;
    } else {
      this.submit();
    }
  }

  private submit(): void {
    this.onRespond?.(this.buildResult());
  }

  private cancel(): void {
    this.onRespond?.({ answers: [], cancelled: true });
  }

  private buildResult(): AskUserQuestionResult {
    const answers: QuestionnaireAnswer[] = [];
    for (const [index, draft] of this.answers) {
      const entry: QuestionnaireAnswer = {
        questionIndex: index,
        question: draft.question,
        kind: draft.kind,
        answer: draft.answer,
      };
      if (draft.selected) {
        entry.selected = draft.selected;
      }
      answers.push(entry);
    }
    return { answers, cancelled: false };
  }

  override render() {
    if (this.questions.length === 0) return html``;

    return html`
      <div class="backdrop" @click=${() => { this.cancel(); }}>
        <section class="dialog" @click=${(e: Event) => { e.stopPropagation(); }}>
          ${this.renderHeader()}
          ${this.isMultiQuestion ? this.renderTabBar() : null}
          ${this.showCustomInput ? this.renderCustomInput() : this.isSubmitTab ? this.renderSubmitTab() : this.renderQuestionTab()}
        </section>
      </div>
    `;
  }

  private renderHeader(): TemplateResult {
    return html`<header><strong>Questionnaire</strong><button @click=${() => { this.cancel(); }}>×</button></header>`;
  }

  private renderTabBar(): TemplateResult {
    return html`
      <nav class="tabs">
        ${this.questions.map((q, i) => {
          const answered = this.answers.has(i);
          const active = i === this.currentTab;
          return html`<button class="tab ${active ? "active" : ""} ${answered ? "answered" : ""}" @click=${() => { this.currentTab = i; }}>
            ${answered ? "■" : "□"} ${q.header}
          </button>`;
        })}
        <button class="tab ${this.isSubmitTab ? "active" : ""} ${this.allAnswered ? "ready" : ""}" @click=${() => { this.currentTab = this.questions.length; }}>
          ✓ Submit
        </button>
      </nav>
    `;
  }

  private renderQuestionTab(): TemplateResult {
    const q = this.currentQuestion;
    if (!q) return html``;

    const opts = this.displayOptions();
    const hasPreviewPane = q.options.some((o) => o.preview !== undefined && o.preview.length > 0);
    const currentAnswer = this.getAnswer(this.currentTab);
    const selectedLabels = currentAnswer?.kind === "multi" ? new Set(currentAnswer.selected) : new Set<string>();

    return html`
      <div class="body ${hasPreviewPane ? "with-preview" : ""}">
        <div class="question-panel">
          <div class="question-text">${q.question}</div>
          <div class="options">
            ${opts.map((opt) => {
              const isSelected = q.multiSelect
                ? selectedLabels.has(opt.label)
                : currentAnswer?.answer === opt.label;
              return html`
                <button class="option ${isSelected ? "selected" : ""} ${opt.isChat === true ? "chat" : ""} ${opt.isCustom === true ? "custom" : ""}"
                  @click=${() => { this.selectOption(opt); }}>
                  <span class="option-label">${q.multiSelect ? (isSelected ? "☑" : "☐") + " " : ""}${opt.label}</span>
                  ${opt.description ? html`<span class="option-desc">${opt.description}</span>` : null}
                </button>
              `;
            })}
          </div>
          <div class="help-text">
            ${q.multiSelect
              ? "Select one or more options • Click ✓ Submit when ready"
              : "Select an option, type your own, or chat about this"}
          </div>
        </div>
        ${hasPreviewPane ? this.renderPreview() : null}
      </div>
    `;
  }

  private renderPreview(): TemplateResult {
    const q = this.currentQuestion;
    if (!q) return html``;
    const optionWithPreview = q.options.find((o) => o.preview !== undefined && o.preview !== "");
    if (optionWithPreview?.preview === undefined || optionWithPreview.preview === "") return html``;
    return html`
      <div class="preview-panel">
        <div class="preview-content"><pre>${optionWithPreview.preview}</pre></div>
      </div>
    `;
  }

  private renderCustomInput(): TemplateResult {
    return html`
      <div class="body">
        <div class="question-text">Your answer:</div>
        <textarea
          class="custom-input"
          .value=${this.customInput}
          @input=${(e: Event) => { 
            const target = e.target;
            if (target instanceof HTMLTextAreaElement) this.customInput = target.value;
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              this.submitCustomInput();
            }
            if (e.key === "Escape") {
              this.showCustomInput = false;
              this.customInput = "";
            }
          }}
          placeholder="Type your answer..."
          rows="3"
        ></textarea>
        <div class="help-text">Enter to submit • Esc to go back</div>
      </div>
    `;
  }

  private renderSubmitTab(): TemplateResult {
    return html`
      <div class="body">
        <div class="submit-summary">
          <div class="question-text">Ready to submit</div>
          ${this.questions.map((q, i) => {
            const a = this.answers.get(i);
            const summary = a
              ? a.kind === "custom" ? `(wrote) ${a.answer ?? ""}`
              : a.kind === "multi" ? (a.selected ?? []).join(", ")
              : a.kind === "chat" ? "Chat about this"
              : a.answer ?? ""
              : "Not answered";
            return html`<div class="summary-row"><strong>${q.header}:</strong> ${summary}</div>`;
          })}
        </div>
        <div class="submit-actions">
          <button class="submit-btn" ?disabled=${!this.allAnswered} @click=${() => { this.submit(); }}>✓ Submit</button>
          <button class="cancel-btn" @click=${() => { this.cancel(); }}>Cancel</button>
        </div>
      </div>
    `;
  }

  static override styles = css`
    .backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .dialog {
      background: var(--bg-primary, #1e1e2e);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      max-width: 720px;
      width: 90%;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
    }
    header strong {
      font-size: 14px;
      color: var(--text-primary, #cdd6f4);
    }
    header button {
      background: none;
      border: none;
      color: var(--text-muted, #6c7086);
      font-size: 18px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
    }
    header button:hover {
      background: var(--bg-hover, rgba(255, 255, 255, 0.05));
      color: var(--text-primary, #cdd6f4);
    }
    .tabs {
      display: flex;
      gap: 4px;
      padding: 8px 16px;
      overflow-x: auto;
      border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
    }
    .tab {
      background: none;
      border: none;
      color: var(--text-muted, #6c7086);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
    }
    .tab.active {
      background: var(--accent, #89b4fa);
      color: var(--bg-primary, #1e1e2e);
    }
    .tab.answered {
      color: var(--success, #a6e3a1);
    }
    .tab.ready {
      color: var(--success, #a6e3a1);
    }
    .body {
      display: flex;
      overflow: hidden;
      flex: 1;
    }
    .body.with-preview {
      display: grid;
      grid-template-columns: 1fr 1fr;
    }
    .question-panel, .preview-panel {
      padding: 16px;
      overflow-y: auto;
    }
    .preview-panel {
      border-left: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
    }
    .preview-content {
      font-size: 13px;
      color: var(--text-primary, #cdd6f4);
    }
    .preview-content pre {
      margin: 0;
      white-space: pre-wrap;
      font-family: var(--monospace, 'Cascadia Code', 'Fira Code', monospace);
      background: var(--bg-secondary, #181825);
      padding: 12px;
      border-radius: 6px;
      font-size: 12px;
    }
    .question-text {
      font-size: 14px;
      color: var(--text-primary, #cdd6f4);
      margin-bottom: 12px;
      line-height: 1.4;
    }
    .options {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .option {
      display: flex;
      flex-direction: column;
      gap: 2px;
      background: var(--bg-secondary, #181825);
      border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
      border-radius: 8px;
      padding: 10px 12px;
      cursor: pointer;
      text-align: left;
      transition: border-color 0.15s;
    }
    .option:hover {
      border-color: var(--accent, #89b4fa);
    }
    .option.selected {
      border-color: var(--accent, #89b4fa);
      background: rgba(137, 180, 250, 0.08);
    }
    .option.chat {
      border-style: dashed;
      border-color: var(--border-color, rgba(255, 255, 255, 0.05));
    }
    .option-label {
      font-size: 13px;
      color: var(--text-primary, #cdd6f4);
    }
    .option-desc {
      font-size: 12px;
      color: var(--text-muted, #6c7086);
      line-height: 1.3;
    }
    .help-text {
      margin-top: 12px;
      font-size: 12px;
      color: var(--text-muted, #585b70);
    }
    .custom-input {
      width: 100%;
      box-sizing: border-box;
      background: var(--bg-secondary, #181825);
      border: 1px solid var(--accent, #89b4fa);
      border-radius: 8px;
      padding: 10px 12px;
      color: var(--text-primary, #cdd6f4);
      font-family: inherit;
      font-size: 13px;
      resize: vertical;
    }
    .custom-input:focus {
      outline: none;
      border-color: var(--accent, #89b4fa);
    }
    .submit-summary {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .summary-row {
      font-size: 13px;
      color: var(--text-primary, #cdd6f4);
    }
    .summary-row strong {
      color: var(--text-muted, #6c7086);
    }
    .submit-actions {
      display: flex;
      gap: 8px;
      margin-top: 16px;
      justify-content: flex-end;
    }
    .submit-btn {
      background: var(--accent, #89b4fa);
      color: var(--bg-primary, #1e1e2e);
      border: none;
      padding: 8px 20px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .submit-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .cancel-btn {
      background: none;
      border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
      color: var(--text-muted, #6c7086);
      padding: 8px 20px;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
    }
    .cancel-btn:hover {
      background: var(--bg-hover, rgba(255, 255, 255, 0.05));
    }
  `;
}