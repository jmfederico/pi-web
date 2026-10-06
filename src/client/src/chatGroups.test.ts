import { describe, expect, it } from "vitest";
import { canonicalEntryActionHeaders, groupChatMessages, summarizeChatGroup, type ChatGroup } from "./chatGroups";
import type { ChatLine } from "./components/shared";

const text = (role: ChatLine["role"], value: string): ChatLine => ({ role, parts: [{ type: "text", text: value }] });

describe("groupChatMessages", () => {
  it("groups technical parts until a readable message is encountered", () => {
    const messages: ChatLine[] = [
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "toolCall", toolName: "read", summary: "file" }] },
      text("assistant", "visible answer"),
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "ok", isError: false }] },
    ];

    expect(groupChatMessages(messages, 10)).toEqual([
      { kind: "group", startIndex: 10, endIndex: 10, messages: [messages[0]] },
      { kind: "message", index: 11, message: text("assistant", "visible answer") },
      { kind: "group", startIndex: 12, endIndex: 12, messages: [messages[2]] },
    ]);
  });

  it("splits mixed readable and technical parts from a single message", () => {
    const messages: ChatLine[] = [
      { role: "assistant", parts: [{ type: "thinking", text: "hidden" }, { type: "text", text: "shown" }] },
    ];

    expect(groupChatMessages(messages)).toEqual([
      { kind: "group", startIndex: 0, endIndex: 0, messages: [{ role: "assistant", parts: [{ type: "thinking", text: "hidden" }] }] },
      { kind: "message", index: 0, message: { role: "assistant", parts: [{ type: "text", text: "shown" }] } },
    ]);
  });

  it("keeps skill reads out of event groups", () => {
    const messages: ChatLine[] = [
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }] },
    ];

    expect(groupChatMessages(messages)).toEqual([
      { kind: "group", startIndex: 0, endIndex: 0, messages: [{ role: "assistant", parts: [{ type: "thinking", text: "plan" }] }] },
      { kind: "message", index: 0, message: { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }] } },
    ]);
  });

  it("keeps image content visible outside collapsed event groups", () => {
    const image = { type: "image" as const, mimeType: "image/png", data: "QUJD" };
    const messages: ChatLine[] = [
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "Read image file [image/png]", isError: false }, image] },
    ];

    expect(groupChatMessages(messages)).toEqual([
      {
        kind: "group",
        startIndex: 0,
        endIndex: 0,
        messages: [{ role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "Read image file [image/png]", isError: false }] }],
      },
      { kind: "tool-image", index: 0, message: { role: "tool", parts: [image] }, toolName: "read" },
    ]);
  });

  it("preserves image metadata when splitting technical and readable parts", () => {
    const meta = { timestamp: "2026-07-13T22:00:00.000Z" };
    const image = { type: "image" as const, mimeType: "image/webp", data: "QUJD" };
    const message: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "ok", isError: false }, image], meta };

    expect(groupChatMessages([message])).toEqual([
      { kind: "group", startIndex: 0, endIndex: 0, messages: [{ role: "tool", parts: [message.parts[0]], meta }] },
      { kind: "tool-image", index: 0, message: { role: "tool", parts: [image], meta }, toolName: "read" },
    ]);
  });

  it("keeps user images as ordinary messages", () => {
    const image = { type: "image" as const, mimeType: "image/png", data: "QUJD" };
    const message: ChatLine = { role: "user", parts: [image] };

    expect(groupChatMessages([message])).toEqual([
      { kind: "message", index: 0, message },
    ]);
  });

  it("preserves message metadata when grouping", () => {
    const message: ChatLine = { role: "assistant", parts: [{ type: "thinking", text: "hidden" }, { type: "text", text: "shown" }], meta: { timestamp: "2026-05-09T12:00:00.000Z", model: { provider: "test", id: "model" } } };

    expect(groupChatMessages([message])).toEqual([
      { kind: "group", startIndex: 0, endIndex: 0, messages: [{ role: "assistant", parts: [{ type: "thinking", text: "hidden" }], meta: message.meta }] },
      { kind: "message", index: 0, message: { role: "assistant", parts: [{ type: "text", text: "shown" }], meta: message.meta } },
    ]);
  });

  it("treats compaction and branch summaries as grouped events", () => {
    const messages: ChatLine[] = [
      { ...text("assistant", "summary"), source: "compaction" },
      { ...text("assistant", "branch"), source: "branch_summary" },
    ];

    const groups = groupChatMessages(messages);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "group", startIndex: 0, endIndex: 1 });
  });

  it("keeps a stable group end index when older events are prepended into a group", () => {
    expect(groupChatMessages([
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "older", isError: false }] },
      { role: "assistant", parts: [{ type: "toolCall", toolName: "read", summary: "newer" }] },
      text("assistant", "answer"),
    ], 8)[0]).toMatchObject({ kind: "group", startIndex: 8, endIndex: 9 });
  });
});

function renderedMessages(groups: readonly ChatGroup[]): ChatLine[] {
  return groups.flatMap((group) => group.kind === "group" ? group.messages : [group.message]);
}

