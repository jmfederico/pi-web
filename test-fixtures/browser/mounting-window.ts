import { ChatView } from "../../src/client/src/components/ChatView";
import { DEFAULT_CHAT_BEHAVIORS } from "../../src/client/src/chatBehaviors";
import type { ChatLine } from "../../src/client/src/components/shared";

const style = document.createElement("style");
style.textContent = `
  body { margin: 0; font: 16px system-ui; }
  chat-view { height: 480px; width: min(700px, 100vw); }
`;
document.head.append(style);

const sessionId = "mounting-window-session";
const savedAnchor = 'm:["entry-250","user","message"]';
let chat: ChatView;
let historyRequests = 0;
let nextEntry = 1000;

function message(index: number): ChatLine {
  return {
    entryId: `entry-${String(index)}`,
    role: "user",
    parts: [{ type: "text", text: `Message ${String(index)}. ` + "Readable ordinary transcript content with natural line wrapping. ".repeat(1 + index % 9) }],
  };
}

function scroller(): HTMLElement {
  const element = chat.renderRoot.querySelector<HTMLElement>(".chat");
  if (element === null) throw new Error("Missing transcript scroller");
  return element;
}

function syncRange(): void {
  chat.messageEnd = chat.messages.length;
  chat.messageTotal = chat.messages.length;
}

async function settled(): Promise<void> {
  await chat.updateComplete;
  // Measurement, Lit reconciliation and the sole viewport writer run on frames.
  for (let frame = 0; frame < 4; frame++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => { resolve(); }));
    await chat.updateComplete;
  }
}

async function start(restore = false): Promise<void> {
  document.querySelector("chat-view")?.remove();
  localStorage.clear();
  historyRequests = 0;
  nextEntry = 1000;
  chat = new ChatView();
  chat.sessionId = sessionId;
  chat.behaviors = { ...DEFAULT_CHAT_BEHAVIORS, mountingWindow: true, automaticHistory: false, visualEffects: false };
  chat.historyReady = true;
  chat.messages = Array.from({ length: 1000 }, (_, index) => message(index));
  syncRange();
  chat.onLoadMore = () => { historyRequests++; };
  chat.onSubmitAsk = () => undefined;
  if (restore) {
    localStorage.setItem(`pi-web:chat-scroll:${sessionId}`, JSON.stringify({ mode: "anchor", anchorId: savedAnchor, offset: -17 }));
    // There could be older server history, but this bookmark is already retained.
    chat.hasMore = true;
  }
  document.body.append(chat);
  await settled();
}

async function liveAppend(count = 10): Promise<void> {
  chat.messages = [...chat.messages, ...Array.from({ length: count }, () => message(nextEntry++))];
  syncRange();
  await settled();
}

async function openAsk(): Promise<void> {
  // Compound activity rows remain mounted in this pilot; this is not a claim
  // that arbitrary nested activity/gallery content has been windowed.
  chat.messages = [...chat.messages, { entryId: "active-ask", role: "tool", parts: [{ type: "askUserQuestion", ask: {
    askId: "mounting-question", askedAt: "2026-07-20T10:00:00.000Z",
    questions: [{ id: "answer", question: "Fixture question?", options: [] }],
  } }] }];
  syncRange();
  await settled();
}

function snapshot() {
  const viewport = scroller();
  const rect = viewport.getBoundingClientRect();
  const rows = Array.from(chat.renderRoot.querySelectorAll<HTMLElement>("article[data-transcript-row]"));
  const visible = rows.find((row) => {
    const bounds = row.getBoundingClientRect();
    return bounds.bottom > rect.top && bounds.top < rect.bottom;
  });
  const saved = rows.find((row) => row.dataset["scrollAnchorId"] === savedAnchor);
  return {
    retainedIds: chat.messages.map((row) => row.entryId),
    mountedIds: rows.map((row) => row.dataset["scrollAnchorId"]),
    top: viewport.scrollTop,
    maxTop: viewport.scrollHeight - viewport.clientHeight,
    anchorId: visible?.dataset["scrollAnchorId"],
    anchorOffset: visible === undefined ? undefined : visible.getBoundingClientRect().top - rect.top,
    savedOffset: saved === undefined ? undefined : saved.getBoundingClientRect().top - rect.top,
    historyRequests,
  };
}

declare global {
  interface Window {
    mountingWindowFixture: {
      start: typeof start;
      liveAppend: typeof liveAppend;
      openAsk: typeof openAsk;
      settled: typeof settled;
      snapshot: typeof snapshot;
    };
  }
}
window.mountingWindowFixture = { start, liveAppend, openAsk, settled, snapshot };
await start();
document.body.dataset["ready"] = "true";
