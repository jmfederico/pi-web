import { describe, expect, it } from "vitest";
import { pageMessages } from "./messagePaging";

const user = (content: string) => ({ role: "user", content });
const assistantText = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const thinking = (text: string) => ({ role: "assistant", content: [{ type: "thinking", thinking: text }] });
const toolCall = (name: string) => ({ role: "assistant", content: [{ type: "toolCall", name }] });
const toolResult = (text: string) => ({ role: "toolResult", content: text });

function page(start: number, total: number, messages: unknown[]) {
  return { start, total, messages };
}

describe("message paging", () => {
  it("returns the whole transcript when it is smaller than the limit", () => {
    const messages = [user("hello")];
    expect(pageMessages(messages)).toEqual(page(0, 1, messages));
  });

  it("does not trim a page that holds the whole transcript", () => {
    const messages = [assistantText("answer"), user("prompt")];

    expect(pageMessages(messages)).toEqual(page(0, 2, messages));
  });

  it("uses normal bounded paging when the requested start is already a turn boundary", () => {
    const messages = [user("a"), assistantText("b"), user("c")];
    expect(pageMessages(messages, { limit: 1 })).toEqual(page(2, 3, messages.slice(2)));
  });

  it("keeps the page within the requested limit when one turn is longer than the limit", () => {
    const messages = [user("prompt"), ...Array.from({ length: 619 }, (_value, index) => assistantText(`answer ${String(index)}`))];

    const result = pageMessages(messages, { limit: 100 });

    expect(result.messages).toHaveLength(100);
    expect(result).toEqual(page(520, 620, messages.slice(520)));
  });

  it("starts the page at the user turn that produced the messages it shows", () => {
    const messages = [user("first"), assistantText("a"), user("second"), assistantText("b"), assistantText("c")];

    expect(pageMessages(messages, { limit: 3 })).toEqual(page(2, 5, messages.slice(2)));
  });

  it("keeps the requested start when the next turn boundary is farther away than the lookahead", () => {
    const messages = [user("first"), assistantText("a"), assistantText("b"), assistantText("c"), user("second"), assistantText("d")];

    expect(pageMessages(messages, { limit: 1 })).toEqual(page(5, 6, messages.slice(5)));
  });

  it("bounds the page when the turn it shows started before the page window", () => {
    const messages = [
      user("prompt"),
      thinking("plan"),
      toolCall("read"),
      toolResult("ok"),
      thinking("next"),
      assistantText("answer"),
    ];

    expect(pageMessages(messages, { before: 5, limit: 2 })).toEqual(page(3, 6, messages.slice(3, 5)));
  });

  it("bounds the default page when no limit is requested", () => {
    const messages = [user("prompt"), ...Array.from({ length: 149 }, (_value, index) => assistantText(`answer ${String(index)}`))];

    const result = pageMessages(messages);

    expect(result.messages).toHaveLength(100);
    expect(result).toEqual(page(50, 150, messages.slice(50)));
  });
});
