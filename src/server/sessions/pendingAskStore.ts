import { randomUUID } from "node:crypto";
import {
  ASK_USER_ID_MAX_LENGTH,
  ASK_USER_OPTION_LIMIT,
  ASK_USER_OTHER_TEXT_MAX_LENGTH,
  ASK_USER_QUESTION_LIMIT,
  ASK_USER_TEXT_MAX_LENGTH,
  type AskUserAnswer,
  type AskUserCloseReason,
  type AskUserOutcome,
  type AskUserQuestion,
  type AskUserQuestionOption,
  type AskUserQuestionRecord,
  type AskUserSubmission,
  type PendingAskUser,
} from "../../shared/apiTypes.js";

export interface PendingAskStoreOptions {
  now?: (() => Date) | undefined;
  createAskId?: (() => string) | undefined;
}

/** A question set an agent wants to post to the user of one session. */
export interface PendingAskOpenInput {
  sessionId: string;
  questions: AskUserQuestion[];
}

/**
 * A freshly opened ask, plus the outcome of the ask it replaced. A session holds
 * at most one open ask, so opening while one is still unanswered supersedes it —
 * and the caller must report that outcome to the model, naming the questions the
 * user never got to answer.
 */
export interface PendingAskOpenResult {
  ask: PendingAskUser;
  superseded?: AskUserOutcome;
}

/**
 * Result of submitting or cancelling an ask. `"stale"` means the ask named by the
 * caller is no longer the session's open ask (already submitted, superseded, or
 * gone with its daemon-side session), which is an ordinary race a browser can
 * lose — not an error.
 */
export type PendingAskCloseResult =
  | { status: "closed"; outcome: AskUserOutcome }
  | { status: "stale" };

/** Rejected input: a question set is malformed, or an answer does not fit its question. */
export class PendingAskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingAskValidationError";
  }
}

type RecordedAnswers = ReadonlyMap<string, AskUserAnswer>;

/**
 * Daemon-owned open-ask state: one unanswered question set per session.
 *
 * The store is pure domain logic — no Fastify, no Pi session, no I/O, no timers.
 * It validates asks and answers, owns the open/supersede/submit/cancel
 * transitions, and computes the answered-versus-unanswered outcome that both the
 * model-facing message and the browser record are rendered from. Callers publish
 * the returned asks and outcomes; the store never emits anything itself.
 *
 * State is deliberately daemon-lifetime and in-memory. An open ask is meaningful
 * only while the session runtime that posted it exists, and browsers rehydrate it
 * from `SessionStatus` rather than from disk.
 */
export class PendingAskStore {
  private readonly now: () => Date;
  private readonly createAskId: () => string;
  private readonly openBySessionId = new Map<string, PendingAskUser>();

  constructor(options: PendingAskStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createAskId = options.createAskId ?? randomUUID;
  }

  /** The session's open ask, for {@link SessionStatus} projection. */
  pendingAsk(sessionId: string): PendingAskUser | undefined {
    const ask = this.openBySessionId.get(requireSessionId(sessionId));
    return ask === undefined ? undefined : cloneAsk(ask);
  }

  open(input: PendingAskOpenInput): PendingAskOpenResult {
    const sessionId = requireSessionId(input.sessionId);
    const questions = validateQuestions(input.questions);
    const askedAt = this.timestamp();
    const superseded = this.close(sessionId, "superseded", askedAt, new Map());
    const ask: PendingAskUser = {
      askId: requireId(this.createAskId(), "askId"),
      askedAt,
      questions,
    };
    this.openBySessionId.set(sessionId, ask);
    return {
      ask: cloneAsk(ask),
      ...(superseded === undefined ? {} : { superseded }),
    };
  }

  /**
   * Record what the user replied and close the ask. Answers are validated against
   * the open ask, so a submission that does not fit its questions is rejected
   * rather than silently truncated; the ask stays open in that case.
   */
  submit(sessionId: string, askId: string, submission: AskUserSubmission): PendingAskCloseResult {
    const ask = this.openBySessionId.get(requireSessionId(sessionId));
    if (ask?.askId !== askId) return { status: "stale" };
    // Validate before closing so a submission that does not fit its questions
    // leaves the ask open for the browser to correct.
    const answers = validateSubmission(ask, submission);
    return { status: "closed", outcome: this.requireClose(sessionId, "submitted", answers) };
  }

  /**
   * Close the session's open ask without a submission. The outcome reports every question as
   * unanswered, because answers only ever reach the daemon through a submit.
   */
  cancel(sessionId: string, askId: string): PendingAskCloseResult {
    const ask = this.openBySessionId.get(requireSessionId(sessionId));
    if (ask?.askId !== askId) return { status: "stale" };
    return { status: "closed", outcome: this.requireClose(sessionId, "cancelled", new Map()) };
  }

