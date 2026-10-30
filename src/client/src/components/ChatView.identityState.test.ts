// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { ChatView } from "./ChatView";
import { normalizeMessages } from "../chatMessages";
import { applyTranscriptEvent, seedStreamingPartial } from "../chatTranscript";
import type { FormattedText } from "./FormattedText";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

async function settle(view: ChatView): Promise<void> {
  await view.updateComplete;
  await view.updateComplete;
}

async function openActivity(view: ChatView): Promise<HTMLDetailsElement> {
  const group = view.renderRoot.querySelector<HTMLDetailsElement>("details.event-group");
  if (group === null) throw new Error("Missing activity");
  group.open = true;
  group.dispatchEvent(new Event("toggle"));
  await settle(view);
  return group;
}

it("addresses original thinking and text parts independently after presentation splitting", async () => {
  const view = new ChatView();
  view.messages = normalizeMessages([{ role: "assistant", entryId: "entry", content: [
    { type: "thinking", thinking: "same" }, { type: "text", text: "same" },
  ] }]);
  document.body.append(view);
  await settle(view);
  await openActivity(view);
  const parts = [...view.renderRoot.querySelectorAll<FormattedText>("formatted-text")];
  expect(parts).toHaveLength(2);
  expect(new Set(parts.map((part) => part.intentKey)).size).toBe(2);
});

it("keeps renderer ownership and a closed thinking choice when the stream gains its durable identity", async () => {
  const view = new ChatView();
  view.sessionId = "session";
  const partial = { role: "assistant", streamId: "stream", content: [
    { type: "thinking", thinking: "plan" }, { type: "text", text: "reply" },
  ] };
  view.messages = seedStreamingPartial([], partial);
  document.body.append(view);
  await settle(view);
  const group = await openActivity(view);
  const thinking = group.querySelector<HTMLDetailsElement>("details.thinking");
  if (thinking === null) throw new Error("Missing thinking");
  thinking.open = false;
  thinking.dispatchEvent(new Event("toggle"));
  await settle(view);
  const reply = view.renderRoot.querySelector<FormattedText>("article formatted-text");
  if (reply === null) throw new Error("Missing reply");
  const owner = reply.intentKey;

  view.messages = applyTranscriptEvent(view.messages, { type: "message.end", message: { ...partial, entryId: "entry" } }) ?? [];
  await settle(view);
  expect(view.renderRoot.querySelector("article formatted-text")).toBe(reply);
  expect(reply.intentKey).toBe(owner);
  expect(group.querySelector("details.thinking")).toBe(thinking);
  expect(thinking.open).toBe(false);

  const restored = new ChatView();
  restored.sessionId = "session";
  restored.messages = normalizeMessages([{ ...partial, streamId: undefined, entryId: "entry" }]);
  view.remove();
  document.body.append(restored);
  await settle(restored);
  const restoredGroup = await openActivity(restored);
  expect(restoredGroup.querySelector<HTMLDetailsElement>("details.thinking")?.open).toBe(false);
});
