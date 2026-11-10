// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import type { AskUserRequest } from "../../../shared/apiTypes";
import { DEFAULT_CHAT_BEHAVIORS } from "../chatBehaviors";
import { AskUserCard, type AskUserSubmitCallback } from "./AskUserCard";
import { ChatView } from "./ChatView";
import { ConversationLayout } from "./ConversationLayout";

const ask: AskUserRequest = {
  askId: "questions", askedAt: "2026-07-20T10:00:00.000Z",
  questions: [
    { id: "choice", question: "Which option?", options: [{ value: "a", label: "Option A" }] },
    { id: "text", question: "Any details?", options: [] },
  ],
};

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing fixture element");
  return value;
}

async function mount(onSubmit: AskUserSubmitCallback = vi.fn<AskUserSubmitCallback>()) {
  const layout = new ConversationLayout();
  const chat = new ChatView();
  chat.behaviors = { ...DEFAULT_CHAT_BEHAVIORS, followTail: false, rememberPosition: false, automaticHistory: false };
  chat.sessionId = "session";
  chat.askDraftSessionId = "local:session";
  chat.onSubmitAsk = onSubmit;
  chat.onQuestionActionsChange = (actions) => { layout.questionActions = actions; };
  const composer = document.createElement("input");
  composer.slot = "composer";
  composer.value = "Unsent chat draft";
  layout.onChatMode = () => { composer.focus(); };
  layout.append(chat, composer);
  document.body.append(layout);
  chat.messages = [{ role: "tool", parts: [{ type: "askUserQuestion", ask }] }];
  async function settle() {
    await chat.updateComplete;
    for (const card of chat.renderRoot.querySelectorAll<AskUserCard>("ask-user-card")) await card.updateComplete;
    await layout.updateComplete;
  }
  await settle();
  const card = required(chat.renderRoot.querySelector<AskUserCard>("ask-user-card"));
  const dock = required(layout.shadowRoot);
  const root = required(card.shadowRoot);
  const toggle = () => { required(dock.querySelector<HTMLButtonElement>(".question-mode button")).click(); };
  const button = (selector: string) => required(dock.querySelector<HTMLButtonElement>(selector));
  const chatHidden = () => required(dock.querySelector<HTMLElement>(".chat-composer")).hidden;
  const type = (text: string) => {
    const input = required(root.querySelector<HTMLTextAreaElement>("textarea"));
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input;
  };
  return { layout, chat, card, root, dock, composer, settle, toggle, button, chatHidden, type };
}

it("docks answer actions instead of chat, preserves both drafts, and returns to answers when edited", async () => {
  const submit = vi.fn<AskUserSubmitCallback>();
  const h = await mount(submit);
  expect(h.chatHidden()).toBe(true);
  expect(h.dock.querySelector(".chat-composer")?.hasAttribute("inert")).toBe(true);
  expect(h.root.querySelector(".form-footer")).toBeNull();
  h.type("Retained answer");
  await h.settle();
  h.toggle();
  await h.settle();
  expect(h.chatHidden()).toBe(false);
  expect(required(h.dock.querySelector<HTMLElement>(".question-actions")).hidden).toBe(true);
  expect(document.activeElement).toBe(h.composer);
  expect(submit).not.toHaveBeenCalled();
  h.toggle();
  await h.settle();
  expect(h.chatHidden()).toBe(true);
  expect(h.root.querySelector("textarea")?.value).toBe("Retained answer");
  expect(h.composer.value).toBe("Unsent chat draft");
  h.toggle();
  await h.settle();
  const input = h.type("Edited answer");
  input.focus();
  await h.settle();
  expect(h.chatHidden()).toBe(true);
  expect(h.root.activeElement).toBe(input);
  h.toggle();
  await h.settle();
  required(h.root.querySelector<HTMLInputElement>('input[value="a"]')).click();
  await h.settle();
  expect(h.chatHidden()).toBe(true);
  h.button(".primary-action").click();
  await h.settle();
  expect(submit).toHaveBeenCalledExactlyOnceWith("questions", { answers: [
    { id: "choice", values: ["a"] }, { id: "text", values: [], otherText: "Edited answer" },
  ] });
});

it("keeps partial confirmation and its focus in the dock, and returns editing focus to the question", async () => {
  const submit = vi.fn<AskUserSubmitCallback>();
  const h = await mount(submit);
  h.type("Only this answer");
  await h.settle();
  h.button(".primary-action").click();
  await h.settle();
  expect(submit).not.toHaveBeenCalled();
  expect(h.dock.activeElement).toBe(h.button(".send-anyway"));
  h.button(".confirmation-actions .secondary-action").click();
  await h.settle();
  expect(h.root.activeElement).toBe(h.root.querySelector("input"));
  h.button(".primary-action").click();
  await h.settle();
  h.button(".send-anyway").click();
  await h.settle();
  expect(submit).toHaveBeenCalledExactlyOnceWith("questions", { answers: [{ id: "text", values: [], otherText: "Only this answer" }] });
});

it("discards explicitly, prevents duplicate sends, and retains answers after a failed submission", async () => {
  let reject: (reason: Error) => void = () => undefined;
  const submit = vi.fn<AskUserSubmitCallback>(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const h = await mount(submit);
  h.type("Keep on failure");
  await h.settle();
  h.button(".skip-questions").click();
  await h.settle();
  expect(submit).toHaveBeenCalledExactlyOnceWith("questions", { answers: [] });
  expect(h.button(".skip-questions").disabled).toBe(true);
  expect(h.button(".primary-action").disabled).toBe(true);
  h.button(".skip-questions").click();
  expect(submit).toHaveBeenCalledTimes(1);
  reject(new Error("offline"));
  await vi.waitFor(() => { expect(h.button(".primary-action").disabled).toBe(false); });
  expect(h.root.querySelector("textarea")?.value).toBe("Keep on failure");
  expect(h.chatHidden()).toBe(true);
});

it("resets chat mode for a new request or session and restores chat when questions close", async () => {
  const h = await mount();
  h.toggle();
  await h.settle();
  h.chat.messages = [{ role: "tool", parts: [{ type: "askUserQuestion", ask: { ...ask, askId: "next" } }] }];
  await h.settle();
  expect(h.chatHidden()).toBe(true);
  h.toggle();
  await h.settle();
  h.chat.sessionId = "other-session";
  h.chat.askDraftSessionId = "remote:other-session";
  await h.settle();
  expect(h.chatHidden()).toBe(true);
  h.chat.messages = [...h.chat.messages, { role: "user", parts: [{ type: "text", text: "Continue in chat" }] }];
  await h.settle();
  expect(h.chatHidden()).toBe(false);
  expect(h.dock.querySelector(".question-mode")).toBeNull();
  expect(h.dock.querySelector(".primary-action")).toBeNull();
});
