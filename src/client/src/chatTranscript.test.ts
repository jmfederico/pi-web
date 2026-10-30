import { describe, expect, it } from "vitest";
import { ASK_USER_ANSWERS_CUSTOM_TYPE, type AskUserOutcome, type AskUserRequest } from "../../shared/apiTypes";
import { groupChatMessages } from "./chatGroups";
import { normalizeMessages, textMessage } from "./chatMessages";
import { openTranscriptQuestion } from "./chatQuestions";
import { applyTranscriptEvent, seedStreamingPartial } from "./chatTranscript";
import type { ChatLine } from "./components/shared";

const askUserOutcome: AskUserOutcome = {
  askId: "ask-1",
  reason: "submitted",
  askedAt: "2026-07-20T10:00:00.000Z",
  closedAt: "2026-07-20T10:05:00.000Z",
  questions: [
    {
      question: { id: "editor", question: "Which editor?", options: [{ value: "vim", label: "Vim" }] },
      answered: true,
      values: ["vim"],
    },
    {
      question: { id: "region", question: "Which region?", options: [{ value: "eu", label: "Europe" }] },
      answered: false,
      values: [],
    },
  ],
  answeredCount: 1,
  unansweredIds: ["region"],
  summary: "Answered 1 of 2; unanswered: region",
};

const askUserRequest: AskUserRequest = {
  askId: askUserOutcome.askId, askedAt: askUserOutcome.askedAt,
  questions: askUserOutcome.questions.map((record) => record.question),
};

const supersededAskUserOutcome: AskUserOutcome = {
  ...askUserOutcome,
  reason: "superseded",
  questions: askUserOutcome.questions.map((record) => ({ question: record.question, answered: false, values: [] })),
  answeredCount: 0,
  unansweredIds: ["editor", "region"],
  summary: "Answered 0 of 2; unanswered: editor, region",
};

const finalAssistant = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "plan" },
    { type: "text", text: "answer" },
  ],
  timestamp: "2026-05-09T12:00:00.000Z",
  provider: "test",
  model: "model",
};

describe("assistant stream identity", () => {
  const start = { ...finalAssistant, streamId: "stream-1", content: [] };
  const toolStart = { type: "tool.start" as const, toolCallId: "call-1", toolName: "bash", summary: "pwd" };

  it.each(["assistant.delta", "assistant.thinking.delta"] as const)("reconciles %s in place across an intervening tool", (type) => {
    let messages = applyTranscriptEvent([], { type: "assistant.start", message: start }) ?? [];
    messages = applyTranscriptEvent(messages, { type, streamId: start.streamId, text: "first" }) ?? messages;
    expect(messages[0]?.meta).toEqual(normalizeMessages([finalAssistant])[0]?.meta);
    messages = applyTranscriptEvent(messages, toolStart) ?? messages;
    messages = applyTranscriptEvent(messages, { type, streamId: start.streamId, text: " second" }) ?? messages;
    expect(messages[0]?.parts).toEqual([{ type: type === "assistant.delta" ? "text" : "thinking", text: "first second" }]);
    const final = { ...start, content: type === "assistant.delta"
      ? [{ type: "text", text: "authoritative" }]
      : [{ type: "thinking", thinking: "authoritative" }] };
    const tool = messages[1];
    messages = applyTranscriptEvent(messages, { type: "message.end", message: final }) ?? messages;
    expect(messages).toEqual([...normalizeMessages([final]), tool]);
    expect(applyTranscriptEvent(messages, { type: "message.end", message: final })).toEqual(messages);
  });

  it("keeps separate assistant messages distinct even with identical text and no tool between them", () => {
    const first = { ...start, content: [{ type: "text", text: "same" }] };
    let messages = applyTranscriptEvent([], { type: "message.end", message: first }) ?? [];
    const second = { ...start, streamId: "stream-2" };
    messages = applyTranscriptEvent(messages, { type: "assistant.start", message: second }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "assistant.delta", streamId: second.streamId, text: "same" }) ?? messages;
    const final = { ...second, content: first.content };
    messages = applyTranscriptEvent(messages, { type: "message.end", message: final }) ?? messages;
    expect(messages).toEqual(normalizeMessages([first, final]));
  });

  it("retains snapshot identity across tool-call projection, streaming, and finalization", () => {
    const partial = { ...start, content: [
      { type: "text", text: "before" },
      { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
    ] };
    let messages = seedStreamingPartial([], partial);
    messages = applyTranscriptEvent(messages, { type: "assistant.delta", streamId: start.streamId, text: " after" }) ?? messages;
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "before after" }]);
    const final = { ...start, content: [{ type: "text", text: "before after" }, partial.content[1]] };
    messages = applyTranscriptEvent(messages, { type: "message.end", message: final }) ?? messages;
    expect(messages).toEqual(normalizeMessages([final]));
  });

  it("keeps identity when joining an empty stream or a tool-call-only partial", () => {
    for (const content of [[], [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }]]) {
      let messages = seedStreamingPartial([], { ...start, content });
      messages = applyTranscriptEvent(messages, { ...toolStart, toolCallId: "call-2" }) ?? messages;
      messages = applyTranscriptEvent(messages, { type: "assistant.delta", streamId: start.streamId, text: "answer" }) ?? messages;
      expect(messages.filter((line) => line.role === "assistant")).toEqual([
        { ...normalizeMessages([{ ...start, content: [{ type: "text", text: "answer" }] }])[0] },
      ]);
    }
  });

  it("removes an empty provisional assistant on finalization without removing its tool", () => {
    let messages = applyTranscriptEvent([], { type: "assistant.start", message: start }) ?? [];
    messages = applyTranscriptEvent(messages, toolStart) ?? messages;
    const tool = messages[1];
    expect(applyTranscriptEvent(messages, { type: "message.end", message: start })).toEqual([tool]);
    const toolOnlyFinal = { ...start, content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }] };
    expect(applyTranscriptEvent(messages, { type: "message.end", message: toolOnlyFinal })).toEqual([tool]);
  });

  it.each([true, false])("reconciles identified skill reads without duplicating the streamed skill row (thinking: %s)", (thinking) => {
    const parts = thinking ? [{ type: "thinking", thinking: "load skill" }] : [];
    const final = { ...start, content: [...parts,
      { type: "toolCall", id: "skill-1", name: "read", arguments: { path: "/skills/playwright/SKILL.md" } },
    ] };
    let messages = applyTranscriptEvent([], { type: "assistant.start", message: start }) ?? [];
    if (thinking) messages = applyTranscriptEvent(messages, { type: "assistant.thinking.delta", streamId: start.streamId, text: "load skill" }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "tool.start", toolName: "read", toolCallId: "skill-1", summary: "read skill", args: { path: "/skills/playwright/SKILL.md" } }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "message.end", message: final }) ?? messages;
    expect(messages).toEqual(normalizeMessages([final]));
    expect(applyTranscriptEvent(messages, { type: "message.end", message: final })).toEqual(messages);
  });

  it("does not append an identified delta to a neighboring message if start was unavailable", () => {
    const history = normalizeMessages([finalAssistant]);
    const messages = applyTranscriptEvent(history, { type: "assistant.delta", streamId: "new", text: "new" });
    expect(messages).toEqual([...history, { role: "assistant", streamId: "new", parts: [{ type: "text", text: "new" }] }]);
  });
});

