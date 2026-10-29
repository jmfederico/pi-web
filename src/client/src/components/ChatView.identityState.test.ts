// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { ChatView } from "./ChatView";
import { normalizeMessages } from "../chatMessages";
import { applyTranscriptEvent, seedStreamingPartial } from "../chatTranscript";
import { ChatPresentationOwners } from "../chatPresentationOwners";
import { TranscriptUiState } from "../transcriptUiState";
import type { FormattedText } from "./FormattedText";
import type { ToolExecutionView } from "./ToolExecutionView";

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

it("restores tool choices after ChatView recreation without sharing sibling tool state", async () => {
  const uiState = new TranscriptUiState();
  const owners = new ChatPresentationOwners();
  const messages = normalizeMessages([{ role: "assistant", entryId: "entry", content: [
    { type: "toolCall", id: "a", name: "bash", arguments: { command: "first" } },
    { type: "toolCall", id: "b", name: "bash", arguments: { command: "second" } },
  ] }]);
  const mount = async () => {
    const view = new ChatView();
    view.sessionId = "session";
    view.messages = messages;
    view.uiState = uiState;
    view.presentationOwners = owners;
    document.body.append(view);
    await settle(view);
    await openActivity(view);
    const tools = [...view.renderRoot.querySelectorAll<ToolExecutionView>("tool-execution-view")];
    await Promise.all(tools.map((tool) => tool.updateComplete));
    return { view, tools };
  };
  const first = await mount();
  expect(first.tools).toHaveLength(2);
  expect(first.tools[0]?.stateKey).not.toBe(first.tools[1]?.stateKey);
  const details = first.tools[0]?.renderRoot.querySelector<HTMLDetailsElement>("details.text-body");
  if (details === null || details === undefined) throw new Error("Missing tool details");
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  await first.tools[0]?.updateComplete;
  first.view.remove();
  const restored = await mount();
  expect(restored.tools[0]?.renderRoot.querySelector<HTMLDetailsElement>("details.text-body")?.open).toBe(true);
  expect(restored.tools[1]?.renderRoot.querySelector<HTMLDetailsElement>("details.text-body")?.open).toBe(false);
});
