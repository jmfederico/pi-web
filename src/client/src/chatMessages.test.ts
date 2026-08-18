import { describe, expect, it } from "vitest";
import { ASK_USER_ANSWERS_CUSTOM_TYPE, type AskUserOutcome } from "../../shared/apiTypes";
import { groupChatMessages } from "./chatGroups";
import { appendText, appendThinking, normalizeMessage, normalizeMessages, textMessage } from "./chatMessages";

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

  it("falls back to a placeholder for image content without data", () => {
    expect(normalizeMessage({ role: "user", content: [{ type: "image", mimeType: "image/png" }] })).toEqual([
      { role: "user", parts: [{ type: "text", text: "[image]" }] },
    ]);
  });

  it("carries the thinking level into assistant message metadata", () => {
    expect(normalizeMessage({ role: "assistant", content: [{ type: "text", text: "hi" }], provider: "openai", model: "gpt-4.1", timestamp: "2026-05-09T12:00:00.000Z", thinkingLevel: "max" })).toEqual([
      { role: "assistant", parts: [{ type: "text", text: "hi" }], meta: { timestamp: "2026-05-09T12:00:00.000Z", model: { provider: "openai", id: "gpt-4.1" }, thinkingLevel: "max" } },
    ]);
  });

  it("shows assistant model errors as system chat messages", () => {
    expect(normalizeMessage({ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit", timestamp: "2026-05-09T12:00:00.000Z", provider: "openai", model: "gpt-4.1" })).toEqual([
      { role: "system", parts: [{ type: "text", text: "Model response failed: 429 rate limit" }], meta: { timestamp: "2026-05-09T12:00:00.000Z", model: { provider: "openai", id: "gpt-4.1" } } },
    ]);
  });

  it("keeps partial assistant content and adds a visible error line", () => {
    expect(normalizeMessage({ role: "assistant", content: [{ type: "text", text: "partial answer" }], stopReason: "error", errorMessage: "connection lost" })).toEqual([
      textMessage("assistant", "partial answer"),
      textMessage("system", "Model response failed: connection lost"),
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
      textMessage("bash", "excluded from context\n\n$ npm test\n\nok\n\nexit 0\n\noutput truncated\n\nfull output: /tmp/out.log"),
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