describe("applyTranscriptEvent", () => {
  it("streams thinking and text into one assistant message", () => {
    let messages: ChatLine[] = [];
    messages = applyTranscriptEvent(messages, { type: "assistant.thinking.delta", text: "pla" }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "assistant.thinking.delta", text: "n" }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "assistant.delta", text: "answer" }) ?? messages;

    expect(messages).toEqual([
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "text", text: "answer" }] },
    ]);
  });

  it("projects finalized ask_user answers identically to rehydrated history", () => {
    const rawMessage = {
      role: "custom",
      customType: ASK_USER_ANSWERS_CUSTOM_TYPE,
      content: "The user submitted answers to your questions.",
      details: askUserOutcome,
      entryId: "response-entry",
    };
    const hydrated = normalizeMessages([rawMessage]);
    const live = applyTranscriptEvent([], { type: "message.end", message: rawMessage });

    expect(live).toEqual(hydrated);
    expect(live).toEqual([{
      role: "system",
      parts: [{ type: "askUserRecord", outcome: askUserOutcome }],
      entryId: "response-entry",
    }]);
    expect(applyTranscriptEvent(live ?? [], { type: "message.end", message: rawMessage })).toEqual(live);

    const nextOutcome = { ...askUserOutcome, askId: "ask-2" };
    const nextRawMessage = { ...rawMessage, entryId: "next-response-entry", details: nextOutcome };
    expect(applyTranscriptEvent(live ?? [], { type: "message.end", message: nextRawMessage })).toEqual([
      ...hydrated,
      ...normalizeMessages([nextRawMessage]),
    ]);
  });

  it("keeps superseded ask records identical across live tool events and hydrated history", () => {
    const args = { questions: [{ id: "next", question: "Try again?", options: [] }] };
    const details = { ask: { askId: "ask-2" }, superseded: supersededAskUserOutcome };
    const finalResult = {
      role: "toolResult",
      toolCallId: "ask-call",
      toolName: "ask_user",
      content: [{ type: "text", text: "Posted a newer question set." }],
      details,
      isError: false,
    };
    const hydrated = normalizeMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "ask-call", name: "ask_user", arguments: args }] },
      finalResult,
    ]);
    let live: ChatLine[] = [];

    live = applyTranscriptEvent(live, { type: "tool.start", toolName: "ask_user", toolCallId: "ask-call", summary: "", args }) ?? live;
    live = applyTranscriptEvent(live, {
      type: "tool.end",
      toolName: "ask_user",
      toolCallId: "ask-call",
      text: "Posted a newer question set.",
      content: finalResult.content,
      details,
      isError: false,
    }) ?? live;
    live = applyTranscriptEvent(live, { type: "message.end", message: finalResult }) ?? live;

    expect(live).toEqual(hydrated);
    expect(live.filter((line) => line.parts.some((part) => part.type === "askUserRecord"))).toHaveLength(1);
    expect(groupChatMessages(live).map((group) => group.kind)).toEqual(["group", "message"]);
  });

  it("reconciles tool.end and message.end into one durable question, matching replay", () => {
    const args = { questions: askUserRequest.questions };
    const content = [{ type: "text", text: "Questions posted" }];
    const details = { ask: askUserRequest };
    const finalResult = { role: "toolResult", toolName: "ask_user", toolCallId: "ask-call", content, details, isError: false,
      entryId: "question-entry", timestamp: askUserRequest.askedAt };
    let live = applyTranscriptEvent([], { type: "tool.start", toolName: "ask_user", toolCallId: "ask-call", summary: "", args }) ?? [];
    live = applyTranscriptEvent(live, { type: "message.append", message: { role: "user", content: "Intervening conversation" } }) ?? live;
    live = applyTranscriptEvent(live, { type: "tool.end", toolName: "ask_user", toolCallId: "ask-call", text: "Questions posted", content, details, isError: false }) ?? live;
    expect(live.flatMap((line) => line.parts).some((part) => part.type === "askUserQuestion")).toBe(false);
    live = applyTranscriptEvent(live, { type: "message.end", message: finalResult }) ?? live;
    expect(live).toEqual(normalizeMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "ask-call", name: "ask_user", arguments: args }] },
      { role: "user", content: "Intervening conversation" }, finalResult,
    ]));
    expect(live.flatMap((line) => line.parts).filter((part) => part.type === "askUserQuestion")).toHaveLength(1);

    const later = applyTranscriptEvent(live, { type: "assistant.delta", text: "Continue" }) ?? live;
    const reconciled = applyTranscriptEvent(later, { type: "message.end", message: finalResult }) ?? later;
    expect(reconciled.at(-1)).toEqual(textMessage("assistant", "Continue"));
    expect(openTranscriptQuestion(reconciled, { historyReady: true, writable: true, messageEnd: 4, messageTotal: 4 })).toBeUndefined();
  });

  it.each([
    { details: {}, isError: false },
    { details: undefined, isError: false },
    { details: { ask: { askId: "malformed" } }, isError: false },
    { details: { ask: askUserRequest }, isError: true },
  ])("uses the final message when an extension replaces provisional ask details (%j)", (replacement) => {
    const args = { questions: askUserRequest.questions };
    const content = [{ type: "text", text: "Questions posted" }];
    const finalResult = { role: "toolResult", toolName: "ask_user", toolCallId: "ask-call", content, ...replacement };
    let live = applyTranscriptEvent([], { type: "tool.start", toolName: "ask_user", toolCallId: "ask-call", summary: "", args }) ?? [];
    live = applyTranscriptEvent(live, { type: "tool.end", toolName: "ask_user", toolCallId: "ask-call", text: "Questions posted", content,
      details: { ask: askUserRequest, superseded: supersededAskUserOutcome }, isError: false }) ?? live;
    live = applyTranscriptEvent(live, { type: "message.end", message: finalResult }) ?? live;

    expect(live).toEqual(normalizeMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "ask-call", name: "ask_user", arguments: args }] }, finalResult,
    ]));
    expect(live.flatMap((line) => line.parts).some((part) => part.type === "askUserQuestion" || part.type === "askUserRecord")).toBe(false);
  });

  it.each([{ content: [] }, { content: "" }, { content: [{ type: "text", text: "" }] }])("keeps an empty result after a question closed in live and replay (%j)", ({ content }) => {
    const args = { command: "true" };
    const call = { role: "assistant", content: [{ type: "toolCall", id: "other", name: "bash", arguments: args }] };
    const question = { role: "toolResult", toolName: "ask_user", content: [], details: { ask: askUserRequest }, isError: false };
    const result = { role: "toolResult", toolName: "bash", toolCallId: "other", content, isError: false, entryId: "empty-result" };
    const tail = { historyReady: true, writable: true, messageEnd: 3, messageTotal: 3 };
    // Both a coalesced result and a page starting after its call must retain chronology.
    for (const history of [[call, question], [question]]) {
      const before = normalizeMessages(history);
      expect(openTranscriptQuestion(before, tail)).toEqual(askUserRequest);
      const replay = normalizeMessages([...history, result]);
      expect(openTranscriptQuestion(replay, tail)).toBeUndefined();
      for (const type of ["message.end", "message.append"] as const) {
        const live = applyTranscriptEvent(before, { type, message: result }) ?? before;
        expect(openTranscriptQuestion(live, tail)).toBeUndefined();
        expect(live.at(-1)?.entryId).toBe("empty-result");
        // Without the call, live uses an execution card and replay a result card.
        if (history.length === 2) expect(live).toEqual(replay);
      }
    }
  });

  it("does not fragment later technical groups merely because history contains a question", () => {
    const question = { role: "toolResult", toolName: "ask_user", content: [], details: { ask: askUserRequest }, isError: false };
    const continuation = { role: "user", content: "Continue" };
    const args = { command: "true" };
    const call = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: args }] });
    const result = (id: string) => ({ role: "toolResult", toolName: "bash", toolCallId: id, content: [], isError: false });
    let live = normalizeMessages([question, continuation]);
    for (const id of ["first", "second"]) {
      live = applyTranscriptEvent(live, { type: "tool.start", toolName: "bash", toolCallId: id, summary: "", args }) ?? live;
      live = applyTranscriptEvent(live, { type: "tool.end", toolName: "bash", toolCallId: id, text: "", content: [], isError: false }) ?? live;
      live = applyTranscriptEvent(live, { type: "message.end", message: result(id) }) ?? live;
    }
    const replay = normalizeMessages([question, continuation, call("first"), result("first"), call("second"), result("second")]);
    expect(live).toEqual(replay);
    expect(live.flatMap((line) => line.parts).some((part) => part.type === "toolResultBoundary")).toBe(false);
    const groups = groupChatMessages(live);
    expect(groups.map((group) => group.kind)).toEqual(["group", "message", "message", "group"]);
    expect(groups.at(-1)).toMatchObject({ kind: "group", messages: [{ message: { role: "tool" } }, { message: { role: "tool" } }] });
  });

  it("retains a later tool result's position when updating a call before a question", () => {
    const args = { command: "echo later" };
    let live = applyTranscriptEvent([], { type: "tool.start", toolName: "bash", toolCallId: "other", summary: "", args }) ?? [];
    const question = { role: "toolResult", toolName: "ask_user", toolCallId: "ask-call", content: [{ type: "text", text: "Questions posted" }], details: { ask: askUserRequest }, isError: false };
    // A tool call can be present in a stream snapshot before its finalized result.
    live = seedStreamingPartial(live, { role: "assistant", content: [{ type: "toolCall", id: "ask-call", name: "ask_user", arguments: { questions: askUserRequest.questions } }] });
    live = applyTranscriptEvent(live, { type: "message.end", message: question }) ?? live;
    const result = { role: "toolResult", toolName: "bash", toolCallId: "other", content: [{ type: "text", text: "later" }], isError: false, entryId: "later-result" };
    live = applyTranscriptEvent(live, { type: "tool.end", toolName: "bash", toolCallId: "other", text: "later", content: result.content, isError: false }) ?? live;
    live = applyTranscriptEvent(live, { type: "message.end", message: result }) ?? live;
    expect(live).toEqual(normalizeMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "other", name: "bash", arguments: args }] },
      { role: "assistant", content: [{ type: "toolCall", id: "ask-call", name: "ask_user", arguments: { questions: askUserRequest.questions } }] }, question, result,
    ]));
    expect(openTranscriptQuestion(live, { historyReady: true, writable: true, messageEnd: 4, messageTotal: 4 })).toBeUndefined();
  });

  it.each([undefined, "stream-1"])("closes a question for an empty streaming partial and finalized invisible entry (identity: %s)", (streamId) => {
    const question: ChatLine = { role: "tool", parts: [{ type: "askUserQuestion", ask: askUserRequest }] };
    const emptyAssistant = { role: "assistant", content: [], entryId: "later-empty", ...(streamId === undefined ? {} : { streamId }) };
    const tail = { historyReady: true, writable: true, messageEnd: 2, messageTotal: 2 };
    const history = normalizeMessages([question, emptyAssistant]);
    expect(openTranscriptQuestion(history, tail)).toBeUndefined();
    expect(seedStreamingPartial([question], emptyAssistant)).toEqual(history);
    expect(applyTranscriptEvent([question], { type: "message.end", message: emptyAssistant })).toEqual(history);
    expect(applyTranscriptEvent([question], { type: "message.append", message: emptyAssistant })).toEqual(history);
    if (streamId !== undefined) {
      const started = applyTranscriptEvent([question], { type: "assistant.start", message: emptyAssistant }) ?? [];
      const finalized = applyTranscriptEvent(started, { type: "message.end", message: emptyAssistant }) ?? [];
      expect(finalized).toEqual(history);
      expect(openTranscriptQuestion(finalized, tail)).toBeUndefined();
    }
    expect(groupChatMessages(history).map((group) => group.kind)).toEqual(["message"]);
  });

  it("never projects failed live ask payloads or in-progress tool arguments as questions", () => {
    const details = { ask: askUserRequest };
    let live = applyTranscriptEvent([], { type: "tool.start", toolName: "ask_user", toolCallId: "ask-call", summary: "", args: { questions: askUserRequest.questions } }) ?? [];
    live = applyTranscriptEvent(live, { type: "tool.update", toolName: "ask_user", toolCallId: "ask-call", text: "partial", details }) ?? live;
    live = applyTranscriptEvent(live, { type: "tool.end", toolName: "ask_user", toolCallId: "ask-call", text: "failed", details, isError: true }) ?? live;
    expect(live.flatMap((line) => line.parts).some((part) => part.type === "askUserQuestion")).toBe(false);
    expect(live[0]?.parts[0]).toMatchObject({ type: "toolExecution", status: "error", resultText: "failed" });
  });

  it("reconciles delivery of one response but keeps two replies to the same question", () => {
    const response = { role: "custom", customType: ASK_USER_ANSWERS_CUSTOM_TYPE, content: "Answers sent", details: askUserOutcome, entryId: "answer-1" };
    let live = applyTranscriptEvent([], { type: "message.append", message: response }) ?? [];
    live = applyTranscriptEvent(live, { type: "message.end", message: response }) ?? live;
    const another = { ...response, entryId: "answer-2", details: { ...askUserOutcome, closedAt: "2026-07-20T10:06:00.000Z" } };
    live = applyTranscriptEvent(live, { type: "message.end", message: another }) ?? live;
    const identicalNewEntry = { ...another, entryId: "answer-3" };
    live = applyTranscriptEvent(live, { type: "message.end", message: identicalNewEntry }) ?? live;
    expect(live).toEqual(normalizeMessages([response, another, identicalNewEntry]));
    expect(live).toHaveLength(3);
  });

  it("preserves equal human responses when live messages have no durable entry IDs", () => {
    const response = { role: "custom", customType: ASK_USER_ANSWERS_CUSTOM_TYPE, content: "Answers sent", details: askUserOutcome };
    let live = applyTranscriptEvent([], { type: "message.end", message: response }) ?? [];
    live = applyTranscriptEvent(live, { type: "message.end", message: response }) ?? live;
    expect(live).toEqual(normalizeMessages([response, response]));
    expect(live).toHaveLength(2);
  });

  it("replaces the streamed assistant message with the finalized history shape", () => {
    const streamed: ChatLine[] = [
      textMessage("user", "question"),
      { role: "assistant", parts: [{ type: "thinking", text: "partial" }, { type: "text", text: "partial answer" }] },
    ];

    expect(applyTranscriptEvent(streamed, { type: "message.end", message: finalAssistant })).toEqual([
      textMessage("user", "question"),
      {
        role: "assistant",
        parts: [{ type: "thinking", text: "plan" }, { type: "text", text: "answer" }],
        meta: { timestamp: "2026-05-09T12:00:00.000Z", model: { provider: "test", id: "model" } },
      },
    ]);
  });

  it("replaces streamed skill reads when the finalized assistant tool call arrives after the tool result", () => {
    const streamed: ChatLine[] = [
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }] },
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "skill content", isError: false }] },
    ];

    expect(applyTranscriptEvent(streamed, {
      type: "message.end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: { path: "/skills/playwright/SKILL.md" } }],
        timestamp: "2026-05-09T12:00:00.000Z",
      },
    })).toEqual([
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }], meta: { timestamp: "2026-05-09T12:00:00.000Z" } },
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "skill content", isError: false }] },
    ]);
  });

  it("appends finalized assistant errors that have no displayable content", () => {
    expect(applyTranscriptEvent([textMessage("user", "question")], {
      type: "message.end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "provider returned 500",
        timestamp: "2026-05-09T12:00:00.000Z",
        provider: "anthropic",
        model: "claude-sonnet",
      },
    })).toEqual([
      textMessage("user", "question"),
      { role: "system", parts: [{ type: "text", text: "Model response failed: provider returned 500", presentation: { kind: "modelError", detail: "provider returned 500" } }], meta: { timestamp: "2026-05-09T12:00:00.000Z", model: { provider: "anthropic", id: "claude-sonnet" } } },
    ]);
  });

  it("replaces streamed assistant text and keeps the finalized error line", () => {
    const streamed: ChatLine[] = [
      textMessage("user", "question"),
      textMessage("assistant", "partial"),
    ];

    expect(applyTranscriptEvent(streamed, {
      type: "message.end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial answer" }],
        stopReason: "error",
        errorMessage: "connection lost",
        timestamp: "2026-05-09T12:00:00.000Z",
      },
    })).toEqual([
      textMessage("user", "question"),
      { ...textMessage("assistant", "partial answer"), meta: { timestamp: "2026-05-09T12:00:00.000Z" } },
      { role: "system", parts: [{ type: "text", text: "Model response failed: connection lost", presentation: { kind: "modelError", detail: "connection lost" } }], meta: { timestamp: "2026-05-09T12:00:00.000Z" } },
    ]);
  });

  it("replaces streamed thinking and skill reads when the finalized assistant message includes thinking", () => {
    const streamed: ChatLine[] = [
      { role: "assistant", parts: [{ type: "thinking", text: "load skill" }] },
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }] },
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "skill content", isError: false }] },
    ];

    expect(applyTranscriptEvent(streamed, {
      type: "message.end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "load skill" },
          { type: "toolCall", name: "read", arguments: { path: "/skills/playwright/SKILL.md" } },
        ],
        timestamp: "2026-05-09T12:00:00.000Z",
      },
    })).toEqual([
      { role: "assistant", parts: [{ type: "thinking", text: "load skill" }, { type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }], meta: { timestamp: "2026-05-09T12:00:00.000Z" } },
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "skill content", isError: false }] },
    ]);
  });

  it("replaces streamed skill reads when finalized paths differ but the skill name matches", () => {
    const streamed: ChatLine[] = [
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "skills/playwright/SKILL.md" }] },
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "skill content", isError: false }] },
    ];

    expect(applyTranscriptEvent(streamed, {
      type: "message.end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: { path: "/home/user/.agents/skills/playwright/SKILL.md" } }],
        timestamp: "2026-05-09T12:00:00.000Z",
      },
    })).toEqual([
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/home/user/.agents/skills/playwright/SKILL.md" }], meta: { timestamp: "2026-05-09T12:00:00.000Z" } },
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "skill content", isError: false }] },
    ]);
  });

  it("keeps edit tool preview and result updates on one execution card", () => {
    let messages: ChatLine[] = [];
    messages = applyTranscriptEvent(messages, { type: "tool.start", toolName: "edit", toolCallId: "edit-1", summary: "src/app.ts", args: { path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] } }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "tool.update", toolName: "edit", toolCallId: "edit-1", text: "Edit preview computed.", details: { preview: { diff: "-1 old\n+1 new", firstChangedLine: 1 } } }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "tool.end", toolName: "edit", toolCallId: "edit-1", text: "ok", isError: false, content: [{ type: "text", text: "ok" }], details: { diff: "-1 old\n+1 new", firstChangedLine: 1 } }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "message.end", message: { role: "toolResult", toolCallId: "edit-1", toolName: "edit", content: [{ type: "text", text: "ok" }], details: { diff: "-1 old\n+1 new", firstChangedLine: 1 }, isError: false } }) ?? messages;

    expect(messages).toEqual([
      {
        role: "tool",
        parts: [{
          type: "toolExecution",
          toolCallId: "edit-1",
          toolName: "edit",
          summary: "src/app.ts",
          args: { path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] },
          status: "success",
          resultText: "ok",
          content: [{ type: "text", text: "ok" }],
          details: { diff: "-1 old\n+1 new", firstChangedLine: 1 },
          preview: { diff: "-1 old\n+1 new", firstChangedLine: 1 },
        }],
      },
    ]);
  });

  it("projects live tool-result images and reconciles final content and metadata", () => {
    const provisionalImage = { type: "image" as const, mimeType: "image/png", data: "UFJFVklFVw==" };
    const finalImage = { type: "image" as const, mimeType: "image/png", data: "RklOQUw=" };
    const finalContent = [{ type: "text", text: "Read image file [image/png]" }, finalImage];
    const timestamp = "2026-07-13T22:00:00.000Z";
    let messages: ChatLine[] = [];

    messages = applyTranscriptEvent(messages, { type: "tool.start", toolName: "read", toolCallId: "read-image-1", summary: "image.png", args: { path: "image.png" } }) ?? messages;
    messages = applyTranscriptEvent(messages, {
      type: "tool.end",
      toolName: "read",
      toolCallId: "read-image-1",
      text: "Read image file [image/png]\n[image]",
      isError: false,
      content: [{ type: "text", text: "Read image file [image/png]" }, provisionalImage],
      details: { source: "tool.end" },
    }) ?? messages;

    expect(messages[0]?.parts.filter((part) => part.type === "image")).toEqual([provisionalImage]);

    messages = applyTranscriptEvent(messages, {
      type: "message.end",
      message: {
        role: "toolResult",
        toolCallId: "read-image-1",
        toolName: "read",
        content: finalContent,
        details: { source: "message.end" },
        isError: false,
        timestamp,
      },
    }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "assistant.delta", text: "done" }) ?? messages;

    const finalizedToolLine: ChatLine = {
      role: "tool",
      parts: [{
        type: "toolExecution",
        toolCallId: "read-image-1",
        toolName: "read",
        summary: "image.png",
        args: { path: "image.png" },
        status: "success",
        resultText: "Read image file [image/png]",
        content: finalContent,
        details: { source: "message.end" },
      }, finalImage],
      meta: { timestamp },
    };
    expect(messages).toEqual([finalizedToolLine, textMessage("assistant", "done")]);
    expect(groupChatMessages(messages)).toEqual([
      { kind: "group", startIndex: 0, endIndex: 0, messages: [{ index: 0, message: { ...finalizedToolLine, parts: [finalizedToolLine.parts[0]] } }] },
      { kind: "tool-image", index: 0, message: { ...finalizedToolLine, parts: [finalImage] }, toolName: "read" },
      { kind: "message", index: 1, message: textMessage("assistant", "done") },
    ]);
  });

  it("keeps image-only live tool results visible without inventing text", () => {
    const image = { type: "image" as const, mimeType: "image/webp", data: "QUJD" };
    let messages: ChatLine[] = [];

    messages = applyTranscriptEvent(messages, { type: "tool.start", toolName: "capture", toolCallId: "capture-1", summary: "screenshot" }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "tool.end", toolName: "capture", toolCallId: "capture-1", text: "[image]", isError: false, content: [image] }) ?? messages;
    messages = applyTranscriptEvent(messages, {
      type: "message.end",
      message: { role: "toolResult", toolCallId: "capture-1", toolName: "capture", content: [image], isError: false },
    }) ?? messages;

    expect(messages).toEqual([{
      role: "tool",
      parts: [{
        type: "toolExecution",
        toolCallId: "capture-1",
        toolName: "capture",
        summary: "screenshot",
        status: "success",
        resultText: "",
        content: [image],
      }, image],
    }]);
    expect(groupChatMessages(messages).map((group) => group.kind)).toEqual(["group", "tool-image"]);
  });

  it("keeps repeated final tool-result events idempotent", () => {
    const image = { type: "image" as const, mimeType: "image/png", data: "RklOQUw=" };
    const finalEvent = {
      type: "message.end" as const,
      message: {
        role: "toolResult",
        toolCallId: "read-image-repeat",
        toolName: "read",
        content: [{ type: "text", text: "Read image file [image/png]" }, image],
        isError: false,
        timestamp: "2026-07-13T22:00:00.000Z",
      },
    };
    let messages: ChatLine[] = [];

    messages = applyTranscriptEvent(messages, { type: "tool.start", toolName: "read", toolCallId: "read-image-repeat", summary: "image.png" }) ?? messages;
    messages = applyTranscriptEvent(messages, {
      type: "tool.end",
      toolName: "read",
      toolCallId: "read-image-repeat",
      text: "Read image file [image/png]\n[image]",
      isError: false,
      content: finalEvent.message.content,
    }) ?? messages;
    messages = applyTranscriptEvent(messages, finalEvent) ?? messages;
    messages = applyTranscriptEvent(messages, finalEvent) ?? messages;

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts.filter((part) => part.type === "toolExecution")).toHaveLength(1);
    expect(messages[0]?.parts.filter((part) => part.type === "image")).toEqual([image]);
    expect(messages[0]?.meta).toEqual({ timestamp: "2026-07-13T22:00:00.000Z" });
  });

  it("matches hydrated history for technical execution and visible image content", () => {
    const image = { type: "image" as const, mimeType: "image/png", data: "QUJD" };
    const timestamp = "2026-07-13T22:00:00.000Z";
    const finalResult = {
      role: "toolResult",
      toolCallId: "read-history-parity",
      toolName: "read",
      content: [{ type: "text", text: "Read image file [image/png]" }, image],
      details: { path: "image.png" },
      isError: false,
      timestamp,
    };
    const historyGroups = groupChatMessages(normalizeMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "read-history-parity", name: "read", arguments: { path: "image.png" } }],
      },
      finalResult,
    ]));
    let liveMessages: ChatLine[] = [];

    liveMessages = applyTranscriptEvent(liveMessages, {
      type: "tool.start",
      toolName: "read",
      toolCallId: "read-history-parity",
      summary: "image.png",
      args: { path: "image.png" },
    }) ?? liveMessages;
    liveMessages = applyTranscriptEvent(liveMessages, {
      type: "tool.end",
      toolName: "read",
      toolCallId: "read-history-parity",
      text: "Read image file [image/png]\n[image]",
      isError: false,
      content: finalResult.content,
      details: finalResult.details,
    }) ?? liveMessages;
    liveMessages = applyTranscriptEvent(liveMessages, { type: "message.end", message: finalResult }) ?? liveMessages;

    const liveGroups = groupChatMessages(liveMessages);
    const technicalParts = (groups: ReturnType<typeof groupChatMessages>) => groups.flatMap((group) => group.kind === "group"
      ? group.messages.flatMap(({ message }) => message.parts.filter((part) => part.type === "toolExecution"))
      : []);
    const visibleImages = (groups: ReturnType<typeof groupChatMessages>) => groups.flatMap((group) => group.kind !== "group"
      ? group.message.parts.filter((part) => part.type === "image")
      : []);
    const visibleImageMeta = (groups: ReturnType<typeof groupChatMessages>) => {
      for (const group of groups) {
        if (group.kind !== "group" && group.message.parts.some((part) => part.type === "image")) return group.message.meta;
      }
      return undefined;
    };

    expect(historyGroups.map((group) => group.kind)).toEqual(["group", "tool-image"]);
    expect(liveGroups.map((group) => group.kind)).toEqual(["group", "tool-image"]);
    expect(technicalParts(liveGroups)).toEqual(technicalParts(historyGroups));
    expect(visibleImages(liveGroups)).toEqual(visibleImages(historyGroups));
    expect(visibleImageMeta(historyGroups)).toEqual({ timestamp });
    expect(visibleImageMeta(liveGroups)).toEqual({ timestamp });
  });

  it("does not merge consecutive streamed skill reads", () => {
    let messages: ChatLine[] = [];
    messages = applyTranscriptEvent(messages, { type: "tool.start", toolName: "read", toolCallId: "1", summary: "", args: { path: "/skills/playwright/SKILL.md" } }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "tool.start", toolName: "read", toolCallId: "2", summary: "", args: { path: "/skills/sentry-cli/SKILL.md" } }) ?? messages;

    expect(messages).toEqual([
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md", toolCallId: "1" }] },
      { role: "skill", parts: [{ type: "skillRead", name: "sentry-cli", path: "/skills/sentry-cli/SKILL.md", toolCallId: "2" }] },
    ]);
  });

  it("ignores duplicate streamed skill read starts", () => {
    let messages: ChatLine[] = [];
    messages = applyTranscriptEvent(messages, { type: "tool.start", toolName: "read", toolCallId: "1", summary: "", args: { path: "/skills/playwright/SKILL.md" } }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "tool.start", toolName: "read", toolCallId: "1", summary: "", args: { path: "/skills/playwright/SKILL.md" } }) ?? messages;

    expect(messages).toEqual([
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md", toolCallId: "1" }] },
    ]);
  });

  it("replaces multiple streamed skill reads with the finalized grouped skill message", () => {
    const firstTool: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolCallId: "read-1", toolName: "read", summary: "/skills/code-quality-architecture/SKILL.md", status: "success", resultText: "content" }] };
    const secondTool: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolCallId: "read-2", toolName: "read", summary: "/skills/relay/SKILL.md", status: "success", resultText: "content" }] };
    const thirdTool: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolCallId: "read-3", toolName: "read", summary: "/skills/skill-creator/SKILL.md", status: "success", resultText: "content" }] };
    const streamed: ChatLine[] = [
      { role: "skill", parts: [{ type: "skillRead", name: "code-quality-architecture", path: "/skills/code-quality-architecture/SKILL.md", toolCallId: "read-1" }] },
      firstTool,
      { role: "skill", parts: [{ type: "skillRead", name: "relay", path: "/skills/relay/SKILL.md", toolCallId: "read-2" }] },
      secondTool,
      { role: "skill", parts: [{ type: "skillRead", name: "skill-creator", path: "/skills/skill-creator/SKILL.md", toolCallId: "read-3" }] },
      thirdTool,
    ];

    expect(applyTranscriptEvent(streamed, {
      type: "message.end",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "/skills/code-quality-architecture/SKILL.md" } },
          { type: "toolCall", id: "read-2", name: "read", arguments: { path: "/skills/relay/SKILL.md" } },
          { type: "toolCall", id: "read-3", name: "read", arguments: { path: "/skills/skill-creator/SKILL.md" } },
        ],
        timestamp: "2026-05-09T12:00:00.000Z",
      },
    })).toEqual([
      {
        role: "skill",
        parts: [
          { type: "skillRead", name: "code-quality-architecture", path: "/skills/code-quality-architecture/SKILL.md", toolCallId: "read-1" },
          { type: "skillRead", name: "relay", path: "/skills/relay/SKILL.md", toolCallId: "read-2" },
          { type: "skillRead", name: "skill-creator", path: "/skills/skill-creator/SKILL.md", toolCallId: "read-3" },
        ],
        meta: { timestamp: "2026-05-09T12:00:00.000Z" },
      },
      firstTool,
      secondTool,
      thirdTool,
    ]);
  });

  it("ignores streamed skill read starts that are already in a finalized grouped skill message", () => {
    const messages: ChatLine[] = [
      {
        role: "skill",
        parts: [
          { type: "skillRead", name: "code-quality-architecture", path: "/skills/code-quality-architecture/SKILL.md", toolCallId: "read-1" },
          { type: "skillRead", name: "relay", path: "/skills/relay/SKILL.md", toolCallId: "read-2" },
        ],
        meta: { timestamp: "2026-05-09T12:00:00.000Z" },
      },
      { role: "tool", parts: [{ type: "toolExecution", toolCallId: "read-1", toolName: "read", summary: "/skills/code-quality-architecture/SKILL.md", status: "success", resultText: "content" }] },
    ];

    expect(applyTranscriptEvent(messages, { type: "tool.start", toolName: "read", toolCallId: "read-2", summary: "", args: { path: "/skills/relay/SKILL.md" } })).toEqual(messages);
  });

  it("allows the same skill read after a user boundary", () => {
    const messages: ChatLine[] = [
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }] },
      textMessage("user", "load it again"),
    ];

    expect(applyTranscriptEvent(messages, { type: "tool.start", toolName: "read", toolCallId: "", summary: "", args: { path: "/skills/playwright/SKILL.md" } })).toEqual([
      ...messages,
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }] },
    ]);
  });

  it("does not merge different finalized user messages", () => {
    const messages = [textMessage("user", "first queued prompt")];

    expect(applyTranscriptEvent(messages, { type: "message.end", message: { role: "user", content: "second queued prompt" } })).toEqual([
      textMessage("user", "first queued prompt"),
      textMessage("user", "second queued prompt"),
    ]);
  });

  it("does not merge optimistic user messages after an aborted turn", () => {
    const messages = [textMessage("user", "stopped prompt")];

    expect(applyTranscriptEvent(messages, { type: "message.append", message: { role: "user", content: "new prompt" } })).toEqual([
      textMessage("user", "stopped prompt"),
      textMessage("user", "new prompt"),
    ]);
  });

  it("replaces a new optimistic user message instead of duplicating it after an aborted turn", () => {
    let messages: ChatLine[] = [textMessage("user", "stopped prompt")];
    messages = applyTranscriptEvent(messages, { type: "message.append", message: { role: "user", content: "new prompt" } }) ?? messages;

    expect(applyTranscriptEvent(messages, { type: "message.end", message: { role: "user", content: "new prompt", timestamp: "2026-05-09T12:00:00.000Z" } })).toEqual([
      textMessage("user", "stopped prompt"),
      { ...textMessage("user", "new prompt"), meta: { timestamp: "2026-05-09T12:00:00.000Z" } },
    ]);
  });

  it("seeds a null or undefined partial as a no-op", () => {
    const messages = [textMessage("user", "question")];
    expect(seedStreamingPartial(messages, null)).toBe(messages);
    expect(seedStreamingPartial(messages, undefined)).toBe(messages);
  });

  it("seeds an in-flight assistant partial with text and thinking so live deltas append onto it", () => {
    const seeded = seedStreamingPartial([textMessage("user", "question")], {
      role: "assistant",
      content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "partial" }],
    });

    expect(seeded).toEqual([
      textMessage("user", "question"),
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "text", text: "partial" }] },
    ]);

    // A live delta continues the seeded assistant message rather than starting a new one.
    expect(applyTranscriptEvent(seeded, { type: "assistant.delta", text: " answer" })).toEqual([
      textMessage("user", "question"),
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "text", text: "partial answer" }] },
    ]);
  });

  it("seeds an in-progress tool call from the partial as a tool execution line", () => {
    const seeded = seedStreamingPartial([textMessage("user", "run it")], {
      role: "assistant",
      content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "ls" } }],
    });

    expect(seeded).toEqual([
      textMessage("user", "run it"),
      { role: "tool", parts: [{ type: "toolExecution", toolCallId: "tool-1", toolName: "bash", summary: "ls", args: { command: "ls" }, status: "pending" }] },
    ]);
  });

  it("replaces an optimistic user message when the finalized text matches", () => {
    const messages = [textMessage("user", "sent prompt")];

    expect(applyTranscriptEvent(messages, { type: "message.end", message: { role: "user", content: "sent prompt", timestamp: "2026-05-09T12:00:00.000Z" } })).toEqual([
      { ...textMessage("user", "sent prompt"), meta: { timestamp: "2026-05-09T12:00:00.000Z" } },
    ]);
  });
});
