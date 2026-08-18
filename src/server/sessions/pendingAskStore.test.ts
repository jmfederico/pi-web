import { describe, expect, it } from "vitest";
import { ASK_USER_OPTION_LIMIT, ASK_USER_QUESTION_LIMIT, type AskUserQuestion } from "../../shared/apiTypes.js";
import {
  PendingAskStore,
  PendingAskValidationError,
  renderAskUserAnswersText,
  renderSupersededAskText,
} from "./pendingAskStore.js";

const sessionId = "session-1";

function testStore() {
  let askCount = 0;
  let tick = 0;
  return new PendingAskStore({
    createAskId: () => `ask-${(++askCount).toString()}`,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
}

function question(id: string, overrides: Partial<AskUserQuestion> = {}): AskUserQuestion {
  return {
    id,
    question: `Question ${id}?`,
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
    ...overrides,
  };
}

function openTwoQuestions(store: PendingAskStore) {
  return store.open({ sessionId, questions: [question("q1"), question("q2")] });
}

describe("PendingAskStore validation", () => {
  it("normalizes an accepted ask and reports it as the session's pending ask", () => {
    const store = testStore();
    const result = store.open({
      sessionId,
      questions: [
        {
          id: "q1",
          question: "Which database?",
          detail: "Only the primary store matters here.",
          options: [{ value: "pg", label: "Postgres", detail: "Existing cluster" }],
          multiple: false,
        },
      ],
    });

    expect(result.ask).toEqual({
      askId: "ask-1",
      askedAt: "2026-01-01T00:00:00.000Z",
      questions: [
        {
          id: "q1",
          question: "Which database?",
          detail: "Only the primary store matters here.",
          options: [{ value: "pg", label: "Postgres", detail: "Existing cluster" }],
        },
      ],
    });
    expect(result.superseded).toBeUndefined();
    expect(store.pendingAsk(sessionId)).toEqual(result.ask);
    expect(store.pendingAsk("other-session")).toBeUndefined();
  });

  it("rejects asks the user could not meaningfully answer", () => {
    const store = testStore();
    const reject = (questions: AskUserQuestion[]) => () => store.open({ sessionId, questions });

    expect(reject([])).toThrow(PendingAskValidationError);
    expect(reject(Array.from({ length: ASK_USER_QUESTION_LIMIT + 1 }, (_, index) => question(`q${index.toString()}`))))
      .toThrow(/more than 20 questions/);
    expect(reject([question("q1"), question("q1")])).toThrow(/Duplicate question id q1/);
    expect(reject([question(" ")])).toThrow(/question id must not be empty/);
    expect(reject([question("q1", { question: "  " })])).toThrow(/text of question q1 must not be empty/);
    expect(reject([question("q1", { options: [{ value: "a", label: "A" }, { value: "a", label: "Again" }] })]))
      .toThrow(/Duplicate option value a in question q1/);
    expect(reject([question("q1", { options: [{ value: "a", label: " " }] })]))
      .toThrow(/label of option a in question q1 must not be empty/);
    expect(reject([question("q1", {
      options: Array.from({ length: ASK_USER_OPTION_LIMIT + 1 }, (_, index) => ({ value: `v${index.toString()}`, label: "L" })),
    })])).toThrow(/more than 12 options/);
    expect(store.pendingAsk(sessionId)).toBeUndefined();
  });

  it("accepts an optionless question", () => {
    const store = testStore();
    const { ask } = store.open({ sessionId, questions: [question("q1", { options: [] })] });
    expect(ask.questions[0]).toEqual({ id: "q1", question: "Question q1?", options: [] });
  });
});

describe("PendingAskStore submit", () => {
  it("reports answered and unanswered questions for a partial submit", () => {
    const store = testStore();
    const { ask } = store.open({
      sessionId,
      questions: [question("q1"), question("q2"), question("q3")],
    });

    const result = store.submit(sessionId, ask.askId, { answers: [{ id: "q2", values: ["no"] }] });

    expect(result).toEqual({
      status: "closed",
      outcome: {
        askId: "ask-1",
        reason: "submitted",
        askedAt: "2026-01-01T00:00:00.000Z",
        closedAt: "2026-01-01T00:00:01.000Z",
        questions: [
          { question: ask.questions[0], answered: false, values: [] },
          { question: ask.questions[1], answered: true, values: ["no"] },
          { question: ask.questions[2], answered: false, values: [] },
        ],
        answeredCount: 1,
        unansweredIds: ["q1", "q3"],
        summary: "Answered 1 of 3; unanswered: q1, q3",
      },
    });
    expect(store.pendingAsk(sessionId)).toBeUndefined();
  });

  it("summarizes a fully answered ask without an unanswered list", () => {
    const store = testStore();
    const { ask } = openTwoQuestions(store);

    const result = store.submit(sessionId, ask.askId, {
      answers: [{ id: "q1", values: ["yes"] }, { id: "q2", values: ["no"] }],
    });

    expect(result).toMatchObject({
      status: "closed",
      outcome: { answeredCount: 2, unansweredIds: [], summary: "Answered 2 of 2; none left unanswered" },
    });
  });

  it("treats an empty answer as leaving the question untouched", () => {
    const store = testStore();
    const { ask } = store.open({ sessionId, questions: [question("q1"), question("q2")] });

    const result = store.submit(sessionId, ask.askId, {
      answers: [{ id: "q1", values: [] }, { id: "q2", values: [], otherText: "   " }],
    });

    expect(result).toMatchObject({ status: "closed", outcome: { answeredCount: 0, unansweredIds: ["q1", "q2"] } });
  });

  it("rejects several values for a single-select question and keeps the ask open", () => {
    const store = testStore();
    const { ask } = openTwoQuestions(store);

    expect(() => store.submit(sessionId, ask.askId, { answers: [{ id: "q1", values: ["yes", "no"] }] }))
      .toThrow(/Question q1 accepts a single answer/);
    expect(store.pendingAsk(sessionId)?.askId).toBe(ask.askId);
  });

  it("accepts several values and coexisting custom text for a multi-select question", () => {
    const store = testStore();
    const { ask } = store.open({
      sessionId,
      questions: [question("q1", { multiple: true })],
    });

    const result = store.submit(sessionId, ask.askId, {
      answers: [{ id: "q1", values: ["yes", "no"], otherText: "  maybe later  " }],
    });

    expect(result).toMatchObject({
      status: "closed",
      outcome: {
        questions: [{ answered: true, values: ["yes", "no"], otherText: "maybe later" }],
        answeredCount: 1,
      },
    });
  });

  it("accepts custom text for every question", () => {
    const store = testStore();
    const { ask } = openTwoQuestions(store);

    const result = store.submit(sessionId, ask.askId, { answers: [{ id: "q1", values: [], otherText: "custom" }] });

    expect(result).toMatchObject({ status: "closed", outcome: { answeredCount: 1 } });
    if (result.status !== "closed") throw new Error("expected the ask to close");
    expect(result.outcome.questions[0]).toMatchObject({ answered: true, values: [], otherText: "custom" });
  });

  it("answers a free-text-only question with custom text alone", () => {
    const store = testStore();
    const { ask } = store.open({ sessionId, questions: [question("q1", { options: [] })] });

    const result = store.submit(sessionId, ask.askId, { answers: [{ id: "q1", values: [], otherText: "a note" }] });

    expect(result).toMatchObject({ status: "closed", outcome: { questions: [{ answered: true, values: [], otherText: "a note" }] } });
  });

  it("rejects unknown, duplicated, and unoffered answers", () => {
    const store = testStore();
    const { ask } = openTwoQuestions(store);
    const reject = (answers: Parameters<typeof store.submit>[2]["answers"]) => () => store.submit(sessionId, ask.askId, { answers });

    expect(reject([{ id: "q9", values: ["yes"] }])).toThrow(/Unknown question id q9/);
    expect(reject([{ id: "q1", values: ["yes"] }, { id: "q1", values: ["no"] }])).toThrow(/Duplicate answer for question q1/);
    expect(reject([{ id: "q1", values: ["nope"] }])).toThrow(/Question q1 has no option nope/);
    expect(reject([{ id: "q1", values: ["yes", "yes"] }])).toThrow(/Duplicate value yes for question q1/);
    expect(store.pendingAsk(sessionId)?.askId).toBe(ask.askId);
  });

  it("treats a submit or cancel for an ask that is no longer open as stale", () => {
    const store = testStore();
    const { ask } = openTwoQuestions(store);

    expect(store.submit(sessionId, "ask-other", { answers: [] })).toEqual({ status: "stale" });
    expect(store.cancel(sessionId, "ask-other")).toEqual({ status: "stale" });
    expect(store.submit("session-2", ask.askId, { answers: [] })).toEqual({ status: "stale" });

    store.submit(sessionId, ask.askId, { answers: [] });
    expect(store.submit(sessionId, ask.askId, { answers: [] })).toEqual({ status: "stale" });
  });
});

describe("PendingAskStore close transitions", () => {
  it("supersedes an unanswered ask and reports its questions as unanswered", () => {
    const store = testStore();
    const first = openTwoQuestions(store);

    const second = store.open({ sessionId, questions: [question("q3")] });

    expect(second.ask.askId).toBe("ask-2");
    expect(second.superseded).toEqual({
      askId: "ask-1",
      reason: "superseded",
      askedAt: "2026-01-01T00:00:00.000Z",
      closedAt: "2026-01-01T00:00:01.000Z",
      questions: [
        { question: first.ask.questions[0], answered: false, values: [] },
        { question: first.ask.questions[1], answered: false, values: [] },
      ],
      answeredCount: 0,
      unansweredIds: ["q1", "q2"],
      summary: "Answered 0 of 2; unanswered: q1, q2",
    });
    expect(store.pendingAsk(sessionId)?.askId).toBe("ask-2");
    expect(store.submit(sessionId, first.ask.askId, { answers: [] })).toEqual({ status: "stale" });
  });

  it("does not supersede an ask that belongs to another session", () => {
    const store = testStore();
    const first = openTwoQuestions(store);

    const second = store.open({ sessionId: "session-2", questions: [question("q3")] });

    expect(second.superseded).toBeUndefined();
    expect(store.pendingAsk(sessionId)?.askId).toBe(first.ask.askId);
  });

  it("cancels an open ask as fully unanswered", () => {
    const store = testStore();
    const { ask } = openTwoQuestions(store);

    expect(store.cancel(sessionId, ask.askId)).toMatchObject({
      status: "closed",
      outcome: { reason: "cancelled", answeredCount: 0, unansweredIds: ["q1", "q2"] },
    });
    expect(store.pendingAsk(sessionId)).toBeUndefined();
  });

  it("cancels whatever ask is open without naming its id", () => {
    const store = testStore();
    openTwoQuestions(store);

    const outcome = store.cancelOpen(sessionId);

    expect(outcome).toMatchObject({ askId: "ask-1", reason: "cancelled", answeredCount: 0, unansweredIds: ["q1", "q2"] });
    expect(store.pendingAsk(sessionId)).toBeUndefined();
    expect(store.cancelOpen(sessionId)).toBeUndefined();
  });

  it("forgets the open ask of a session that goes away without reporting an outcome", () => {
    const store = testStore();
    const { ask } = openTwoQuestions(store);

    store.forgetSession(sessionId);

    expect(store.pendingAsk(sessionId)).toBeUndefined();
    expect(store.cancel(sessionId, ask.askId)).toEqual({ status: "stale" });
  });

  it("keeps each session's open ask separate", () => {
    const store = testStore();
    const first = openTwoQuestions(store);
    const second = store.open({ sessionId: "session-2", questions: [question("q3")] });

    expect([store.pendingAsk(sessionId)?.askId, store.pendingAsk("session-2")?.askId])
      .toEqual([first.ask.askId, second.ask.askId]);
  });
});

describe("ask outcome rendering", () => {
  it("names answered and unanswered questions in the model-facing text", () => {
    const store = testStore();
    const { ask } = store.open({
      sessionId,
      questions: [question("q1"), question("q2"), question("q3")],
    });
    const result = store.submit(sessionId, ask.askId, {
      answers: [{ id: "q1", values: ["yes"] }, { id: "q2", values: [], otherText: "something else" }],
    });
    if (result.status !== "closed") throw new Error("expected the ask to close");

    expect(renderAskUserAnswersText(result.outcome)).toBe([
      "The user submitted answers to your questions.",
      "",
      "- q1: Question q1?",
      "  Answered: selected yes",
      "- q2: Question q2?",
      `  Answered: custom: "something else"`,
      "- q3: Question q3?",
      "  Unanswered.",
      "",
      "Answered 2 of 3; unanswered: q3",
    ].join("\n"));
  });

  it("tells the model a cancelled ask was closed before it was answered", () => {
    const store = testStore();
    const { ask } = openTwoQuestions(store);
    const result = store.cancel(sessionId, ask.askId);
    if (result.status !== "closed") throw new Error("expected the ask to close");

    expect(renderAskUserAnswersText(result.outcome)).toContain("closed (cancelled) before it was fully answered");
  });

  it("names the abandoned questions when an ask is superseded", () => {
    const store = testStore();
    openTwoQuestions(store);
    const superseded = store.open({ sessionId, questions: [question("q3")] }).superseded;
    if (superseded === undefined) throw new Error("expected a superseded outcome");

    expect(renderSupersededAskText(superseded)).toBe([
      "This replaced an earlier question set (ask-1) that the user never submitted.",
      "Left unanswered: q1, q2.",
    ].join("\n"));
  });
});
