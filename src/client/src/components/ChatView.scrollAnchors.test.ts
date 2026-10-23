// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { MANUAL_CHAT_BEHAVIORS } from "../chatBehaviors.testSupport";
import { ChatView } from "./ChatView";
import type { ChatLine } from "./shared";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

async function mount(messages: ChatLine[], live = false): Promise<ChatView> {
  const view = new ChatView();
  view.behaviors = MANUAL_CHAT_BEHAVIORS;
  view.messages = messages;
  view.isSendingPrompt = live;
  document.body.append(view);
  await view.updateComplete;
  return view;
}

function thought(entryId?: string): ChatLine {
  return { ...(entryId === undefined ? {} : { entryId }), role: "assistant", parts: [{ type: "thinking", text: "Thinking" }] };
}

describe("ChatView durable DOM scroll anchors", () => {
  it.each([false, true])("selects the durable group boundary, skipping unidentified members (live: %s)", async (live) => {
    const view = await mount([thought(), thought("first"), thought("last"), thought("")], live);
    const groupAnchor = view.renderRoot.querySelector("details.event-group")?.getAttribute("data-scroll-anchor-id");
    expect(groupAnchor).toBe(live
      ? 'g:["first","assistant","message"]'
      : 'g-end:["last","assistant","message"]');
    if (!live) {
      expect(view.renderRoot.querySelector("section.group-msg")).toBeNull();
      const group = view.renderRoot.querySelector<HTMLDetailsElement>("details.event-group");
      if (group === null) throw new Error("Missing group");
      group.open = true; group.dispatchEvent(new Event("toggle"));
      await view.updateComplete;
    }
    const members = Array.from(view.renderRoot.querySelectorAll("section.group-msg"));
    expect(members.map((member) => member.getAttribute("data-scroll-anchor-id"))).toEqual([
      null, 'e:["first","assistant","message"]', 'e:["last","assistant","message"]', null,
    ]);

    // New transient boundary members cannot change a group's scroll identity.
    view.messages = [thought(""), ...view.messages, thought()];
    view.messageStart = 100;
    await view.updateComplete;
    expect(view.renderRoot.querySelector("details.event-group")?.getAttribute("data-scroll-anchor-id"))
      .toBe(groupAnchor);
  });

  it.each([false, true])("omits anchors but still renders groups with no durable members (live: %s)", async (live) => {
    const view = await mount([thought(), thought("")], live);
    expect(view.renderRoot.querySelectorAll("section.group-msg")).toHaveLength(live ? 2 : 0);
    expect(view.renderRoot.querySelector("details.event-group")).not.toBeNull();
    expect(view.renderRoot.querySelector("[data-scroll-anchor-id]")).toBeNull();
  });

  it("renders unidentified readable messages and tool images without index anchors", async () => {
    const question: ChatLine = { role: "user", parts: [{ type: "text", text: "Question" }] };
    const image: ChatLine = { entryId: "", role: "tool", parts: [{ type: "image", mimeType: "image/png", data: "QUJD" }] };
    const view = await mount([question, image]);
    expect(view.renderRoot.querySelectorAll("article.msg")).toHaveLength(2);
    expect(view.renderRoot.querySelector("article.tool-image-output")).not.toBeNull();
    expect(view.renderRoot.querySelector("[data-scroll-anchor-id]")).toBeNull();

    view.messages = [{ ...question, entryId: "question" }, image];
    await view.updateComplete;
    expect(view.renderRoot.querySelector("article.user")?.getAttribute("data-scroll-anchor-id"))
      .toBe('m:["question","user","message"]');
    view.messages = [{ ...question, entryId: "" }, image];
    await view.updateComplete;
    expect(view.renderRoot.querySelector("[data-scroll-anchor-id]")).toBeNull();
  });

  it("keeps readable and technical slices of one durable entry distinct and compatible", async () => {
    const view = await mount([{ entryId: "reply", role: "assistant", parts: [
      { type: "thinking", text: "Thought" }, { type: "text", text: "Reply" },
    ] }]);
    const group = view.renderRoot.querySelector<HTMLDetailsElement>("details.event-group");
    if (group === null) throw new Error("Missing group");
    expect(group.getAttribute("data-scroll-anchor-id")).toBe('g-end:["reply","assistant","message"]');
    group.open = true; group.dispatchEvent(new Event("toggle"));
    await view.updateComplete;
    expect(Array.from(view.renderRoot.querySelectorAll("[data-scroll-anchor-id]"),
      (node) => node.getAttribute("data-scroll-anchor-id"))).toEqual([
      'g-end:["reply","assistant","message"]',
      'e:["reply","assistant","message"]',
      'm:["reply","assistant","message"]',
    ]);
  });
});
