import { ChatView } from "../../src/client/src/components/ChatView";
import { DEFAULT_CHAT_BEHAVIORS } from "../../src/client/src/chatBehaviors";
import type { ChatLine } from "../../src/client/src/components/shared";

const style = document.createElement("style");
style.textContent = `
  body { margin: 0; font: 16px system-ui; }
  chat-view { height: 480px; width: min(700px, 100vw); }
`;
document.head.append(style);

function message(index: number): ChatLine {
  return { entryId: `entry-${String(index)}`, role: "user", parts: [{ type: "text", text:
    `Message ${String(index)}. ` + "Readable transcript content with enough wrapping to exercise real layout. ".repeat(5),
  }] };
}
function messages(start: number, end: number): ChatLine[] {
  return Array.from({ length: end - start }, (_, index) => message(start + index));
}

let chat: ChatView;
let historyRequests = 0;
const savedAnchor = 'm:["entry-5","user","message"]';

function scroller(): HTMLElement {
  const element = chat.renderRoot.querySelector<HTMLElement>(".chat");
  if (element === null) throw new Error("Missing transcript scroller");
  return element;
}

function syncRange(): void {
  chat.messageEnd = chat.messageStart + chat.messages.length;
  chat.messageTotal = chat.messageEnd;
}

async function settled(): Promise<void> {
  await chat.updateComplete;
  // Child Lit renders and the production viewport RAF must finish before measuring.
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => { resolve(); })));
  await chat.updateComplete;
}

async function mount(restoreMachine?: "local" | "remote-fixture"): Promise<void> {
  document.querySelector("chat-view")?.remove();
  localStorage.clear();
  historyRequests = 0;
  chat = new ChatView();
  chat.sessionId = "viewport-session";
  chat.machineId = restoreMachine ?? "local";
  chat.behaviors = { ...DEFAULT_CHAT_BEHAVIORS, automaticHistory: false, loadImages: false, rememberDisclosures: false, visualEffects: false };
  chat.historyReady = true;
  chat.onSubmitAsk = () => undefined;
  chat.messageStart = 20;
  chat.messages = messages(20, 50);
  syncRange();
  if (restoreMachine !== undefined) {
    // Seed the public persistence format, independently of the production key helper.
    const scope = restoreMachine === "local" ? chat.sessionId : JSON.stringify(["machine", restoreMachine, chat.sessionId]);
    localStorage.setItem(`pi-web:chat-scroll:${scope}`, JSON.stringify({ mode: "anchor", anchorId: savedAnchor, offset: -17 }));
    chat.hasMore = true;
    chat.historyReady = true;
    chat.onLoadMore = () => { historyRequests++; };
  }
  document.body.append(chat);
  await settled();
}

function geometry() {
  const viewport = scroller();
  const top = viewport.getBoundingClientRect().top;
  const anchors = Array.from(chat.renderRoot.querySelectorAll<HTMLElement>("[data-scroll-anchor-id]"));
  const anchor = anchors.find((element) => element.getBoundingClientRect().bottom > top);
  const form = chat.renderRoot.querySelector<HTMLElement>("ask-user-card.open-question-card");
  const saved = anchors.find((element) => element.dataset["scrollAnchorId"] === savedAnchor);
  return {
    top: viewport.scrollTop,
    maxTop: viewport.scrollHeight - viewport.clientHeight,
    height: viewport.clientHeight,
    anchorId: anchor?.dataset["scrollAnchorId"],
    anchorOffset: anchor === undefined ? undefined : anchor.getBoundingClientRect().top - top,
    savedOffset: saved === undefined ? undefined : saved.getBoundingClientRect().top - top,
    formOffset: form === null ? undefined : form.getBoundingClientRect().top - top,
    formHeight: form?.getBoundingClientRect().height,
    historyRequests,
  };
}

async function prependAndGrow(): Promise<void> {
  // Two Lit commits, deliberately without yielding a frame: the first anchor wins.
  chat.messageStart = 10;
  chat.messages = [...messages(10, 20), ...chat.messages, ...messages(50, 55)];
  syncRange();
  await chat.updateComplete;
  chat.messageStart = 0;
  chat.messages = [...messages(0, 10), ...chat.messages, ...messages(55, 60)];
  syncRange();
  await settled();
}

async function revealSaved(): Promise<void> {
  chat.messageStart = 0;
  chat.messages = [...messages(0, 20), ...chat.messages];
  syncRange();
  chat.hasMore = false;
  await settled();
}

async function openForm(): Promise<void> {
  chat.messages = [...chat.messages, { entryId: "question", role: "tool", parts: [{ type: "askUserQuestion", ask: {
    askId: "tall-form", askedAt: "2026-07-20T10:00:00.000Z",
    questions: Array.from({ length: 8 }, (_, index) => ({ id: `question-${String(index)}`, question: `Fixture question ${String(index + 1)}?`, options: [] })),
  } }] }];
  syncRange();
  await settled();
}

declare global {
  interface Window {
    viewportFixture: { mount: typeof mount; settled: typeof settled; geometry: typeof geometry; prependAndGrow: typeof prependAndGrow; revealSaved: typeof revealSaved; openForm: typeof openForm };
  }
}
window.viewportFixture = { mount, settled, geometry, prependAndGrow, revealSaved, openForm };
await mount();
document.body.dataset["ready"] = "true";