describe("canonicalEntryActionHeaders", () => {
  it.each(["user", "assistant"] as const)("prefers the readable %s reply over attached technical parts using rendered identities", (role) => {
    const source: ChatLine = { role, entryId: "entry", parts: [{ type: "thinking", text: "plan" }, { type: "text", text: "reply" }] };
    const groups = groupChatMessages([source], 20);
    const slices = renderedMessages(groups);
    const selected = canonicalEntryActionHeaders(groups);

    expect(selected.size).toBe(1);
    expect([...selected][0]).toBe(slices[1]);
    expect(selected.has(source)).toBe(false);
    expect(groups).toHaveLength(2);
    expect(source.parts).toHaveLength(2);
  });

  it("retains a distinct thinking-only entry even when another entry has a reply", () => {
    const groups = groupChatMessages([
      { role: "assistant", entryId: "thinking", parts: [{ type: "thinking", text: "checkpoint" }] },
      { ...text("assistant", "answer"), entryId: "reply" },
    ]);
    const slices = renderedMessages(groups);

    expect([...canonicalEntryActionHeaders(groups)]).toEqual(slices);
  });

  it.each([false, true])("prefers an assistant thinking header over a shared skill-only header (skill first: %s)", (skillFirst) => {
    const thinking: ChatLine = { role: "assistant", entryId: "shared", parts: [{ type: "thinking", text: "checkpoint" }] };
    const skill: ChatLine = { role: "assistant", entryId: "shared", parts: [{ type: "skillRead", name: "example", path: "/skills/example/SKILL.md" }] };
    const groups = groupChatMessages(skillFirst ? [skill, thinking] : [thinking, skill]);
    const slices = renderedMessages(groups);

    expect([...canonicalEntryActionHeaders(groups)]).toEqual(slices.filter((message) => message.role === "assistant"));
    expect(slices.some((message) => message.role === "skill")).toBe(true);
  });

  it("selects a reply after shared skill/thinking slices and keeps stable first-header ties", () => {
    const groups = groupChatMessages([
      { role: "assistant", entryId: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "skillRead", name: "example", path: "/skills/example/SKILL.md" }] },
      { ...text("assistant", "reply"), entryId: "assistant" },
      { ...text("assistant", "another slice"), entryId: "assistant" },
      { role: "user", entryId: "user", parts: [{ type: "skillInvocation", name: "example", location: "/skills/example", content: "instructions" }] },
      { ...text("user", "request"), entryId: "user" },
      { ...text("user", "another request slice"), entryId: "user" },
      { role: "skill", entryId: "skill-only", parts: [{ type: "skillRead", name: "example", path: "/skills/example/SKILL.md" }] },
      { role: "assistant", entryId: "assistant", parts: [{ type: "thinking", text: "later technical slice" }] },
    ]);
    const slices = renderedMessages(groups);

    expect([...canonicalEntryActionHeaders(groups)]).toEqual([slices[2], slices[5], slices[7]]);
  });

  it("selects the rendered tool-image header over its technical result", () => {
    const groups = groupChatMessages([{ role: "tool", entryId: "image", parts: [
      { type: "toolResult", toolName: "read", text: "image result", isError: false },
      { type: "image", mimeType: "image/png", data: "QUJD" },
    ] }]);

    expect([...canonicalEntryActionHeaders(groups)]).toEqual([renderedMessages(groups)[1]]);
  });

  it("skips headerless tool/ask shells and entryless slices without letting them steal a shared entry", () => {
    const execution: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "file", status: "success" }] };
    const ask: ChatLine = { role: "tool", parts: [{ type: "askUserRecord", outcome: {
      askId: "ask", reason: "submitted", askedAt: "2026-07-20T10:00:00.000Z", closedAt: "2026-07-20T10:01:00.000Z",
      questions: [], answeredCount: 0, unansweredIds: [], summary: "No answers",
    } }] };
    const groups = groupChatMessages([
      { ...execution, entryId: "shared" },
      { ...ask, entryId: "shared" },
      { role: "tool", entryId: "shared", parts: [{ type: "toolResult", toolName: "read", text: "legacy result", isError: false }] },
      { ...execution, entryId: "tool-only" },
      { ...ask, entryId: "ask-only" },
      text("assistant", "streaming"),
    ]);
    const slices = renderedMessages(groups);

    expect([...canonicalEntryActionHeaders(groups)]).toEqual([slices[2]]);
    expect(canonicalEntryActionHeaders([]).size).toBe(0);
  });
});

describe("summarizeChatGroup", () => {
  it("summarizes special event groups", () => {
    expect(summarizeChatGroup([{ ...text("assistant", "a"), source: "compaction" }])).toBe("1 history compaction summary");
    expect(summarizeChatGroup([
      { ...text("assistant", "a"), source: "branch_summary" },
      { ...text("assistant", "b"), source: "branch_summary" },
    ])).toBe("2 branch summaries");
  });

  it("summarizes mixed groups by role counts", () => {
    expect(summarizeChatGroup([text("tool", "a"), text("system", "b"), text("tool", "c")])).toBe("3 events · 2 tool · 1 system");
  });
});
