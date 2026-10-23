import { describe, expect, it } from "vitest";
import type { AskUserOutcome, AskUserRequest } from "../../shared/apiTypes";
import { openTranscriptQuestion, transcriptQuestionOutcomes } from "./chatQuestions";
import type { ChatLine } from "./components/shared";

const ask: AskUserRequest = {
  askId: "ask-1", askedAt: "2026-07-20T10:00:00.000Z",
  questions: [{ id: "q", question: "Choose?", options: [] }],
};
const question: ChatLine = { role: "tool", parts: [{ type: "askUserQuestion", ask }] };
const tail = { historyReady: true, writable: true, messageEnd: 2, messageTotal: 2 };

it("opens a rehydrated question only on the writable, ready current tail", () => {
  expect(openTranscriptQuestion([question], tail)).toBe(ask);
  expect(openTranscriptQuestion([question], { ...tail, messageEnd: 1 })).toBeUndefined();
  expect(openTranscriptQuestion([question], { ...tail, historyReady: false })).toBeUndefined();
  expect(openTranscriptQuestion([question], { ...tail, writable: false })).toBeUndefined();
});

describe("later conversation entries close the question without needing an outcome", () => {
  it.each<ChatLine>([
    { role: "user", parts: [{ type: "text", text: "Continue without answers" }] },
    { role: "assistant", parts: [{ type: "thinking", text: "plan" }] },
    { role: "assistant", parts: [{ type: "text", text: "streamed reply" }] },
    { role: "system", parts: [{ type: "text", text: "Child session completed" }] },
    { role: "tool", parts: [{ type: "toolResultBoundary", toolCallId: "earlier-call" }] },
  ])("closes on $role/$parts.0.type", (later) => {
    expect(openTranscriptQuestion([question, later], tail)).toBeUndefined();
  });

  it("opens only the newer question", () => {
    const newer = { ...ask, askId: "ask-2" };
    expect(openTranscriptQuestion([question, { role: "tool", parts: [{ type: "askUserQuestion", ask: newer }] }], tail)).toBe(newer);
  });
});

it("projects every response, including a partial answer and skip, without stale protection", () => {
  const reply: AskUserOutcome = {
    ...ask, closedAt: "2026-07-20T10:05:00.000Z", reason: "submitted",
    questions: ask.questions.map((question) => ({ question, answered: false, values: [] })),
    answeredCount: 0, unansweredIds: ["q"], summary: "Answered 0 of 1; unanswered: q",
  };
  const messages: ChatLine[] = [question,
    { role: "system", parts: [{ type: "askUserRecord", outcome: reply }] },
    { role: "system", parts: [{ type: "askUserRecord", outcome: { ...reply, closedAt: "2026-07-20T10:06:00.000Z" } }] },
  ];
  expect(transcriptQuestionOutcomes(messages).get(ask.askId)).toEqual([reply, { ...reply, closedAt: "2026-07-20T10:06:00.000Z" }]);
  expect(openTranscriptQuestion(messages, tail)).toBeUndefined();
});
