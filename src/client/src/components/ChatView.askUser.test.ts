// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskUserOutcome, AskUserRequest } from "../../../shared/apiTypes";
import { ASK_USER_ANSWERS_CUSTOM_TYPE } from "../../../shared/apiTypes";
import { normalizeMessages, textMessage } from "../chatMessages";
import { applyTranscriptEvent } from "../chatTranscript";
import type { ChatLine } from "./shared";
import { controlledChatViewport, manualChatFrames } from "./chatScroll.testSupport";
import { AskUserCard } from "./AskUserCard";
import { ChatView } from "./ChatView";

const ask: AskUserRequest = {
  askId: "ask-open", askedAt: "2026-07-20T10:00:00.000Z",
  questions: [
    { id: "editor", question: "Which editor?", detail: "Used in examples.", options: [
      { value: "vim", label: "Vim", detail: "Modal editor" }, { value: "code", label: "VS Code", detail: "Graphical editor" },
    ] },
    { id: "region", question: "Which region?", options: [{ value: "eu", label: "Europe" }] },
  ],
};
const questionResult = { role: "toolResult", toolName: "ask_user", toolCallId: "ask-call", isError: false,
  content: [{ type: "text", text: "Questions posted" }], details: { ask }, entryId: "ask-entry" };
const questionHistory = [
  { role: "assistant", content: [{ type: "toolCall", id: "ask-call", name: "ask_user", arguments: { questions: ask.questions } }] },
  questionResult,
];
const outcome: AskUserOutcome = {
  askId: ask.askId, reason: "submitted", askedAt: ask.askedAt, closedAt: "2026-07-20T10:05:00.000Z",
  questions: ask.questions.map((question) => ({ question, answered: question.id === "editor", values: question.id === "editor" ? ["vim"] : [] })),
  answeredCount: 1, unansweredIds: ["region"], summary: "Answered 1 of 2; unanswered: region",
};

