import { randomUUID } from "node:crypto";
import {
  ASK_USER_COMMENT_MAX_LENGTH,
  ASK_USER_ID_MAX_LENGTH,
  ASK_USER_OPTION_LIMIT,
  ASK_USER_OTHER_TEXT_MAX_LENGTH,
  ASK_USER_QUESTION_LIMIT,
  ASK_USER_TEXT_MAX_LENGTH,
  type AskUserAnswer,
  type AskUserOutcome,
  type AskUserQuestion,
  type AskUserQuestionRecord,
  type AskUserRequest,
} from "../../shared/apiTypes.js";

export interface AskUserRequestOptions {
  now?: () => Date;
  createAskId?: () => string;
}

/** Invalid questions, durable request payload, or answers that do not fit it. */
export class AskUserValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskUserValidationError";
  }
}

/** Build the complete payload that a successful ask_user result persists. */
export function createAskUserRequest(questions: unknown, options: AskUserRequestOptions = {}): AskUserRequest {
  const validated = validateQuestions(questions);
  return {
    askId: requireId((options.createAskId ?? randomUUID)(), "askId"),
    askedAt: (options.now ?? (() => new Date()))().toISOString(),
    questions: validated,
  };
}

/**
 * Resolve only successful durable results on the selected branch. Tool calls,
 * failed results, and abandoned branches are not question entries. An answer
 * does not consume the request: later answers and skips remain ordinary replies.
 */
export function resolveAskUserRequest(branch: readonly unknown[], askId: string): AskUserRequest {
  requireId(askId, "askId");
  for (const entry of [...branch].reverse()) {
    if (!isRecord(entry) || entry["type"] !== "message") continue;
    const message = entry["message"];
    if (!isRecord(message) || message["role"] !== "toolResult" || message["toolName"] !== "ask_user" || message["isError"] !== false) continue;
    const details = message["details"];
    const ask = isRecord(details) ? details["ask"] : undefined;
    if (!isRecord(ask) || ask["askId"] !== askId) continue;
    try {
      return {
        askId: requireId(ask["askId"], "askId"),
        askedAt: requireTimestamp(ask["askedAt"]),
        questions: validateQuestions(ask["questions"]),
      };
    } catch (error: unknown) {
      if (!(error instanceof AskUserValidationError)) throw error;
      throw new AskUserValidationError(`Malformed ask_user request ${askId}: ${error.message}`);
    }
  }
  throw new AskUserValidationError(`Unknown ask ID ${askId} on the active session branch`);
}

/** A submission or skip is a new transcript outcome, never an open/close transition. */
export function createAskUserOutcome(ask: AskUserRequest, submission: unknown, closedAt: string): AskUserOutcome {
  const answers = submission === undefined ? new Map<string, AskUserAnswer>() : validateSubmission(ask, submission);
  const questions = ask.questions.map((question) => questionRecord(question, answers.get(question.id)));
  const unansweredIds = questions.filter((record) => !record.answered).map((record) => record.question.id);
  const answeredCount = questions.length - unansweredIds.length;
  const answered = `Answered ${answeredCount.toString()} of ${questions.length.toString()}`;
  return {
    askId: ask.askId,
    reason: submission === undefined ? "cancelled" : "submitted",
    askedAt: ask.askedAt,
    closedAt,
    questions,
    answeredCount,
    unansweredIds,
    summary: unansweredIds.length === 0 ? `${answered}; none left unanswered` : `${answered}; unanswered: ${unansweredIds.join(", ")}`,
  };
}

/** Model-facing text names unanswered questions as plainly as answered ones. */
export function renderAskUserAnswersText(outcome: AskUserOutcome): string {
  const lead = outcome.reason === "submitted"
    ? "The user submitted answers to your questions."
    : outcome.reason === "cancelled"
      ? "The user skipped these questions."
      : `The question set was closed (${outcome.reason}) before it was fully answered.`;
  return [lead, "", ...outcome.questions.flatMap(questionLines), "", outcome.summary].join("\n");
}

function questionLines(record: AskUserQuestionRecord): string[] {
  const header = `- ${record.question.id}: ${record.question.question}`;
  if (!record.answered) return [header, "  Unanswered."];
  const parts = record.values.map((value) => `selected ${value}`);
  if (record.otherText !== undefined) parts.push(`custom: ${JSON.stringify(record.otherText)}`);
  if (record.comment !== undefined) parts.push(`comment: ${JSON.stringify(record.comment)}`);
  return [header, `  Answered: ${parts.join("; ")}`];
}

function questionRecord(question: AskUserQuestion, answer: AskUserAnswer | undefined): AskUserQuestionRecord {
  const values = answer?.values ?? [];
  const otherText = answer?.otherText;
  const comment = answer?.comment;
  return {
    question: { ...question, options: question.options.map((option) => ({ ...option })) },
    answered: values.length > 0 || otherText !== undefined,
    values: [...values],
    ...(otherText === undefined ? {} : { otherText }),
    ...(comment === undefined ? {} : { comment }),
  };
}

