// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { ChatView } from "./ChatView";
import type { ChatLine } from "./shared";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
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
    const conversation = Array.from({ length: 20 }, (_, index) => textMessage(index % 2 === 0 ? "user" : "assistant", `message ${String(index)}`));
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
