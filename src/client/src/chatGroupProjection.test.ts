import { describe, expect, it } from "vitest";
import { ChatGroupProjection } from "./chatGroupProjection";
import { groupChatMessages, groupConsecutiveImageOutputs, type ChatGroup } from "./chatGroups";
import type { ChatLine } from "./chatTypes";

const reply = (text: string): ChatLine => ({ role: "assistant", parts: [{ type: "text", text }] });
const activity = (text: string): ChatLine => ({ role: "assistant", parts: [{ type: "thinking", text }] });
const invisible: ChatLine = { role: "tool", parts: [{ type: "toolResultBoundary", toolCallId: "call" }] };
const image = (entryId: string): ChatLine => ({ role: "tool", entryId, parts: [{ type: "image", mimeType: "image/png", data: "QUJD" }] });
const mixed: ChatLine = {
  role: "assistant", entryId: "mixed", meta: { timestamp: "2026-07-24T12:00:00Z" },
  parts: [{ type: "thinking", text: "plan" }, { type: "text", text: "answer" }],
};

function slices(groups: ChatGroup[]): ChatLine[] {
  return groups.flatMap((group) => group.kind === "group" ? group.messages.map((event) => event.message) : [group.message]);
}

describe("ChatGroupProjection", () => {
  it("keeps historical groups and slices stable when a streaming tail is replaced or appended", () => {
    const projection = new ChatGroupProjection();
    const history = [reply("request"), activity("work"), invisible, mixed];
    const before = projection.update([...history, activity("stream")], 20);
    const after = projection.update([...history, activity("streaming"), reply("done")], 20);

    expect(after).toEqual(groupChatMessages([...history, activity("streaming"), reply("done")], 20));
    expect(after.slice(0, 3)).toHaveLength(3);
    for (let index = 0; index < 3; index++) expect(after[index]).toBe(before[index]);
    expect(after[3]).not.toBe(before[3]);
    expect(slices(after).slice(0, 4)).toEqual(slices(before).slice(0, 4));
    for (let index = 0; index < 4; index++) expect(slices(after)[index]).toBe(slices(before)[index]);
    expect(before).toEqual(groupChatMessages([...history, activity("stream")], 20));
  });

  it("reopens trailing activity across invisible markers without duplicating mixed slices", () => {
    const projection = new ChatGroupProjection();
    const first = activity("first");
    const history = [mixed, first, invisible];
    const before = projection.update(history, 8);
    const next = [...history, activity("second"), invisible];
    const after = projection.update(next, 8);

    expect(after).toEqual(groupChatMessages(next, 8));
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect(slices(after)[2]).toBe(slices(before)[2]);
    expect(projection.update([...next, reply("finished")], 8)[2]).toBe(after[2]);
  });

  it("falls back correctly on prepends, changed offsets and arbitrary middle replacement", () => {
    const projection = new ChatGroupProjection();
    const history = [mixed, activity("work"), invisible, reply("answer"), image("image")];
    const initial = projection.update(history, 10);
    const initialSlices = slices(initial);
    const prepended = [reply("older"), ...history];
    const afterPrepend = projection.update(prepended, 9);
    expect(afterPrepend).toEqual(groupChatMessages(prepended, 9));
    initial.forEach((group, index) => { expect(afterPrepend[index + 1]).toBe(group); });

    const shifted = projection.update(prepended, 30);
    expect(shifted).toEqual(groupChatMessages(prepended, 30));
    initial.forEach((group, index) => { expect(shifted[index + 1]).not.toBe(group); });
    initialSlices.forEach((slice, index) => { expect(slices(shifted)[index + 1]).toBe(slice); });

    const replaced = [...prepended];
    replaced[2] = reply("activity became readable");
    const afterReplacement = projection.update(replaced, 30);
    expect(afterReplacement).toEqual(groupChatMessages(replaced, 30));
    expect(afterReplacement.at(-1)).toBe(shifted.at(-1));
    expect(afterReplacement.at(-2)).toBe(shifted.at(-2));
    expect(projection.update([], 30)).toEqual([]);
    expect(projection.getDisplayGroups()).toEqual([]);
    expect(projection.update(history, 10)).toEqual(groupChatMessages(history, 10));
  });

  it("does not treat equal content in a replacement source as the old immutable slice", () => {
    const projection = new ChatGroupProjection();
    const source = reply("same");
    const before = projection.update([source]);
    const after = projection.update([{ ...source }]);
    expect(after).toEqual(before);
    expect(after[0]).not.toBe(before[0]);
    expect(slices(after)[0]).not.toBe(slices(before)[0]);
  });

  it("returns the same projection for unchanged inputs and invisible-only tail changes", () => {
    const projection = new ChatGroupProjection();
    const messages = [mixed, activity("work")];
    const before = projection.update(messages);
    expect(projection.update(messages)).toBe(before);
    expect(projection.update([...messages])).toBe(before);
    expect(projection.update([...messages, invisible])).toBe(before);
    expect(projection.update(messages)).toBe(before);
  });

  it("preserves galleries across tail updates but replaces changed gallery membership", () => {
    const projection = new ChatGroupProjection();
    const first = image("first");
    const second = image("second");
    const boundary = reply("boundary");
    const history = [first, second, boundary];
    const groups = projection.update([...history, reply("stream")]);
    const display = projection.getDisplayGroups();
    expect(display).toEqual(groupConsecutiveImageOutputs(groups));
    expect(projection.getDisplayGroups()).toBe(display);

    const updated = projection.update([...history, reply("streaming")]);
    const after = projection.getDisplayGroups();
    expect(after).toEqual(groupConsecutiveImageOutputs(updated));
    expect(after[0]).toBe(display[0]);
    expect(after[1]).toBe(display[1]);
    expect(after[2]).not.toBe(display[2]);

    const added = [first, second, image("third"), boundary];
    projection.update(added);
    const extended = projection.getDisplayGroups();
    expect(extended).toEqual(groupConsecutiveImageOutputs(groupChatMessages(added)));
    expect(extended[0]).not.toBe(after[0]);
    expect(display).toEqual(groupConsecutiveImageOutputs(groups));
    projection.update([first, activity("boundary"), second]);
    expect(projection.getDisplayGroups().map((group) => group.kind)).toEqual(["tool-images", "group", "tool-images"]);
  });

  it("matches stateless grouping through boundary changes, truncation and repeated source objects", () => {
    const projection = new ChatGroupProjection();
    const skill: ChatLine = { role: "assistant", parts: [{ type: "skillRead", name: "test", path: "/skills/test" }] };
    const summary: ChatLine = { ...reply("summary"), source: "compaction" };
    const tool: ChatLine = { ...image("tool"), parts: [{ type: "toolResult", toolName: "read", text: "image", isError: false }, ...image("tool").parts] };
    const states = [
      [invisible], [activity("start"), invisible], [mixed, skill, summary, tool],
      [mixed, mixed, invisible, tool], [mixed, invisible], [invisible, mixed], [],
    ];
    for (const messages of states) {
      expect(projection.update(messages, 5)).toEqual(groupChatMessages(messages, 5));
      expect(projection.getDisplayGroups()).toEqual(groupConsecutiveImageOutputs(groupChatMessages(messages, 5)));
    }
  });
});