function validateQuestions(input: unknown): AskUserQuestion[] {
  if (!Array.isArray(input)) throw new AskUserValidationError("Questions must be an array");
  if (input.length === 0) throw new AskUserValidationError("An ask must contain at least one question");
  if (input.length > ASK_USER_QUESTION_LIMIT) {
    throw new AskUserValidationError(`An ask must not contain more than ${ASK_USER_QUESTION_LIMIT.toString()} questions`);
  }
  const seenIds = new Set<string>();
  return input.map((question: unknown) => {
    if (!isRecord(question)) throw new AskUserValidationError("Each question must be an object");
    const id = requireId(question["id"], "question id");
    if (seenIds.has(id)) throw new AskUserValidationError(`Duplicate question id ${id}`);
    seenIds.add(id);
    const inputOptions = question["options"];
    if (!Array.isArray(inputOptions)) throw new AskUserValidationError(`Options of question ${id} must be an array`);
    if (inputOptions.length > ASK_USER_OPTION_LIMIT) {
      throw new AskUserValidationError(`Question ${id} must not offer more than ${ASK_USER_OPTION_LIMIT.toString()} options`);
    }
    const seenValues = new Set<string>();
    const options = inputOptions.map((option: unknown) => {
      if (!isRecord(option)) throw new AskUserValidationError(`Each option of question ${id} must be an object`);
      const value = requireId(option["value"], `option value of question ${id}`);
      if (seenValues.has(value)) throw new AskUserValidationError(`Duplicate option value ${value} in question ${id}`);
      seenValues.add(value);
      const detail = option["detail"];
      return {
        value,
        label: requireText(option["label"], `label of option ${value} in question ${id}`),
        ...(detail === undefined ? {} : { detail: requireText(detail, `detail of option ${value} in question ${id}`) }),
      };
    });
    const detail = question["detail"];
    const multiple = question["multiple"];
    if (multiple !== undefined && typeof multiple !== "boolean") {
      throw new AskUserValidationError(`multiple of question ${id} must be a boolean`);
    }
    return {
      id,
      question: requireText(question["question"], `text of question ${id}`),
      ...(detail === undefined ? {} : { detail: requireText(detail, `detail of question ${id}`) }),
      options,
      ...(multiple === true ? { multiple: true } : {}),
    };
  });
}

function validateSubmission(ask: AskUserRequest, submission: unknown): Map<string, AskUserAnswer> {
  if (!isRecord(submission) || !Array.isArray(submission["answers"])) throw new AskUserValidationError("Answers must be an array");
  const questionsById = new Map(ask.questions.map((question) => [question.id, question]));
  const answers = new Map<string, AskUserAnswer>();
  const seenIds = new Set<string>();
  const inputAnswers: unknown[] = submission["answers"];
  for (const answer of inputAnswers) {
    if (!isRecord(answer)) throw new AskUserValidationError("Each answer must be an object");
    const id = requireId(answer["id"], "answer id");
    const question = questionsById.get(id);
    if (question === undefined) throw new AskUserValidationError(`Unknown question id ${id}`);
    if (seenIds.has(id)) throw new AskUserValidationError(`Duplicate answer for question ${id}`);
    seenIds.add(id);
    const validated = validateAnswer(question, answer);
    // Explicitly empty and untouched answers both mean unanswered, but both
    // still count for duplicate-ID validation.
    if (validated !== undefined) answers.set(id, validated);
  }
  return answers;
}

function validateAnswer(question: AskUserQuestion, answer: Record<string, unknown>): AskUserAnswer | undefined {
  const inputValues = answer["values"];
  if (!Array.isArray(inputValues)) throw new AskUserValidationError(`Values of question ${question.id} must be an array`);
  const optionValues = new Set(question.options.map((option) => option.value));
  const values: string[] = [];
  const suppliedValues: unknown[] = inputValues;
  for (const value of suppliedValues) {
    if (typeof value !== "string" || !optionValues.has(value)) throw new AskUserValidationError(`Question ${question.id} has no option ${String(value)}`);
    if (values.includes(value)) throw new AskUserValidationError(`Duplicate value ${value} for question ${question.id}`);
    values.push(value);
  }
  const otherText = normalizeOtherText(question, answer["otherText"]);
  const comment = normalizeComment(question, answer["comment"]);
  const selectionCount = values.length + (otherText === undefined ? 0 : 1);
  if (question.multiple !== true && selectionCount > 1) throw new AskUserValidationError(`Question ${question.id} accepts a single answer`);
  // A comment accompanies an answer instead of being one, so it never makes an
  // otherwise untouched question count as answered.
  if (selectionCount === 0) return undefined;
  return {
    id: question.id,
    values,
    ...(otherText === undefined ? {} : { otherText }),
    ...(comment === undefined || answer["otherText"] !== undefined || values.length === 0 ? {} : { comment }),
  };
}

function normalizeComment(question: AskUserQuestion, comment: unknown): string | undefined {
  if (comment === undefined) return undefined;
  if (typeof comment !== "string") throw new AskUserValidationError(`Comment of question ${question.id} must be a string`);
  if (comment.length > ASK_USER_COMMENT_MAX_LENGTH) throw new AskUserValidationError(`Comment of question ${question.id} exceeds its length limit`);
  const trimmed = comment.trim();
  return trimmed === "" ? undefined : trimmed;
}

function normalizeOtherText(question: AskUserQuestion, otherText: unknown): string | undefined {
  if (otherText === undefined) return undefined;
  if (typeof otherText !== "string") throw new AskUserValidationError(`Other text of question ${question.id} must be a string`);
  if (otherText.length > ASK_USER_OTHER_TEXT_MAX_LENGTH) throw new AskUserValidationError(`Other text of question ${question.id} exceeds its length limit`);
  const trimmed = otherText.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string") throw new AskUserValidationError(`${field} must be a string`);
  if (value.trim() === "") throw new AskUserValidationError(`${field} must not be empty`);
  if (value.length > ASK_USER_ID_MAX_LENGTH) throw new AskUserValidationError(`${field} exceeds its length limit`);
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new AskUserValidationError(`${field} must be a string`);
  if (value.trim() === "") throw new AskUserValidationError(`${field} must not be empty`);
  if (value.length > ASK_USER_TEXT_MAX_LENGTH) throw new AskUserValidationError(`${field} exceeds its length limit`);
  return value;
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) {
    throw new AskUserValidationError("askedAt must be a valid timestamp");
  }
  return value;
}
