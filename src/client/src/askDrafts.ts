import {
  ASK_USER_COMMENT_MAX_LENGTH,
  ASK_USER_OTHER_TEXT_MAX_LENGTH,
  type AskUserAnswer,
  type AskUserQuestion,
  type AskUserSubmission,
} from "../../shared/apiTypes";

/**
 * What the user has entered for one question but has not submitted yet. Kept in
 * the browser because the daemon owns "there is an open ask" while the browser
 * owns "what I have typed so far".
 */
export interface AskDraftAnswer {
  values: string[];
  otherText?: string;
  /** Selection state is independent of the retained Custom text buffer. */
  customSelected?: boolean;
  /** Free text typed alongside the selection rather than instead of it. */
  comment?: string;
  /** Visibility is independent of the retained comment buffer. */
  commentOpen?: boolean;
}

/** Draft answers of one ask, keyed by question id. */
export type AskDraftAnswers = Record<string, AskDraftAnswer>;

export function isCustomAnswerSelected(question: AskUserQuestion, answer: AskDraftAnswer | undefined): boolean {
  if (question.options.length === 0) return true;
  return answer?.customSelected ?? (answer?.otherText !== undefined && (question.multiple === true || answer.values.length === 0));
}

export function isCommentOpen(answer: AskDraftAnswer | undefined): boolean {
  return answer?.commentOpen ?? (answer?.comment !== undefined);
}

const draftStoragePrefix = "pi-web:ask-draft:";

function draftStorageKey(sessionId: string, askId: string): string {
  return `${draftStoragePrefix}${sessionId}:${askId}`;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Read the stored draft. Any unreadable or malformed payload yields an empty
 * draft: a half-typed answer set is a convenience, never a reason to fail
 * rendering the questions.
 */
export function loadAskDraft(sessionId: string, askId: string, storage = browserStorage()): AskDraftAnswers {
  try {
    const stored = storage?.getItem(draftStorageKey(sessionId, askId));
    return stored === null || stored === undefined ? {} : draftAnswersFromJson(stored);
  } catch {
    return {};
  }
}

export function saveAskDraft(sessionId: string, askId: string, answers: AskDraftAnswers, storage = browserStorage()): void {
  try {
    const entries = Object.entries(answers).filter(
      ([, answer]) => answer.values.length > 0 || answer.otherText !== undefined || answer.comment !== undefined
        || answer.customSelected !== undefined || answer.commentOpen !== undefined,
    );
    if (entries.length === 0) storage?.removeItem(draftStorageKey(sessionId, askId));
    else storage?.setItem(draftStorageKey(sessionId, askId), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

export function clearAskDraft(sessionId: string, askId: string, storage = browserStorage()): void {
  try {
    storage?.removeItem(draftStorageKey(sessionId, askId));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

function draftAnswersFromJson(stored: string): AskDraftAnswers {
  const parsed: unknown = JSON.parse(stored);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const answers: AskDraftAnswers = {};
  for (const [id, value] of Object.entries(parsed)) {
    const answer = draftAnswerFromValue(value);
    if (answer !== undefined) answers[id] = answer;
  }
  return answers;
}

function draftAnswerFromValue(value: unknown): AskDraftAnswer | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record: Record<string, unknown> = { ...value };
  const values = record["values"];
  const otherText = record["otherText"];
  const comment = record["comment"];
  const customSelected = record["customSelected"];
  const commentOpen = record["commentOpen"];
  if (!Array.isArray(values) || !values.every((entry) => typeof entry === "string")) return undefined;
  if (otherText !== undefined && typeof otherText !== "string") return undefined;
  if (comment !== undefined && typeof comment !== "string") return undefined;
  if (customSelected !== undefined && typeof customSelected !== "boolean") return undefined;
  if (commentOpen !== undefined && typeof commentOpen !== "boolean") return undefined;
  return {
    values: [...values],
    ...(otherText === undefined ? {} : { otherText }),
    ...(comment === undefined ? {} : { comment }),
    ...(customSelected === undefined ? {} : { customSelected }),
    ...(commentOpen === undefined ? {} : { commentOpen }),
  };
}

/**
 * How many questions the draft currently answers. A question counts as answered
 * exactly when {@link toSubmission} would send an answer for it, so the progress
 * the user reads matches what the model is told.
 */
export function answeredCount(questions: readonly AskUserQuestion[], answers: AskDraftAnswers): number {
  return questions.filter((question) => submittableAnswer(question, answers[question.id]) !== undefined).length;
}

/** The questions left untouched, in the order they were asked. */
export function unansweredQuestions(questions: readonly AskUserQuestion[], answers: AskDraftAnswers): AskUserQuestion[] {
  return questions.filter((question) => submittableAnswer(question, answers[question.id]) === undefined);
}

/**
 * The submission for the current draft: one answer per answered question, and
 * nothing for the untouched ones, since an empty answer and an untouched
 * question mean the same thing to the daemon.
 */
export function toSubmission(questions: readonly AskUserQuestion[], answers: AskDraftAnswers): AskUserSubmission {
  const submitted: AskUserAnswer[] = [];
  for (const question of questions) {
    const answer = submittableAnswer(question, answers[question.id]);
    if (answer !== undefined) submitted.push(answer);
  }
  return { answers: submitted };
}

/**
 * Normalize one draft entry against the question it answers, or `undefined` when
 * it says nothing. The draft is browser-local storage that a previous version of
 * the app, another tab, or a user could have left in a shape the question no
 * longer accepts, so values the question does not offer are dropped and a
 * single-select question keeps only its first selection rather than sending a
 * submission the daemon would reject as a whole.
 *
 * A comment accompanies only offered selections while Custom is inactive. Hidden
 * draft comments never enter the submission or make a question answered.
 */
function submittableAnswer(question: AskUserQuestion, answer: AskDraftAnswer | undefined): AskUserAnswer | undefined {
  if (answer === undefined) return undefined;
  const offered = new Set(question.options.map((option) => option.value));
  const customSelected = isCustomAnswerSelected(question, answer);
  const values = question.multiple !== true && answer.customSelected === true
    ? []
    : [...new Set(answer.values)].filter((value) => offered.has(value));
  const otherText = customSelected ? normalizedOtherText(answer.otherText) : undefined;
  const comment = isCommentOpen(answer) && !customSelected && values.length > 0 ? normalizeComment(answer.comment) : undefined;
  const commented = (submittable: AskUserAnswer): AskUserAnswer => (comment === undefined ? submittable : { ...submittable, comment });
  if (question.multiple !== true && values.length + (otherText === undefined ? 0 : 1) > 1) {
    const single = values[0];
    if (single !== undefined) return commented({ id: question.id, values: [single] });
    return otherText === undefined ? undefined : commented({ id: question.id, values: [], otherText });
  }
  if (values.length === 0 && otherText === undefined) return undefined;
  return commented({ id: question.id, values, ...(otherText === undefined ? {} : { otherText }) });
}

function normalizedOtherText(otherText: string | undefined): string | undefined {
  if (otherText === undefined) return undefined;
  const trimmed = otherText.trim().slice(0, ASK_USER_OTHER_TEXT_MAX_LENGTH);
  return trimmed === "" ? undefined : trimmed;
}

function normalizeComment(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim().slice(0, ASK_USER_COMMENT_MAX_LENGTH);
  return trimmed === "" ? undefined : trimmed;
}
