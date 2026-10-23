import { describe, expect, it } from "vitest";
import {
  ASK_USER_COMMENT_MAX_LENGTH, ASK_USER_ID_MAX_LENGTH, ASK_USER_OPTION_LIMIT, ASK_USER_OTHER_TEXT_MAX_LENGTH, ASK_USER_QUESTION_LIMIT, ASK_USER_TEXT_MAX_LENGTH,
  type AskUserQuestion,
} from "../../shared/apiTypes.js";
import { AskUserValidationError, createAskUserOutcome, createAskUserRequest, renderAskUserAnswersText, resolveAskUserRequest } from "./askUserDomain.js";

const askedAt = "2026-01-01T00:00:00.000Z";
const closedAt = "2026-01-01T00:01:00.000Z";

function question(id: string, overrides: Partial<AskUserQuestion> = {}): AskUserQuestion {
  return { id, question: `Question ${id}?`, options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }], ...overrides };
}

function request(questions: AskUserQuestion[] = [question("q1"), question("q2")]) {
  return createAskUserRequest(questions, { createAskId: () => "ask-1", now: () => new Date(askedAt) });
}

function resultEntry(ask: unknown, patch: Record<string, unknown> = {}) {
  return { type: "message", message: { role: "toolResult", toolName: "ask_user", isError: false, details: { ask }, ...patch } };
}

describe("durable ask validation", () => {
  it("normalizes a complete request without retaining caller-owned objects", () => {
    const questions = [question("q1", { detail: "Which one?", multiple: false, options: [{ value: "pg", label: "Postgres", detail: "Existing cluster" }] })];
    const ask = request(questions);
    expect(ask).toEqual({ askId: "ask-1", askedAt, questions: [{
      id: "q1", question: "Question q1?", detail: "Which one?", options: [{ value: "pg", label: "Postgres", detail: "Existing cluster" }],
    }] });
    questions[0]?.options.push({ value: "sqlite", label: "SQLite" });
    expect(ask.questions[0]?.options).toHaveLength(1);
  });

  it.each([
    { questions: [], error: "at least one question" },
    { questions: Array.from({ length: ASK_USER_QUESTION_LIMIT + 1 }, (_, index) => question(`q${index.toString()}`)), error: "more than 20 questions" },
    { questions: [question("q1"), question("q1")], error: "Duplicate question id q1" },
    { questions: [question(" ")], error: "question id must not be empty" },
    { questions: [question("x".repeat(ASK_USER_ID_MAX_LENGTH + 1))], error: "question id exceeds its length limit" },
    { questions: [question("q1", { question: " " })], error: "text of question q1 must not be empty" },
    { questions: [question("q1", { detail: "x".repeat(ASK_USER_TEXT_MAX_LENGTH + 1) })], error: "detail of question q1 exceeds its length limit" },
    { questions: [question("q1", { options: [{ value: "a", label: "A" }, { value: "a", label: "Again" }] })], error: "Duplicate option value a" },
    { questions: [question("q1", { options: [{ value: "a", label: " " }] })], error: "label of option a in question q1 must not be empty" },
    { questions: [question("q1", { options: Array.from({ length: ASK_USER_OPTION_LIMIT + 1 }, (_, index) => ({ value: `v${index.toString()}`, label: "L" })) })], error: "more than 12 options" },
  ])("rejects malformed question sets: $error", ({ questions, error }) => {
    expect(() => request(questions)).toThrow(error);
  });

  it("accepts optionless questions", () => {
    expect(request([question("q1", { options: [] })]).questions[0]?.options).toEqual([]);
  });
});

describe("durable branch request resolution", () => {
  it("resolves full successful result payloads, even before later replies and requests", () => {
    const ask = request();
    const laterAsk = { ...request([question("later")]), askId: "ask-2" };
    const branch = [resultEntry(ask), { type: "custom_message", details: { askId: ask.askId } }, resultEntry(laterAsk)];
    expect(resolveAskUserRequest(branch, ask.askId)).toEqual(ask);
    expect(resolveAskUserRequest(branch, laterAsk.askId)).toEqual(laterAsk);
  });

  it.each([
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "ask_user", arguments: { questions: [question("q1")] } }], details: { ask: request() } } },
    resultEntry(request(), { isError: true }),
    resultEntry(request(), { isError: undefined }),
    resultEntry(request(), { toolName: "other" }),
    resultEntry(request(), { details: {} }),
  ])("does not treat raw calls or unsuccessful results as durable requests", (entry) => {
    expect(() => resolveAskUserRequest([entry], "ask-1")).toThrow("Unknown ask ID ask-1 on the active session branch");
  });

  it.each([
    { ...request(), askedAt: "invalid" },
    { ...request(), askedAt: null },
    { ...request(), questions: null },
    { ...request(), questions: [null] },
    { ...request(), questions: [{ id: "q1", question: "Missing options?" }] },
    { ...request(), questions: [question("q1", { options: [] }), { id: "q2", question: "Invalid option?", options: [null] }] },
    { ...request(), questions: [{ ...question("q1"), multiple: "yes" }] },
    { ...request(), questions: [{ ...question("q1"), detail: 42 }] },
  ])("rejects malformed matching durable payloads clearly", (ask) => {
    expect(() => resolveAskUserRequest([resultEntry(ask)], "ask-1")).toThrow(/^Malformed ask_user request ask-1:/);
  });

  it("rejects IDs absent from the supplied active branch", () => {
    expect(() => resolveAskUserRequest([], "ask-abandoned")).toThrow(AskUserValidationError);
  });
});

