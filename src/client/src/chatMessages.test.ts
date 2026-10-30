import { describe, expect, it } from "vitest";
import { ASK_USER_ANSWERS_CUSTOM_TYPE, type AskUserOutcome, type AskUserRequest } from "../../shared/apiTypes";
import { groupChatMessages } from "./chatGroups";
import { appendText, appendThinking, normalizeMessage, normalizeMessages, textMessage } from "./chatMessages";
import { openTranscriptQuestion } from "./chatQuestions";
import { applyTranscriptEvent, seedStreamingPartial } from "./chatTranscript";
import type { ChatLine } from "./components/shared";

const legacyImageReference = { type: "image" as const, mediaId: "0123456789abcdef".repeat(4), mimeType: "image/png", byteSize: 3 };
const imageReference = { ...legacyImageReference, width: 1200, height: 800 };

it.each(["visible", "", undefined, 42])("preserves original text and optional string display text (%s)", (displayText) => {
  const display = typeof displayText === "string" ? { displayText } : {};
  expect(normalizeMessages([{ role: "assistant", content: [
    { type: "text", text: "original", displayText },
    { type: "thinking", thinking: "reasoning", displayText },
    { type: "thinking", text: "fallback reasoning", displayText },
  ] }])).toEqual([{ role: "assistant", parts: [
    { type: "text", text: "original", ...display },
    { type: "thinking", text: "reasoning", ...display },
    { type: "thinking", text: "fallback reasoning", ...display },
  ] }]);
  expect(normalizeMessages([{ role: "user", content: "original", displayText }])).toEqual([
    { role: "user", parts: [{ type: "text", text: "original", ...display }] },
  ]);
});

it("drops stale display overrides when original text resumes streaming", () => {
  expect(appendText([{ role: "assistant", parts: [{ type: "text", text: "original", displayText: "display" }] }], "assistant", " delta")).toEqual([
    { role: "assistant", parts: [{ type: "text", text: "original delta" }] },
  ]);
  expect(appendThinking([{ role: "assistant", parts: [{ type: "thinking", text: "original", displayText: "display" }] }], " delta")).toEqual([
    { role: "assistant", parts: [{ type: "thinking", text: "original delta" }] },
  ]);
});

const askUserOutcome: AskUserOutcome = {
  askId: "ask-1",
  reason: "submitted",
  askedAt: "2026-07-20T10:00:00.000Z",
  closedAt: "2026-07-20T10:05:00.000Z",
  questions: [
    {
      question: { id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }] },
      answered: true,
      values: ["pg"],
    },
    {
      question: { id: "cache", question: "Which cache?", options: [{ value: "redis", label: "Redis" }] },
      answered: false,
      values: [],
    },
  ],
  answeredCount: 1,
  unansweredIds: ["cache"],
  summary: "Answered 1 of 2; unanswered: cache",
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
  unansweredIds: ["db", "cache"],
  summary: "Answered 0 of 2; unanswered: db, cache",
};

