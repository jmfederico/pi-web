import { describe, expect, it } from "vitest";
import { textMessage } from "./chatMessages";
import { applyTranscriptEvent } from "./chatTranscript";
import type { ChatLine } from "./components/shared";

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
      { role: "system", parts: [{ type: "text", text: "Model response failed: provider returned 500" }], meta: { timestamp: "2026-05-09T12:00:00.000Z", model: { provider: "anthropic", id: "claude-sonnet" } } },
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
      { role: "system", parts: [{ type: "text", text: "Model response failed: connection lost" }], meta: { timestamp: "2026-05-09T12:00:00.000Z" } },
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

  it("replaces an optimistic user message when the finalized text matches", () => {
    const messages = [textMessage("user", "sent prompt")];

    expect(applyTranscriptEvent(messages, { type: "message.end", message: { role: "user", content: "sent prompt", timestamp: "2026-05-09T12:00:00.000Z" } })).toEqual([
      { ...textMessage("user", "sent prompt"), meta: { timestamp: "2026-05-09T12:00:00.000Z" } },
    ]);
  });
});
