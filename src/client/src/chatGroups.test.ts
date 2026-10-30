import { describe, expect, it } from "vitest";
import { canonicalEntryActionHeaders, groupChatMessages, groupConsecutiveImageOutputs, type ChatGroup } from "./chatGroups";
import type { ChatLine } from "./components/shared";
import type { ChatFallbackPart } from "./chatTypes";

const text = (role: ChatLine["role"], value: string): ChatLine => ({ role, parts: [{ type: "text", text: value }] });

describe("groupChatMessages", () => {
  it("groups custom fallbacks exactly like their original parts without an eligible renderer", () => {
    const parts: ChatFallbackPart[] = [
      { type: "thinking", text: "working" },
      { type: "text", text: "original", displayText: "transformed" },
      { type: "image", mimeType: "image/png", data: "QUJD" },
    ];
    const fallback: ChatLine = { role: "system", entryId: "card", meta: { timestamp: "2026-07-20T10:00:00.000Z" }, parts };
    const custom: ChatLine = { ...fallback, parts: [{
      type: "customMessage", customType: "extension.card", content: "raw", details: { card: true }, parts,
    }] };
    const before: ChatLine = { role: "assistant", parts: [{ type: "thinking", text: "before" }] };
    const after = text("assistant", "after");
    expect(groupChatMessages([before, custom, after], 10)).toEqual(groupChatMessages([before, fallback, after], 10));
    expect(groupChatMessages([custom], 10, (customType) => customType === "other.card"))
      .toEqual(groupChatMessages([fallback], 10));
    expect(custom.parts[0]?.type).toBe("customMessage");
  });

  it("keeps details-only cards invisible unless their custom type has an eligible renderer", () => {
    const card: ChatLine = { role: "system", entryId: "card", parts: [{
      type: "customMessage", customType: "extension.card", content: "", details: { ready: true }, parts: [],
    }] };
    expect(groupChatMessages([card], 10)).toEqual([]);
    expect(groupChatMessages([card], 10, (customType) => customType === "extension.card")).toEqual([
      { kind: "message", index: 10, message: card },
    ]);
  });

  it("groups technical parts until a readable message is encountered", () => {
    const messages: ChatLine[] = [
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "toolCall", toolName: "read", summary: "file" }] },
      text("assistant", "visible answer"),
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "ok", isError: false }] },
    ];

    expect(groupChatMessages(messages, 10)).toEqual([
      { kind: "group", startIndex: 10, endIndex: 10, messages: [{ index: 10, message: messages[0] }] },
      { kind: "message", index: 11, message: text("assistant", "visible answer") },
      { kind: "group", startIndex: 12, endIndex: 12, messages: [{ index: 12, message: messages[2] }] },
    ]);
  });

  it("keeps invisible chronology markers out of visual grouping and preserves absolute end indexes", () => {
    const first: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "first", isError: false }] };
    const last: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "last", isError: false }] };
    expect(groupChatMessages([
      first,
      { role: "tool", parts: [{ type: "toolResultBoundary", toolCallId: "first" }] },
      { role: "assistant", parts: [{ type: "empty" }] },
      last,
    ], 10)).toEqual([
      { kind: "group", startIndex: 10, endIndex: 13, messages: [{ index: 10, message: first }, { index: 13, message: last }] },
    ]);
  });

  it("splits mixed readable and technical parts from a single message", () => {
    const messages: ChatLine[] = [
      { role: "assistant", parts: [{ type: "thinking", text: "hidden" }, { type: "text", text: "shown" }] },
    ];

    expect(groupChatMessages(messages)).toEqual([
      { kind: "group", startIndex: 0, endIndex: 0, messages: [{ index: 0, message: { role: "assistant", parts: [{ type: "thinking", text: "hidden" }] } }] },
      { kind: "message", index: 0, message: { role: "assistant", parts: [{ type: "text", text: "shown" }] } },
    ]);
  });

  it("groups agent skill loading with the work leading to an answer", () => {
    const messages: ChatLine[] = [
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }] },
    ];

    expect(groupChatMessages(messages)).toEqual([
      { kind: "group", startIndex: 0, endIndex: 0, messages: [{ index: 0, message: messages[0] }] },
    ]);
  });

  it("keeps user-invoked skill content with the request rather than agent activity", () => {
    const invocation: ChatLine = { role: "user", parts: [{ type: "skillInvocation", name: "ux-writing", location: "/skills/ux-writing", content: "Instructions" }] };
    expect(groupChatMessages([invocation])).toEqual([{ kind: "message", index: 0, message: invocation }]);
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
        messages: [{ index: 0, message: { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "Read image file [image/png]", isError: false }] } }],
      },
      { kind: "tool-image", index: 0, message: { role: "tool", parts: [image] }, toolName: "read" },
    ]);
  });

  it("preserves image metadata when splitting technical and readable parts", () => {
    const meta = { timestamp: "2026-07-13T22:00:00.000Z" };
    const image = { type: "image" as const, mimeType: "image/webp", data: "QUJD" };
    const message: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "ok", isError: false }, image], meta };

    expect(groupChatMessages([message])).toEqual([
      { kind: "group", startIndex: 0, endIndex: 0, messages: [{ index: 0, message: { role: "tool", parts: [message.parts[0]], meta } }] },
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
      { kind: "group", startIndex: 0, endIndex: 0, messages: [{ index: 0, message: { role: "assistant", parts: [{ type: "thinking", text: "hidden" }], meta: message.meta } }] },
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

describe("groupConsecutiveImageOutputs", () => {
  const image = { type: "image" as const, mimeType: "image/png", data: "QUJD" };

  it("combines adjoining image outputs without losing source identities, metadata or absolute indexes", () => {
    const messages: ChatLine[] = [
      { role: "tool", entryId: "first", parts: [image, image], meta: { model: { id: "first-model" } } },
      { role: "tool", entryId: "second", parts: [image], meta: { model: { id: "second-model" } } },
      { role: "tool", entryId: "third", parts: [image] },
    ];
    const sourceGroups = groupChatMessages(messages, 20);
    const displayGroups = groupConsecutiveImageOutputs(sourceGroups);
    expect(displayGroups).toHaveLength(1);
    const gallery = displayGroups[0];
    if (gallery?.kind !== "tool-images") throw new Error("Expected combined image outputs");
    expect(gallery.outputs).toEqual(sourceGroups);
    expect(gallery.outputs.map((output) => output.index)).toEqual([20, 21, 22]);
    expect(gallery.outputs.map((output) => output.message.entryId)).toEqual(["first", "second", "third"]);
    expect(gallery.outputs[1]?.message.meta).toBe(messages[1]?.meta);
    expect(sourceGroups).toHaveLength(3);
    expect(sourceGroups[0]).toBe(gallery.outputs[0]);
  });

  it.each(["user", "assistant", "activity"] as const)("does not combine images across a %s boundary", (boundary) => {
    const between: ChatLine = boundary === "activity"
      ? { role: "assistant", parts: [{ type: "thinking", text: "Inspect another image" }] }
      : { role: boundary, parts: [image] };
    const displayGroups = groupConsecutiveImageOutputs(groupChatMessages([
      { role: "tool", entryId: "before", parts: [image] }, between,
      { role: "tool", entryId: "after", parts: [image] },
    ]));
    expect(displayGroups.map((group) => group.kind)).toEqual(["tool-images", boundary === "activity" ? "group" : "message", "tool-images"]);
  });
});

function renderedMessages(groups: readonly ChatGroup[]): ChatLine[] {
  return groups.flatMap((group) => group.kind === "group" ? group.messages.map((event) => event.message) : [group.message]);
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

    expect([...canonicalEntryActionHeaders(groups)]).toEqual([
      slices.find((message) => message.parts.some((part) => part.type === "text" && part.text === "reply")),
      slices.find((message) => message.parts.some((part) => part.type === "text" && part.text === "request")),
      slices.find((message) => message.entryId === "skill-only"),
    ]);
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

it("gives top-level question requests the canonical header while hiding coalesced result boundaries", () => {
  const question: ChatLine = { role: "tool", entryId: "question-result", parts: [{ type: "askUserQuestion", ask: {
    askId: "ask-1", askedAt: "2026-07-20T10:00:00.000Z", questions: [{ id: "q", question: "Choose?", options: [] }],
  } }] };
  const groups = groupChatMessages([
    { role: "tool", parts: [{ type: "toolExecution", toolName: "ask_user", summary: "questions", status: "success" }] },
    { ...question, parts: [{ type: "toolResult", toolName: "ask_user", text: "Posted questions", isError: false }, ...question.parts] },
    { role: "tool", parts: [{ type: "toolResultBoundary", toolCallId: "earlier" }] },
    text("user", "Continue"),
  ]);
  expect(groups.map((group) => group.kind)).toEqual(["group", "message", "message"]);
  expect(groups[1]).toEqual({ kind: "message", index: 1, message: question });
  expect([...canonicalEntryActionHeaders(groups)]).toEqual([renderedMessages(groups)[2]]);
});