describe("chat message normalization", () => {
  it("normalizes simple text messages and drops empty content", () => {
    expect(normalizeMessages([
      { role: "user", content: "hello" },
      { role: "assistant", content: "" },
      { role: "unknown", content: "system text" },
    ])).toEqual([
      textMessage("user", "hello"),
      textMessage("system", "system text"),
    ]);
  });

  it("preserves already-normalized chat lines", () => {
    const line = { role: "assistant" as const, parts: [{ type: "text" as const, text: "cached" }] };

    expect(normalizeMessage(line)).toEqual([line]);
    expect(normalizeMessages([{ role: "user", content: "raw" }, line])).toEqual([textMessage("user", "raw"), line]);
  });

  it("projects ask_user answer messages into visible read-only record parts", () => {
    const normalized = normalizeMessage({
      role: "custom",
      customType: ASK_USER_ANSWERS_CUSTOM_TYPE,
      content: "model-facing answer text",
      details: askUserOutcome,
    });
    const recordLine = { role: "system" as const, parts: [{ type: "askUserRecord" as const, outcome: askUserOutcome }] };

    expect(normalized).toEqual([recordLine]);
    expect(groupChatMessages(normalized)).toEqual([{ kind: "message", index: 0, message: recordLine }]);
  });

  it("falls back to model-facing text when an ask_user answer record is malformed", () => {
    expect(normalizeMessage({
      role: "custom",
      customType: ASK_USER_ANSWERS_CUSTOM_TYPE,
      content: "Answered 0 of 1; unanswered: db",
      details: { askId: "missing-the-rest" },
    })).toEqual([textMessage("system", "Answered 0 of 1; unanswered: db")]);
  });

  it("projects a superseded ask from the later ask_user tool result", () => {
    const normalized = normalizeMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "ask-call", name: "ask_user", arguments: { questions: [] } }] },
      {
        role: "toolResult",
        toolCallId: "ask-call",
        toolName: "ask_user",
        content: [{ type: "text", text: "Posted a newer question set." }],
        details: { ask: { askId: "ask-2" }, superseded: supersededAskUserOutcome },
        isError: false,
      },
    ]);

    expect(normalized[1]).toEqual({ role: "tool", parts: [{ type: "askUserRecord", outcome: supersededAskUserOutcome }] });
    expect(groupChatMessages(normalized).map((group) => group.kind)).toEqual(["group", "message"]);
  });

  it.each([{ content: [] }, { content: "Questions posted" }, { content: [{ type: "text", text: "Questions posted" }] }])("keeps the successful question at its durable result position (%j)", ({ content }) => {
    const messages = normalizeMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "ask-call", name: "ask_user", arguments: { questions: askUserRequest.questions } }] },
      { role: "user", content: "Intervening conversation" },
      { role: "toolResult", entryId: "question-result", toolName: "ask_user", toolCallId: "ask-call", content, details: { ask: askUserRequest }, isError: false },
    ]);
    expect(messages[0]?.parts[0]).toMatchObject({ type: "toolExecution", status: "success" });
    expect(messages.at(-1)).toEqual({ role: "tool", entryId: "question-result", parts: [{ type: "askUserQuestion", ask: askUserRequest }] });
    expect(openTranscriptQuestion(messages, { historyReady: true, writable: true, messageEnd: 3, messageTotal: 3 })).toEqual(askUserRequest);
    expect(groupChatMessages(messages).at(-1)?.kind).toBe("message");
  });

  it("does not erase a later result coalesced into an earlier call", () => {
    const messages = normalizeMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "other", name: "bash", arguments: { command: "echo later" } }] },
      { role: "toolResult", toolName: "ask_user", content: [{ type: "text", text: "Questions posted" }], details: { ask: askUserRequest }, isError: false },
      { role: "toolResult", toolCallId: "other", toolName: "bash", entryId: "later", content: [{ type: "text", text: "later" }], isError: false },
    ]);
    expect(messages.at(-1)).toMatchObject({ entryId: "later", parts: [{ type: "toolResultBoundary", toolCallId: "other" }] });
    expect(openTranscriptQuestion(messages, { historyReady: true, writable: true, messageEnd: 3, messageTotal: 3 })).toBeUndefined();
    expect(groupChatMessages(messages).at(-1)?.kind).toBe("message");
  });

  it("keeps a cached invisible entry's identity, role and metadata after a question", () => {
    const question: ChatLine = { role: "tool", parts: [{ type: "askUserQuestion", ask: askUserRequest }] };
    const empty: ChatLine = { role: "tool", parts: [], entryId: "empty-entry", meta: { timestamp: askUserRequest.askedAt } };
    const messages = normalizeMessages([question, empty]);
    expect(messages.at(-1)).toEqual({ ...empty, parts: [{ type: "empty" }] });
    expect(openTranscriptQuestion(messages, { historyReady: true, writable: true, messageEnd: 2, messageTotal: 2 })).toBeUndefined();
    expect(normalizeMessages(messages)).toEqual(messages);
  });

  it.each([
    { isError: true, details: { ask: askUserRequest } },
    { isError: false, details: { ask: { askId: "malformed" } } },
    { isError: false, details: {} },
  ])("never offers failed or malformed asks as forms (%j)", (result) => {
    const messages = normalizeMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "ask-call", name: "ask_user", arguments: { questions: askUserRequest.questions } }] },
      { role: "toolResult", toolCallId: "ask-call", toolName: "ask_user", content: [{ type: "text", text: "fallback" }], ...result },
    ]);
    expect(messages.flatMap((line) => line.parts).some((part) => part.type === "askUserQuestion")).toBe(false);
    expect(messages[0]?.parts[0]).toMatchObject({ type: "toolExecution", resultText: "fallback" });
  });

  it("normalizes tool calls and tool results", () => {
    expect(normalizeMessage({ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }] })).toEqual([
      { role: "assistant", parts: [{ type: "toolCall", toolName: "bash", summary: "npm test", args: { command: "npm test" } }] },
    ]);
    expect(normalizeMessage({ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "failed" }] })).toEqual([
      { role: "tool", parts: [{ type: "toolResult", toolName: "bash", text: "failed", content: [{ type: "text", text: "failed" }], isError: true }] },
    ]);
  });

  it("normalizes image content into image parts", () => {
    expect(normalizeMessage({ role: "user", content: [{ type: "text", text: "see this" }, { type: "image", mimeType: "image/png", data: "QUJD" }] })).toEqual([
      { role: "user", parts: [{ type: "text", text: "see this" }, { type: "image", mimeType: "image/png", data: "QUJD" }] },
    ]);
  });

  it("preserves references without copying base64 or server-supplied URLs", () => {
    const raw = { role: "user", entryId: "image-entry", content: [{ ...imageReference, data: "QUJD", url: "https://remote.test/not-the-proxy" }] };
    const normalized = normalizeMessages([raw]);
    expect(normalized).toEqual([{ role: "user", entryId: "image-entry", parts: [imageReference] }]);
    expect(normalizeMessages(normalized)).toEqual(normalized);
  });

  it("keeps older references without dimensions usable", () => {
    expect(normalizeMessages([{ role: "user", content: [legacyImageReference] }]))
      .toEqual([{ role: "user", parts: [legacyImageReference] }]);
  });

  it("preserves inline dimension hints through normalization and cached chat lines", () => {
    const inline = { type: "image" as const, mimeType: "image/png", data: "QUJD", width: 400, height: 1600 };
    const normalized = normalizeMessages([{ role: "user", content: [inline] }]);
    expect(normalized).toEqual([{ role: "user", parts: [inline] }]);
    expect(normalizeMessages(normalized)).toEqual(normalized);
  });

  it.each([
    { width: undefined }, { height: undefined }, { width: 0 }, { height: 0 },
    { width: -1 }, { height: -1 }, { width: 1.5 }, { height: 1.5 },
    { width: Infinity }, { height: Infinity }, { width: "1200" }, { height: null },
    { width: Number.MAX_SAFE_INTEGER + 1 },
  ])("drops invalid dimension pairs without discarding the image: %j", (invalid) => {
    const normalized = normalizeMessages([{ role: "user", content: [{ ...imageReference, ...invalid }] }]);
    expect(normalized).toEqual([{ role: "user", parts: [legacyImageReference] }]);
    expect(normalizeMessages(normalized)).toEqual(normalized);
  });

  it.each([
    { mediaId: "A".repeat(64) }, { mediaId: "a".repeat(63) }, { mediaId: "a".repeat(65) },
    { mediaId: "../file.png" }, { mediaId: 42 }, { mediaId: null }, { mediaId: `${"a".repeat(64)}\n` },
    { mimeType: "text/html" }, { mimeType: "" }, { mimeType: null }, { mimeType: "image/png\n" },
    { byteSize: -1 }, { byteSize: 1.5 }, { byteSize: Infinity }, { byteSize: "3" }, { byteSize: undefined },
  ])("fails closed for a malformed image reference: %j", (invalid) => {
    expect(normalizeMessage({ role: "user", content: [{ ...imageReference, ...invalid, data: "QUJD" }] }))
      .toEqual([{ role: "user", parts: [{ type: "text", text: "[image]", presentation: { kind: "imagePlaceholder" } }] }]);
  });

  it("also validates image references in already-shaped cached chat lines", () => {
    expect(normalizeMessage({ role: "user", entryId: "cached-image", parts: [{ ...imageReference, mediaId: "invalid", data: "QUJD" }] }))
      .toEqual([{ role: "user", entryId: "cached-image", parts: [{ type: "text", text: "[image]", presentation: { kind: "imagePlaceholder" } }] }]);
  });

  it("does not reinterpret non-image parts as media references", () => {
    const normalized = normalizeMessages([{ role: "user", content: [{ ...imageReference, type: "text", text: "not an image" }] }]);
    expect(normalized).toEqual([textMessage("user", "not an image")]);
  });

  it("retains references through partial seeding, deltas and final-message reconciliation", () => {
    const partial = { role: "assistant", content: [imageReference, { type: "text", text: "first" }] };
    let live = seedStreamingPartial([], partial);
    live = applyTranscriptEvent(live, { type: "assistant.delta", text: " second" }) ?? live;
    expect(live).toEqual(normalizeMessages([{ ...partial, content: [imageReference, { type: "text", text: "first second" }] }]));
    const final = { ...partial, entryId: "final-image", content: [imageReference, { type: "text", text: "final" }] };
    live = applyTranscriptEvent(live, { type: "message.end", message: final }) ?? live;
    expect(live).toEqual(normalizeMessages([final]));
    expect(applyTranscriptEvent(live, { type: "message.end", message: final })).toEqual(live);
  });

  it("replaces optimistic inline images with authoritative references without loss", () => {
    const optimistic = normalizeMessages([{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "QUJD" }] }]);
    const final = { role: "user", entryId: "saved-image", content: [imageReference] };
    expect(applyTranscriptEvent(optimistic, { type: "message.end", message: final })).toEqual(normalizeMessages([final]));
    expect(applyTranscriptEvent([], { type: "message.append", message: final })).toEqual(normalizeMessages([final]));
  });

  it("keeps tool reference images identical across history, tool.end and repeated final reconciliation", () => {
    const content = [{ type: "text", text: "image read" }, imageReference];
    const call = { role: "assistant", content: [{ type: "toolCall", id: "read-image", name: "read", arguments: { path: "image.png" } }] };
    const final = { role: "toolResult", toolCallId: "read-image", toolName: "read", content, isError: false };
    let live = applyTranscriptEvent([], { type: "tool.start", toolCallId: "read-image", toolName: "read", summary: "image.png", args: { path: "image.png" } }) ?? [];
    live = applyTranscriptEvent(live, { type: "tool.end", toolCallId: "read-image", toolName: "read", text: "image read", content, details: undefined, isError: false }) ?? live;
    const images = (lines: ChatLine[]) => lines.flatMap((line) => line.parts.filter((part) => part.type === "image"));
    expect(images(live)).toEqual(images(normalizeMessages([call, final])));
    expect(images(live)).toEqual([imageReference]);
    const finalized = applyTranscriptEvent(live, { type: "message.end", message: final }) ?? live;
    expect(images(finalized)).toEqual([imageReference]);
    expect(applyTranscriptEvent(finalized, { type: "message.end", message: final })).toEqual(finalized);
  });

  it("falls back to a placeholder for image content without data", () => {
    expect(normalizeMessage({ role: "user", content: [{ type: "image", mimeType: "image/png" }] })).toEqual([
      { role: "user", parts: [{ type: "text", text: "[image]", presentation: { kind: "imagePlaceholder" } }] },
    ]);
  });

  it("carries the thinking level into assistant message metadata", () => {
    expect(normalizeMessage({ role: "assistant", content: [{ type: "text", text: "hi" }], provider: "openai", model: "gpt-4.1", timestamp: "2026-05-09T12:00:00.000Z", thinkingLevel: "max" })).toEqual([
      { role: "assistant", parts: [{ type: "text", text: "hi" }], meta: { timestamp: "2026-05-09T12:00:00.000Z", model: { provider: "openai", id: "gpt-4.1" }, thinkingLevel: "max" } },
    ]);
  });

  it("shows assistant model errors as system chat messages", () => {
    expect(normalizeMessage({ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit", timestamp: "2026-05-09T12:00:00.000Z", provider: "openai", model: "gpt-4.1" })).toEqual([
      { role: "system", parts: [{ type: "text", text: "Model response failed: 429 rate limit", presentation: { kind: "modelError", detail: "429 rate limit" } }], meta: { timestamp: "2026-05-09T12:00:00.000Z", model: { provider: "openai", id: "gpt-4.1" } } },
    ]);
  });

  it("keeps partial assistant content and adds a visible error line", () => {
    expect(normalizeMessage({ role: "assistant", content: [{ type: "text", text: "partial answer" }], stopReason: "error", errorMessage: "connection lost" })).toEqual([
      textMessage("assistant", "partial answer"),
      { role: "system", parts: [{ type: "text", text: "Model response failed: connection lost", presentation: { kind: "modelError", detail: "connection lost" } }] },
    ]);
  });

  it("extracts skill invocation blocks into dedicated skill and user messages", () => {
    expect(normalizeMessage({ role: "user", content: "<skill name=\"playwright\" location=\"/skills/playwright\">\nUse browser\n</skill>\n\nNow test the UI" })).toEqual([
      { role: "user", parts: [{ type: "skillInvocation", name: "playwright", location: "/skills/playwright", content: "Use browser" }] },
      textMessage("user", "Now test the UI"),
    ]);
  });

  it("normalizes skill reads into skill chat lines", () => {
    expect(normalizeMessage({ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/home/user/.agents/skills/playwright/SKILL.md" } }] })).toEqual([
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/home/user/.agents/skills/playwright/SKILL.md" }] },
    ]);
  });

  it("pairs tool calls and results into execution cards when normalizing history", () => {
    expect(normalizeMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] } }] },
      { role: "toolResult", toolCallId: "edit-1", toolName: "edit", content: [{ type: "text", text: "ok" }], details: { diff: "-1 old\n+1 new" }, isError: false },
    ])).toEqual([
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
          details: { diff: "-1 old\n+1 new" },
        }],
      },
    ]);
  });

  it("formats bash execution records as bash chat lines", () => {
    expect(normalizeMessage({
      role: "bashExecution",
      command: "npm test",
      excludeFromContext: true,
      output: "ok",
      exitCode: 0,
      truncated: true,
      fullOutputPath: "/tmp/out.log",
    })).toEqual([
      { role: "bash", parts: [{ type: "text", text: "excluded from context\n\n$ npm test\n\nok\n\nexit 0\n\noutput truncated\n\nfull output: /tmp/out.log", presentation: { kind: "bash", command: "npm test", output: "ok", excluded: true, cancelled: false, truncated: true, exitCode: "0", fullOutputPath: "/tmp/out.log" } }] },
    ]);
  });
});

describe("appendText", () => {
  it("appends to the previous same-role text message", () => {
    expect(appendText([textMessage("assistant", "hello")], "assistant", " world")).toEqual([
      textMessage("assistant", "hello world"),
    ]);
  });

  it("starts a new message when role does not match", () => {
    expect(appendText([textMessage("user", "hello")], "assistant", "hi")).toEqual([
      textMessage("user", "hello"),
      textMessage("assistant", "hi"),
    ]);
  });

  it("adds a text part to the previous same-role non-text message", () => {
    expect(appendText([{ role: "assistant", parts: [{ type: "thinking", text: "plan" }] }], "assistant", "answer")).toEqual([
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "text", text: "answer" }] },
    ]);
  });
});

describe("appendThinking", () => {
  it("appends thinking deltas to the previous assistant thinking part", () => {
    expect(appendThinking([{ role: "assistant", parts: [{ type: "thinking", text: "pla" }] }], "n")).toEqual([
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }] },
    ]);
  });

  it("adds a thinking part to the previous assistant message", () => {
    expect(appendThinking([textMessage("assistant", "answer")], "plan")).toEqual([
      { role: "assistant", parts: [{ type: "text", text: "answer" }, { type: "thinking", text: "plan" }] },
    ]);
  });
});
