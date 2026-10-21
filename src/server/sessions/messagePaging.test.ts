import { describe, expect, it } from "vitest";
import { expandStartToSafeBoundary, pageMessagesAtSafeBoundary } from "./messagePaging";

const user = (content: string) => ({ role: "user", content });
const assistantText = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const thinking = (text: string) => ({ role: "assistant", content: [{ type: "thinking", thinking: text }] });
const toolCall = (name: string) => ({ role: "assistant", content: [{ type: "toolCall", name }] });
const toolResult = (text: string) => ({ role: "toolResult", content: text });

function page(start: number, total: number, messages: unknown[]) {
  return { start, total, messages };
}

describe("message paging", () => {
  it("wraps the full history in a page when paging is not requested", () => {
    const messages = [user("hello")];
    expect(pageMessagesAtSafeBoundary(messages)).toEqual(page(0, 1, messages));
  });

  it("uses normal bounded paging when the requested start is already a turn boundary", () => {
    const messages = [user("a"), assistantText("b"), user("c")];
    expect(pageMessagesAtSafeBoundary(messages, { limit: 1 })).toEqual(page(2, 3, messages.slice(2)));
  });

  it("expands a page start backward to avoid splitting a turn", () => {
    const messages = [
      user("prompt"),
      thinking("plan"),
      toolCall("read"),
      toolResult("ok"),
      thinking("next"),
      assistantText("answer"),
    ];

    expect(pageMessagesAtSafeBoundary(messages, { before: 5, limit: 2 })).toEqual(page(0, 6, messages.slice(0, 5)));
  });

  it("does not split a readable assistant answer from its user prompt", () => {
    const messages = [user("prompt"), thinking("plan"), assistantText("answer")];
    expect(expandStartToSafeBoundary(messages, 2)).toBe(0);
  });

  it("applies hard message caps only when the caller explicitly requests them", () => {
    const messages = Array.from({ length: 502 }, (_, index) => ({ role: index === 0 ? "user" : "assistant", index }));
    expect(pageMessagesAtSafeBoundary(messages, { limit: 1 })).toMatchObject({ start: 0, total: 502 });
    expect(() => pageMessagesAtSafeBoundary(messages, { limit: 1, maxMessages: 500 })).toThrow("request a partial turn");
    expect(pageMessagesAtSafeBoundary(messages, { limit: 1, allowPartialTurn: true, maxMessages: 500 })).toMatchObject({ start: 501, total: 502, messages: [{ index: 501 }] });
  });
});
