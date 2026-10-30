// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";
import { applyTranscriptEvent } from "../chatTranscript";
import type { ChatLine } from "./shared";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

function textMessage(role: ChatLine["role"], text: string): ChatLine {
  return { role, parts: [{ type: "text", text }] };
}

async function settle(view: ChatView): Promise<void> {
  await view.updateComplete;
  await view.updateComplete;
}

function transcript(view: ChatView): HTMLElement {
  const element = view.shadowRoot?.querySelector<HTMLElement>(".chat");
  if (element === undefined || element === null) throw new Error("Missing rendered transcript");
  return element;
}

describe("transcript DOM ownership", () => {
  it("keeps retained nodes bounded over 200 switches between differently shaped sessions", async () => {
    const view = new ChatView();
    document.body.append(view);
    // A small conversation still grows/shrinks repeat against the grouped tool turn;
    // 200 switches exercise retention without repeatedly testing Markdown rendering.
    const conversation = Array.from({ length: 4 }, (_, index) => textMessage(index % 2 === 0 ? "user" : "assistant", `message ${String(index)}`));
    const toolTurn = [textMessage("tool", "synthetic output"), textMessage("assistant", "tail")];
    const initialCounts = new Map<string, number>();
    const finalCounts = new Map<string, number>();

    for (let index = 0; index < 200; index += 1) {
      const plain = index % 2 === 0;
      view.sessionId = plain ? "conversation" : "tool-session";
      view.messages = plain ? conversation : toolTurn;
      view.messageStart = plain ? 0 : 9000;
      await settle(view);
      // Count all nodes, not just elements: retained empty repeat markers were
      // invisible to element-count checks. No exact Lit marker count is assumed.
      const count = transcript(view).childNodes.length;
      if (index < 2) initialCounts.set(view.sessionId, count);
      finalCounts.set(view.sessionId, count);
    }

    expect(initialCounts.size).toBe(2);
    expect([...initialCounts.values()].every((count) => count > 0)).toBe(true);
    expect(finalCounts).toEqual(initialCounts);
  });

  it.each(["session", "machine"] as const)("replaces transcript elements when the %s changes at the same message indices", async (identity) => {
    const view = new ChatView();
    view.machineId = "local";
    view.sessionId = "session-a";
    view.messages = [textMessage("user", "first session")];
    document.body.append(view);
    await settle(view);
    const previous = transcript(view).querySelector("article[data-index='0']");
    expect(previous).not.toBeNull();

    if (identity === "session") view.sessionId = "session-b";
    else view.machineId = "remote";
    view.messages = [textMessage("user", "different session context")];
    await settle(view);

    expect(previous?.isConnected).toBe(false);
    expect(transcript(view).querySelector("article[data-index='0']")).not.toBe(previous);
  });

  it.each([false, true])("retains streaming reply and event DOM on finalization (thinking: %s)", async (thinking) => {
    const view = new ChatView();
    view.sessionId = "streaming";
    view.messages = [
      { ...textMessage("user", "prompt"), entryId: "prompt-id" },
      { role: "assistant", parts: [
        ...(thinking ? [{ type: "thinking" as const, text: "reasoning" }] : []),
        { type: "text", text: "reply" },
      ] },
    ];
    document.body.append(view);
    await settle(view);
    const reply = transcript(view).querySelector("article[data-index='1']");
    const formatted = reply?.querySelector("formatted-text");
    const events = transcript(view).querySelector<HTMLDetailsElement>("details.event-group");
    if (thinking && events !== null) {
      events.open = true;
      events.dispatchEvent(new Event("toggle"));
      await settle(view);
    }
    const eventBody = events?.querySelector("section.group-msg");
    const thinkingText = eventBody?.querySelector("formatted-text");
    expect(reply).not.toBeNull();
    if (thinking) {
      expect(eventBody).toBeInstanceOf(HTMLElement);
      expect(thinkingText).toBeInstanceOf(HTMLElement);
    }

    view.messages = applyTranscriptEvent(view.messages, {
      type: "message.end",
      message: { role: "assistant", entryId: "reply-id", content: [
        ...(thinking ? [{ type: "thinking", thinking: "reasoning" }] : []),
        { type: "text", text: "reply" },
      ] },
    }) ?? view.messages;
    await settle(view);
    expect(transcript(view).querySelector("article[data-index='1']")).toBe(reply);
    expect(reply?.querySelector("formatted-text")).toBe(formatted);
    expect(reply?.getAttribute("data-scroll-anchor-id")).toContain("reply-id");
    if (thinking) {
      expect(transcript(view).querySelector("details.event-group")).toBe(events);
      expect(events?.querySelector("section.group-msg")).toBe(eventBody);
      expect(eventBody?.querySelector("formatted-text")).toBe(thinkingText);
    }

    // Durable identity continues to own the same node after a history prepend,
    // even when raw page offsets and normalized display indexes differ.
    view.messageStart = 0;
    view.messages = [{ ...textMessage("user", "earlier"), entryId: "earlier-id" }, ...view.messages];
    await settle(view);
    expect(transcript(view).querySelector("article[data-index='2']")).toBe(reply);
  });

  it("retains an expanded activity group and its existing children when earlier events merge into it", async () => {
    const view = new ChatView();
    view.sessionId = "session";
    view.messageStart = 10;
    const event: ChatLine = { role: "assistant", entryId: "existing", parts: [{ type: "thinking", text: "existing reasoning" }] };
    view.messages = [event, { ...textMessage("assistant", "answer"), entryId: "answer" }];
    document.body.append(view);
    await settle(view);
    const group = transcript(view).querySelector<HTMLDetailsElement>("details.event-group");
    if (group === null) throw new Error("Missing activity group");
    group.open = true;
    group.dispatchEvent(new Event("toggle"));
    await settle(view);
    const child = group.querySelector("section[data-index='10']");
    expect(child).not.toBeNull();

    view.messageStart = 9;
    view.messages = [{ role: "assistant", entryId: "earlier", parts: [{ type: "thinking", text: "earlier reasoning" }] }, ...view.messages];
    await settle(view);
    expect(transcript(view).querySelector("details.event-group")).toBe(group);
    expect(group.open).toBe(true);
    expect(group.querySelector("section[data-index='10']")).toBe(child);
  });

  it("replaces a committed message with a different entry at the same index", async () => {
    const view = new ChatView();
    view.messages = [{ ...textMessage("assistant", "first"), entryId: "first-id" }];
    document.body.append(view);
    await settle(view);
    const previous = transcript(view).querySelector("article");
    view.messages = [{ ...textMessage("assistant", "replacement"), entryId: "second-id" }];
    await settle(view);
    expect(transcript(view).querySelector("article")).not.toBe(previous);
  });

  it("reuses existing message elements during same-session updates and history prepends", async () => {
    const view = new ChatView();
    view.sessionId = "session-a";
    view.messageStart = 4;
    const prompt = textMessage("user", "current prompt");
    view.messages = [prompt, textMessage("assistant", "partial")];
    document.body.append(view);
    await settle(view);
    const currentPrompt = transcript(view).querySelector("article[data-index='4']");
    expect(currentPrompt).not.toBeNull();

    view.messages = [prompt, textMessage("assistant", "partial plus new text")];
    await settle(view);
    expect(transcript(view).querySelector("article[data-index='4']")).toBe(currentPrompt);

    view.messages = [textMessage("user", "earlier prompt"), textMessage("assistant", "earlier answer"), ...view.messages];
    view.messageStart = 2;
    await settle(view);
    expect(transcript(view).querySelector("article[data-index='2']")).not.toBeNull();
    expect(transcript(view).querySelector("article[data-index='4']")).toBe(currentPrompt);
  });
});