  /**
   * Close whatever ask the session currently has open, e.g. because the user sent
   * an ordinary chat message instead of answering the form. Returns the outcome,
   * or `undefined` when the session has no open ask.
   */
  cancelOpen(sessionId: string): AskUserOutcome | undefined {
    return this.close(requireSessionId(sessionId), "cancelled", this.timestamp(), new Map());
  }

  /** Drop the open ask of a session that is going away, without reporting an outcome. */
  forgetSession(sessionId: string): void {
    this.openBySessionId.delete(requireSessionId(sessionId));
  }

  private requireClose(sessionId: string, reason: AskUserCloseReason, answers: RecordedAnswers): AskUserOutcome {
    const outcome = this.close(sessionId, reason, this.timestamp(), answers);
    if (outcome === undefined) throw new Error(`Pending ask of session ${sessionId} disappeared while closing`);
    return outcome;
  }

  private close(
    sessionId: string,
    reason: AskUserCloseReason,
    closedAt: string,
    answers: RecordedAnswers,
  ): AskUserOutcome | undefined {
    const ask = this.openBySessionId.get(sessionId);
    if (ask === undefined) return undefined;
    this.openBySessionId.delete(sessionId);
    return askUserOutcome(ask, answers, reason, closedAt);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

/**
 * Model-facing text of a closed ask. The model reads this, so it must name the
 * unanswered questions as plainly as the answered ones.
 */
export function renderAskUserAnswersText(outcome: AskUserOutcome): string {
  const lead = outcome.reason === "submitted"
    ? "The user submitted answers to your questions."
    : `The question set was closed (${outcome.reason}) before it was fully answered.`;
  return [lead, "", ...outcome.questions.map(questionLines).flat(), "", outcome.summary].join("\n");
}

/**
 * Notice for the model when a new ask replaced one the user never answered, so a
 * supersede is never a silent loss of the earlier questions.
 */
export function renderSupersededAskText(outcome: AskUserOutcome): string {
  return [
    `This replaced an earlier question set (${outcome.askId}) that the user never submitted.`,
    `Left unanswered: ${outcome.unansweredIds.join(", ")}.`,
  ].join("\n");
}

function questionLines(record: AskUserQuestionRecord): string[] {
  const header = `- ${record.question.id}: ${record.question.question}`;
  if (!record.answered) return [header, "  Unanswered."];
  const parts = [...record.values.map((value) => `selected ${value}`)];
  if (record.otherText !== undefined) parts.push(`custom: ${JSON.stringify(record.otherText)}`);
  return [header, `  Answered: ${parts.join("; ")}`];
}

function askUserOutcome(
  ask: PendingAskUser,
  answers: RecordedAnswers,
  reason: AskUserCloseReason,
  closedAt: string,
): AskUserOutcome {
  const questions = ask.questions.map((question) => questionRecord(question, answers.get(question.id)));
  const unansweredIds = questions.filter((record) => !record.answered).map((record) => record.question.id);
  const answeredCount = questions.length - unansweredIds.length;
  return {
    askId: ask.askId,
    reason,
    askedAt: ask.askedAt,
    closedAt,
    questions,
    answeredCount,
    unansweredIds,
    summary: summaryLine(questions.length, answeredCount, unansweredIds),
  };
}

function questionRecord(question: AskUserQuestion, answer: AskUserAnswer | undefined): AskUserQuestionRecord {
  const values = answer?.values ?? [];
  const otherText = answer?.otherText;
  return {
    question: cloneQuestion(question),
    answered: values.length > 0 || otherText !== undefined,
    values: [...values],
    ...(otherText === undefined ? {} : { otherText }),
  };
}

function summaryLine(total: number, answeredCount: number, unansweredIds: string[]): string {
  const answered = `Answered ${answeredCount.toString()} of ${total.toString()}`;
  return unansweredIds.length === 0 ? `${answered}; none left unanswered` : `${answered}; unanswered: ${unansweredIds.join(", ")}`;
}

function validateQuestions(questions: AskUserQuestion[]): AskUserQuestion[] {
  if (questions.length === 0) throw new PendingAskValidationError("An ask must contain at least one question");
  if (questions.length > ASK_USER_QUESTION_LIMIT) {
    throw new PendingAskValidationError(`An ask must not contain more than ${ASK_USER_QUESTION_LIMIT.toString()} questions`);
  }
  const seenIds = new Set<string>();
  return questions.map((question) => {
    const id = requireId(question.id, "question id");
    if (seenIds.has(id)) throw new PendingAskValidationError(`Duplicate question id ${id}`);
    seenIds.add(id);
    return validateQuestion(question, id);
  });
}

function validateQuestion(question: AskUserQuestion, id: string): AskUserQuestion {
  if (question.options.length > ASK_USER_OPTION_LIMIT) {
    throw new PendingAskValidationError(`Question ${id} must not offer more than ${ASK_USER_OPTION_LIMIT.toString()} options`);
  }
  const seenValues = new Set<string>();
  const options = question.options.map((option) => {
    const value = requireId(option.value, `option value of question ${id}`);
    if (seenValues.has(value)) throw new PendingAskValidationError(`Duplicate option value ${value} in question ${id}`);
    seenValues.add(value);
    return validateOption(option, value, id);
  });
  const detail = question.detail;
  return {
    id,
    question: requireText(question.question, `text of question ${id}`),
    ...(detail === undefined ? {} : { detail: requireText(detail, `detail of question ${id}`) }),
    options,
    ...(question.multiple === true ? { multiple: true } : {}),
  };
}

function validateOption(option: AskUserQuestionOption, value: string, questionId: string): AskUserQuestionOption {
  const detail = option.detail;
  return {
    value,
    label: requireText(option.label, `label of option ${value} in question ${questionId}`),
    ...(detail === undefined ? {} : { detail: requireText(detail, `detail of option ${value} in question ${questionId}`) }),
  };
}

function validateSubmission(ask: PendingAskUser, submission: AskUserSubmission): Map<string, AskUserAnswer> {
  const questionsById = new Map(ask.questions.map((question) => [question.id, question]));
  const answers = new Map<string, AskUserAnswer>();
  for (const answer of submission.answers) {
    const question = questionsById.get(answer.id);
    if (question === undefined) throw new PendingAskValidationError(`Unknown question id ${answer.id}`);
    if (answers.has(answer.id)) throw new PendingAskValidationError(`Duplicate answer for question ${answer.id}`);
    const validated = validateAnswer(question, answer);
    // Untouched questions and explicitly empty answers are the same thing, so an
    // empty answer is dropped rather than recorded as answered.
    if (validated !== undefined) answers.set(answer.id, validated);
  }
  return answers;
}

function validateAnswer(question: AskUserQuestion, answer: AskUserAnswer): AskUserAnswer | undefined {
  const optionValues = new Set(question.options.map((option) => option.value));
  const values: string[] = [];
  for (const value of answer.values) {
    if (!optionValues.has(value)) throw new PendingAskValidationError(`Question ${question.id} has no option ${value}`);
    if (values.includes(value)) throw new PendingAskValidationError(`Duplicate value ${value} for question ${question.id}`);
    values.push(value);
  }
  const otherText = normalizeOtherText(question, answer.otherText);
  const selectionCount = values.length + (otherText === undefined ? 0 : 1);
  if (question.multiple !== true && selectionCount > 1) {
    throw new PendingAskValidationError(`Question ${question.id} accepts a single answer`);
  }
  if (selectionCount === 0) return undefined;
  return { id: question.id, values, ...(otherText === undefined ? {} : { otherText }) };
}

function normalizeOtherText(question: AskUserQuestion, otherText: string | undefined): string | undefined {
  if (otherText === undefined) return undefined;
  if (otherText.length > ASK_USER_OTHER_TEXT_MAX_LENGTH) {
    throw new PendingAskValidationError(`Other text of question ${question.id} exceeds its length limit`);
  }
  const trimmed = otherText.trim();
  return trimmed === "" ? undefined : trimmed;
}

function cloneAsk(ask: PendingAskUser): PendingAskUser {
  return { askId: ask.askId, askedAt: ask.askedAt, questions: ask.questions.map(cloneQuestion) };
}

function cloneQuestion(question: AskUserQuestion): AskUserQuestion {
  return { ...question, options: question.options.map((option) => ({ ...option })) };
}

function requireSessionId(sessionId: string): string {
  if (sessionId === "") throw new Error("sessionId must not be empty");
  return sessionId;
}

function requireId(value: string, field: string): string {
  if (value.trim() === "") throw new PendingAskValidationError(`${field} must not be empty`);
  if (value.length > ASK_USER_ID_MAX_LENGTH) throw new PendingAskValidationError(`${field} exceeds its length limit`);
  return value;
}

function requireText(value: string, field: string): string {
  if (value.trim() === "") throw new PendingAskValidationError(`${field} must not be empty`);
  if (value.length > ASK_USER_TEXT_MAX_LENGTH) throw new PendingAskValidationError(`${field} exceeds its length limit`);
  return value;
}