afterEach(() => {
  document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("ChatView conversation-first questions", () => {
  it("opens a question from reloaded history at its original, top-level transcript position", async () => {
    const view = await mountView(normalizeMessages(questionHistory));
    const card = await questionCard(view);
    expect(card.ask).toEqual(ask);
    expect(card.open).toBe(true);
    expect(card.draftSessionId).toBe("remote-a:session-1");
    expect(card.closest(".event-group")).toBeNull();
    expect(card.parentElement?.getAttribute("data-scroll-anchor-id")).toBe('m:["ask-entry","tool","message"]');
    expect(card.shadowRoot?.querySelector("form")).not.toBeNull();
    expect(view.shadowRoot?.querySelectorAll("ask-user-card")).toHaveLength(1);
  });

  it("omits scroll anchors for question cards without durable entry identity", async () => {
    const view = await mountView(normalizeMessages(questionHistory).map((message) => ({ ...message, entryId: "" })));
    const card = await questionCard(view);
    expect(card.parentElement?.hasAttribute("data-scroll-anchor-id")).toBe(false);
    expect(view.renderRoot.querySelector("[data-scroll-anchor-id]")).toBeNull();
  });

  it("scrolls a newly discovered question form to its start", async () => {
    const flush = manualChatFrames();
    const view = await mountView([]);
    const { metrics, write } = controlledChatViewport(view);
    flush(); write.mockClear(); metrics.height = 2600;
    view.messages = normalizeMessages(questionHistory);
    await view.updateComplete;
    const form = await questionCard(view);
    vi.spyOn(form, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 400, 600, 800));
    flush();
    expect(write).toHaveBeenCalledExactlyOnceWith(2000);
    expect(form.classList.contains("open-question-card")).toBe(true);
  });

  it.each([
    { messageEnd: 2, messageTotal: 3, historyReady: true, writable: true },
    { messageEnd: 2, messageTotal: 2, historyReady: false, writable: true },
    { messageEnd: 2, messageTotal: 2, historyReady: true, writable: false },
  ])("does not expose controls for earlier pages, unready history or archived sessions (%j)", async (context) => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = normalizeMessages(questionHistory);
    view.messageEnd = context.messageEnd;
    view.messageTotal = context.messageTotal;
    view.historyReady = context.historyReady;
    view.onSubmitAsk = context.writable ? vi.fn() : undefined;
    document.body.append(view);
    await view.updateComplete;
    const card = await questionCard(view);
    expect(card.open).toBe(false);
    expect(card.onSubmit).toBeUndefined();
    expect(card.shadowRoot?.querySelector("input, textarea, button, select")).toBeNull();
    expect(card.shadowRoot?.querySelector("details")?.open).toBe(false);
  });

  it.each<ChatLine>([
    textMessage("user", "Continue without answering"),
    textMessage("assistant", "A streamed continuation"),
    textMessage("system", "Child session completed"),
  ])("closes in place on later $role text and retains full historical options and draft", async (later) => {
    const view = await mountView(normalizeMessages(questionHistory));
    const original = await questionCard(view);
    requiredElement(original.shadowRoot?.querySelector<HTMLInputElement>('input[value="vim"]'), "Vim option").click();
    await original.updateComplete;
    view.messages = [...view.messages, later];
    await view.updateComplete;
    const closed = await questionCard(view);
    expect(closed).toBe(original);
    expect(closed.open).toBe(false);
    expect(closed.onSubmit).toBeUndefined();
    const root = requiredElement(closed.shadowRoot, "closed shadow root");
    expect(root.querySelector("details")?.open).toBe(false);
    expect(root.textContent).toContain("Draft answer · not sent");
    expect(root.textContent).toContain("Vim");
    expect(root.textContent).toContain("VS Code");
    expect(root.textContent).toContain("Modal editor");
    expect(root.textContent).toContain("Graphical editor");
    expect(root.textContent).toContain("Used in examples.");
    expect(root.querySelector("input, textarea, button, select")).toBeNull();
    const rows = [...(view.shadowRoot?.querySelectorAll(".chat > article") ?? [])];
    expect(rows[0]?.contains(closed)).toBe(true);
    expect(rows[1]?.contains(closed)).toBe(false);
  });

  it("opens only a later question while retaining the old collapsed question", async () => {
    const view = await mountView(normalizeMessages(questionHistory));
    const newer = { ...ask, askId: "ask-next" };
    view.messages = [...view.messages, { role: "tool", parts: [{ type: "askUserQuestion", ask: newer }] }];
    await view.updateComplete;
    const cards = [...(view.shadowRoot?.querySelectorAll<AskUserCard>("ask-user-card") ?? [])];
    await Promise.all(cards.map((card) => card.updateComplete));
    expect(cards.map((card) => card.open)).toEqual([false, true]);
  });

  it("reconciles a partial response without duplicating it or recreating a question form at the reply position", async () => {
    const view = await mountView(normalizeMessages(questionHistory));
    const original = await questionCard(view);
    const rawReply = { role: "custom", customType: ASK_USER_ANSWERS_CUSTOM_TYPE, content: "Answers sent", details: outcome, entryId: "answer-1" };
    view.messages = applyTranscriptEvent(view.messages, { type: "message.append", message: rawReply }) ?? view.messages;
    view.messages = applyTranscriptEvent(view.messages, { type: "message.end", message: rawReply }) ?? view.messages;
    await view.updateComplete;
    const cards = [...(view.shadowRoot?.querySelectorAll<AskUserCard>("ask-user-card") ?? [])];
    await Promise.all(cards.map((card) => card.updateComplete));
    expect(cards).toHaveLength(2);
    expect(cards[0]).toBe(original);
    expect(original.open).toBe(false);
    expect(original.outcomes).toEqual([outcome]);
    expect(original.shadowRoot?.textContent).toContain("Vim");
    expect(original.shadowRoot?.textContent).toContain("VS Code");
    expect(original.shadowRoot?.textContent).toContain("Unanswered");
    expect(cards[1]?.compact).toBe(true);
    expect(cards[1]?.ask).toBeUndefined();
    expect(cards[1]?.shadowRoot?.textContent).toContain("Answers sent");
    expect(cards[1]?.shadowRoot?.querySelector("form, input, textarea, button")).toBeNull();
  });
});

it("keeps standalone historical response records readable when the original request is absent", async () => {
  const view = await mountView([{ role: "system", parts: [{ type: "askUserRecord", outcome }] }]);
  const card = await questionCard(view);
  expect(card.ask).toBeUndefined();
  expect(card.outcome).toEqual(outcome);
  expect(card.compact).toBe(false);
  expect(card.shadowRoot?.textContent).toContain("Vim");
  expect(card.shadowRoot?.textContent).toContain("VS Code");
  expect(card.shadowRoot?.textContent).toContain("Which region?");
  expect(card.shadowRoot?.querySelector("input, textarea, button, select")).toBeNull();
});

async function mountView(messages: ChatLine[]): Promise<ChatView> {
  const view = new ChatView();
  view.sessionId = "session-1";
  view.askDraftSessionId = "remote-a:session-1";
  view.onSubmitAsk = vi.fn();
  view.messages = messages;
  view.messageEnd = 2;
  view.messageTotal = 2;
  document.body.append(view);
  await view.updateComplete;
  return view;
}

async function questionCard(view: ChatView): Promise<AskUserCard> {
  const card = requiredElement(view.shadowRoot?.querySelector("ask-user-card"), "question card");
  expect(card).toBeInstanceOf(AskUserCard);
  await card.updateComplete;
  return card;
}

function requiredElement<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label}`);
  return value;
}
