import { describe, expect, it } from "vitest";
import { groupChatMessages, type ChatGroup } from "./chatGroups";
import { normalizeMessage, normalizeMessages, textMessage } from "./chatMessages";
import { chatLinePresentationIdentity, chatPartIdentity } from "./chatPresentationIdentity";
import { applyTranscriptEvent, seedStreamingPartial } from "./chatTranscript";
import type { ChatLine, ChatPart } from "./chatTypes";

function slices(groups: ChatGroup[]): ChatLine[] {
  return groups.flatMap((group) => group.kind === "group" ? group.messages.map(({ message }) => message) : [group.message]);
}

function identities(lines: ChatLine[]): (string | undefined)[] {
  return lines.flatMap((line) => line.parts.map((part) => chatPartIdentity(line, part)));
}

describe("chat presentation identity", () => {
  it("addresses original parts before filtering and preserves them through grouping", () => {
    const lines = normalizeMessages([{ role: "assistant", entryId: "entry", streamId: "live", content: [
      { type: "text", text: "" },
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "more" },
      { type: "text", text: "another answer" },
    ] }]);
    expect(lines[0]?.parts.map((part) => part.sourcePart)).toEqual(["content:1", "content:2", "content:3", "content:4"]);
    const grouped = slices(groupChatMessages(lines, 30));
    expect(grouped.map((line) => line.streamId)).toEqual(["live", "live"]);
    expect(grouped.map(chatLinePresentationIdentity)).toEqual([
      JSON.stringify(["entry", "entry", "content:1"]), JSON.stringify(["entry", "entry", "content:2"]),
    ]);
    expect(new Set(identities(grouped))).toEqual(new Set(identities(lines)));
    expect(slices(groupChatMessages([...lines], 10)).map(chatLinePresentationIdentity))
      .toEqual(grouped.map(chatLinePresentationIdentity));
    const restored: unknown = JSON.parse(JSON.stringify(lines));
    if (!Array.isArray(restored)) throw new Error("Expected serialized transcript array");
    expect(normalizeMessages(restored)).toEqual(lines);
  });

  it("keeps multiple tools in one entry distinct through result coalescing", () => {
    const lines = normalizeMessages([
      { role: "assistant", entryId: "entry", content: [
        { type: "toolCall", id: "a", name: "bash", arguments: {} },
        { type: "toolCall", id: "b", name: "bash", arguments: {} },
        { type: "toolCall", name: "bash", arguments: {} },
      ] },
      { role: "toolResult", toolCallId: "a", toolName: "bash", content: "done" },
    ]);
    expect(identities(lines)).toEqual([
      JSON.stringify(["tool", "a"]), JSON.stringify(["tool", "b"]), JSON.stringify(["entry", "entry", "content:2"]),
    ]);
    expect(lines.map((line) => line.parts[0]?.sourcePart)).toEqual(["content:0", "content:1", "content:2"]);
    expect(lines[0]?.parts[0]).toMatchObject({ type: "toolExecution", status: "success" });
  });

  it("gives skill-derived lines and model errors their own addresses", () => {
    const skill = normalizeMessage({ role: "user", entryId: "entry", content: '<skill name="demo" location="/demo">\nInstructions\n</skill>\n\nDo this' });
    expect(skill.map(chatLinePresentationIdentity)).toEqual([
      JSON.stringify(["entry", "entry", "content:0:skill"]), JSON.stringify(["entry", "entry", "content:0:user"]),
    ]);
    const failed = normalizeMessage({ role: "assistant", entryId: "entry", content: "partial", stopReason: "error" });
    expect(failed.map(chatLinePresentationIdentity)).toEqual([
      JSON.stringify(["entry", "entry", "content:0"]), JSON.stringify(["entry", "entry", "model-error"]),
    ]);
  });

  it("retains seeded original keys on deltas and uses final original indexes rather than projected indexes", () => {
    const partial = { role: "assistant", streamId: "live", content: [
      { type: "text", text: "" }, { type: "thinking", thinking: "plan" }, { type: "text", text: "reply" },
    ] };
    const seeded = seedStreamingPartial([], partial);
    const updated = applyTranscriptEvent(seeded, { type: "assistant.delta", streamId: "live", text: " continued" }) ?? [];
    expect(identities(updated)).toEqual(identities(seeded));
    expect(updated[0]?.parts[1]).toEqual({ type: "text", text: "reply continued", sourcePart: "content:2" });
    const final = { ...partial, entryId: "saved", content: [...partial.content.slice(0, 2), { type: "text", text: "final" }] };
    const ended = applyTranscriptEvent(updated, { type: "message.end", message: final }) ?? [];
    expect(ended).toEqual(normalizeMessages([final]));
    expect(ended[0]?.streamId).toBe("live");
    expect(ended[0]?.parts.map((part) => part.sourcePart)).toEqual(["content:1", "content:2"]);
    expect(identities(ended)).not.toEqual(identities(seeded)); // caller owns stream-to-entry aliasing
  });

  it("keeps successive answers to one ask distinct even when their content is identical", () => {
    const part: ChatPart = { type: "askUserRecord", outcome: {
      askId: "ask", reason: "submitted", askedAt: "now", closedAt: "later",
      questions: [], answeredCount: 0, unansweredIds: [], summary: "skipped",
    } };
    const first: ChatLine = { role: "tool", entryId: "first", parts: [part] };
    const second: ChatLine = { ...first, entryId: "second" };
    expect(chatPartIdentity(first, part)).not.toBe(chatPartIdentity(second, part));
    expect(chatPartIdentity({ role: "tool", parts: [part] }, part)).toBeUndefined();
  });

  it("prefers semantic tool/ask IDs but does not invent addresses for manual or legacy text", () => {
    const line = textMessage("assistant", "legacy");
    expect(chatLinePresentationIdentity(line)).toBeUndefined();
    expect(chatLinePresentationIdentity({ ...line, entryId: "manual" })).toBeUndefined();
    expect(chatPartIdentity({ role: "assistant", parts: [] }, { type: "thinking", text: "x", sourcePart: "content:0" })).toBeUndefined();
    expect(chatLinePresentationIdentity({ role: "assistant", streamId: "empty", parts: [] })).toBeUndefined();
    const tool: ChatPart = { type: "skillRead", toolCallId: "call", name: "demo", path: "/demo" };
    expect(chatPartIdentity(line, tool)).toBe(JSON.stringify(["tool", "call"]));
    const ask: ChatPart = { type: "askUserQuestion", ask: { askId: "question", askedAt: "now", questions: [] } };
    expect(chatPartIdentity(line, ask)).toBe(JSON.stringify(["ask", "question"]));
    expect(normalizeMessages([{ role: "assistant", content: [{ type: "text", text: "legacy" }] }])).toEqual([line]);
  });
});