describe("ask outcomes", () => {
  it("reports partial answers in question order, preserving their full payload", () => {
    const ask = request([question("q1"), question("q2"), question("q3")]);
    expect(createAskUserOutcome(ask, { answers: [{ id: "q2", values: ["no"] }] }, closedAt)).toEqual({
      askId: "ask-1", reason: "submitted", askedAt, closedAt,
      questions: [
        { question: ask.questions[0], answered: false, values: [] },
        { question: ask.questions[1], answered: true, values: ["no"] },
        { question: ask.questions[2], answered: false, values: [] },
      ],
      answeredCount: 1, unansweredIds: ["q1", "q3"], summary: "Answered 1 of 3; unanswered: q1, q3",
    });
  });

  it("summarizes fully answered requests", () => {
    expect(createAskUserOutcome(request(), { answers: [{ id: "q1", values: ["yes"] }, { id: "q2", values: ["no"] }] }, closedAt))
      .toMatchObject({ answeredCount: 2, unansweredIds: [], summary: "Answered 2 of 2; none left unanswered" });
  });

  it("treats empty and blank custom answers as unanswered", () => {
    expect(createAskUserOutcome(request(), { answers: [{ id: "q1", values: [] }, { id: "q2", values: [], otherText: "   " }] }, closedAt))
      .toMatchObject({ answeredCount: 0, unansweredIds: ["q1", "q2"] });
  });

  it("allows multi-select and custom text together", () => {
    expect(createAskUserOutcome(request([question("q1", { multiple: true })]), {
      answers: [{ id: "q1", values: ["yes", "no"], otherText: "  maybe later  " }],
    }, closedAt)).toMatchObject({ questions: [{ answered: true, values: ["yes", "no"], otherText: "maybe later" }], answeredCount: 1 });
  });

  it("keeps a trimmed comment beside the answer without making it one", () => {
    const outcome = createAskUserOutcome(request([question("q1"), question("q2")]), {
      answers: [{ id: "q1", values: ["yes"], comment: "  only while the rollout is staged  " }, { id: "q2", values: [], comment: "just thinking out loud" }],
    }, closedAt);
    expect(outcome.questions[0]).toMatchObject({ answered: true, values: ["yes"], comment: "only while the rollout is staged" });
    // A comment on its own never counts as an answer, so q2 stays unanswered.
    expect(outcome.questions[1]).toMatchObject({ answered: false, values: [] });
    expect(outcome.questions[1]).not.toHaveProperty("comment");
    expect(outcome).toMatchObject({ answeredCount: 1, unansweredIds: ["q2"] });
  });

  it.each([
    { multiple: false, values: [], otherText: "custom" },
    { multiple: true, values: ["yes", "no"], otherText: "custom" },
    { multiple: true, values: ["yes"], otherText: "" },
    { multiple: true, values: ["yes"], otherText: "   " },
  ])("drops hidden comments when custom text is supplied: %j", ({ multiple, values, otherText }) => {
    const outcome = createAskUserOutcome(request([question("q1", { multiple })]), {
      answers: [{ id: "q1", values, otherText, comment: "hidden comment" }],
    }, closedAt);

    expect(outcome.questions[0]).toEqual({
      question: question("q1", multiple ? { multiple: true } : {}),
      answered: true, values,
      ...(otherText.trim() === "" ? {} : { otherText }),
    });
    expect(renderAskUserAnswersText(outcome)).not.toContain("hidden comment");
  });

  it.each([undefined, "a note", "   "])("drops comments on optionless questions (%j)", (otherText) => {
    const outcome = createAskUserOutcome(request([question("q1", { options: [] })]), {
      answers: [{ id: "q1", values: [], otherText, comment: "hidden comment" }],
    }, closedAt);

    expect(outcome.questions[0]).toMatchObject({ answered: otherText === "a note", values: [] });
    expect(outcome.questions[0]).not.toHaveProperty("comment");
  });

  it.each([
    { values: [], otherText: "custom" },
    { values: [] },
    { values: ["yes"], otherText: "" },
  ])("still validates hidden comments: %j", (answer) => {
    const ask = request();
    for (const comment of [3, "x".repeat(ASK_USER_COMMENT_MAX_LENGTH + 1)]) {
      expect(() => createAskUserOutcome(ask, {
        answers: [{ id: "q1", ...answer, comment }],
      }, closedAt)).toThrow(AskUserValidationError);
    }
  });

  it("answers optionless questions with custom text", () => {
    expect(createAskUserOutcome(request([question("q1", { options: [] })]), { answers: [{ id: "q1", values: [], otherText: "a note" }] }, closedAt))
      .toMatchObject({ questions: [{ answered: true, values: [], otherText: "a note" }] });
  });

  it.each([
    { answers: [{ id: "q9", values: ["yes"] }], error: "Unknown question id q9" },
    { answers: [{ id: "q1", values: ["yes"] }, { id: "q1", values: ["no"] }], error: "Duplicate answer for question q1" },
    { answers: [{ id: "q1", values: [] }, { id: "q1", values: ["no"] }], error: "Duplicate answer for question q1" },
    { answers: [{ id: "q1", values: ["nope"] }], error: "Question q1 has no option nope" },
    { answers: [{ id: "q1", values: ["yes", "yes"] }], error: "Duplicate value yes" },
    { answers: [{ id: "q1", values: ["yes", "no"] }], error: "accepts a single answer" },
    { answers: [{ id: "q1", values: ["yes"], otherText: "also this" }], error: "accepts a single answer" },
    { answers: [{ id: "q1", values: [], otherText: "x".repeat(ASK_USER_OTHER_TEXT_MAX_LENGTH + 1) }], error: "exceeds its length limit" },
    { answers: [{ id: "q1", values: ["yes"], comment: "x".repeat(ASK_USER_COMMENT_MAX_LENGTH + 1) }], error: "Comment of question q1 exceeds its length limit" },
    { answers: [{ id: "q1", values: ["yes"], comment: 3 }], error: "Comment of question q1 must be a string" },
  ])("rejects submissions that do not fit the durable payload: $error", ({ answers, error }) => {
    expect(() => createAskUserOutcome(request(), { answers }, closedAt)).toThrow(error);
  });

  it.each([null, {}, { answers: [null] }, { answers: [{ id: "q1", values: null }] }, { answers: [{ id: "q1", values: [], otherText: 3 }] }])(
    "rejects malformed submissions at an untyped boundary", (submission) => {
      expect(() => createAskUserOutcome(request(), submission, closedAt)).toThrow(AskUserValidationError);
    },
  );

  it("makes skips wholly unanswered without mutating the request", () => {
    const ask = request();
    expect(createAskUserOutcome(ask, undefined, closedAt)).toMatchObject({ reason: "cancelled", answeredCount: 0, unansweredIds: ["q1", "q2"] });
    expect(ask).toEqual(request());
  });
});

describe("outcome rendering", () => {
  it("names answered and unanswered questions in model-facing text", () => {
    const outcome = createAskUserOutcome(request([question("q1"), question("q2"), question("q3")]), {
      answers: [{ id: "q1", values: ["yes"] }, { id: "q2", values: [], otherText: "something else" }],
    }, closedAt);
    expect(renderAskUserAnswersText(outcome)).toBe([
      "The user submitted answers to your questions.", "", "- q1: Question q1?", "  Answered: selected yes",
      "- q2: Question q2?", '  Answered: custom: "something else"', "- q3: Question q3?", "  Unanswered.", "",
      "Answered 2 of 3; unanswered: q3",
    ].join("\n"));
  });

  it("describes a cancelled outcome as a human skip", () => {
    expect(renderAskUserAnswersText(createAskUserOutcome(request(), undefined, closedAt))).toContain("The user skipped these questions.");
  });

  it("includes an accompanying comment in the model-facing text", () => {
    const outcome = createAskUserOutcome(request([question("q1")]), {
      answers: [{ id: "q1", values: ["yes"], comment: "only for the staging cluster" }],
    }, closedAt);
    expect(renderAskUserAnswersText(outcome)).toContain('Answered: selected yes; comment: "only for the staging cluster"');
  });
});
