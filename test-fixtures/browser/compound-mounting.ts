import { ChatView } from "../../src/client/src/components/ChatView";
import { DEFAULT_CHAT_BEHAVIORS } from "../../src/client/src/chatBehaviors";
import type { ChatLine } from "../../src/client/src/components/shared";

const style = document.createElement("style");
style.textContent = `
  body { margin: 0; font: 16px system-ui; }
  chat-view { height: 480px; width: min(700px, 100vw); }
`;
document.head.append(style);

const sessionId = "compound-mounting-session";
const savedAnchor = 'e:["technical-250","assistant","message"]';
// A real, decodable PNG; intrinsic dimensions are supplied just as retained
// session media supplies them, while the production thumbnail owns 128x96 sizing.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo0AAAAASUVORK5CYII=";
let chat: ChatView;
let historyRequests = 0;
let nextEntry = 1000;

function technical(index: number): ChatLine {
  return {
    entryId: `technical-${String(index)}`, role: "assistant",
    parts: [
      { type: "thinking", sourcePart: "thinking", text: `Reasoning for step ${String(index)}. ` + "Check the retained technical context. ".repeat(2 + index % 4) },
      { type: "toolExecution", sourcePart: "execution", toolCallId: `call-${String(index)}`, toolName: "bash", summary: `inspect step ${String(index)}`, status: "success", resultText: `Result for step ${String(index)}\n` + "Detailed retained output.\n".repeat(8) },
    ],
  };
}

function imageOutput(index: number): ChatLine {
  return {
    entryId: `image-${String(index)}`, role: "tool",
    parts: [{ type: "image", sourcePart: "image", mimeType: "image/png", data: png, width: 1, height: 1 }],
  };
}

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
  for (let frame = 0; frame < 5; frame++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => { resolve(); }));
    await chat.updateComplete;
  }
}

async function start(kind: "activity" | "gallery" | "groups" = "activity", windowed = true, restore = false, closed = false): Promise<void> {
  document.querySelector("chat-view")?.remove();
  localStorage.clear();
  historyRequests = 0;
  nextEntry = 1000;
  chat = new ChatView();
  chat.sessionId = sessionId;
  chat.behaviors = { ...DEFAULT_CHAT_BEHAVIORS, mountingWindow: windowed, automaticHistory: false, visualEffects: false };
  chat.historyReady = true;
  chat.messageStart = restore ? 100 : 0;
  chat.quietMode = closed;
  chat.activity = { sessionId, phase: "active", label: "Working", at: "2026-07-20T10:00:00.000Z" };
  chat.messages = kind === "gallery" ? Array.from({ length: 400 }, (_, index) => imageOutput(index))
    : kind === "groups" ? Array.from({ length: 500 }, (_, index) => [technical(index), {
      entryId: `conversation-${String(index)}`, role: "user" as const, parts: [{ type: "text" as const, text: `Next conversation ${String(index)}` }],
    }]).flat()
    : Array.from({ length: 1000 }, (_, index) => technical(index));
  syncRange();
  chat.onLoadMore = () => { historyRequests++; };
  if (restore) {
    localStorage.setItem(`pi-web:chat-scroll:${sessionId}`, JSON.stringify({ mode: "anchor", anchorId: savedAnchor, offset: -17 }));
    chat.hasMore = true;
  }
  document.body.append(chat);
  await settled();
}

async function liveAppend(count = 10): Promise<void> {
  chat.messages = [...chat.messages, ...Array.from({ length: count }, () => technical(nextEntry++))];
  syncRange();
  await settled();
}

function snapshot() {
  const viewport = scroller();
  const rect = viewport.getBoundingClientRect();
  const children = Array.from(chat.renderRoot.querySelectorAll<HTMLElement>(".group-msg"));
  const visible = children.filter((row) => {
    const bounds = row.getBoundingClientRect();
    return bounds.bottom > rect.top && bounds.top < rect.bottom;
  });
  const anchor = visible[0];
  const saved = children.find((row) => row.dataset["scrollAnchorId"] === savedAnchor);
  const thumbnails = Array.from(chat.renderRoot.querySelectorAll<HTMLElement>(".tool-image-thumbnails pi-web-transcript-image"));
  const galleryRect = chat.renderRoot.querySelector(".tool-image-thumbnails")?.getBoundingClientRect();
  const imageRects = thumbnails.map((image) => {
    const bounds = image.getBoundingClientRect();
    return { index: Number(image.dataset["index"]), x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height, visible: bounds.bottom > rect.top && bounds.top < rect.bottom };
  });
  const bands = new Map<number, number>();
  for (const image of imageRects) bands.set(Math.round(image.y), (bands.get(Math.round(image.y)) ?? 0) + 1);
  return {
    retainedIds: chat.messages.map((message) => message.entryId),
    groupCount: chat.renderRoot.querySelectorAll("details.ui-transcript-activity[data-index]").length,
    groupOpen: chat.renderRoot.querySelector<HTMLDetailsElement>("details.ui-transcript-activity[data-index]")?.open,
    mountedChildren: children.map((row) => Number(row.dataset["index"])),
    measuredChildren: children.filter((row) => row.hasAttribute("data-transcript-row")).length,
    visibleChildren: visible.map((row) => Number(row.dataset["index"])),
    anchorId: anchor?.dataset["scrollAnchorId"],
    anchorOffset: anchor === undefined ? undefined : anchor.getBoundingClientRect().top - rect.top,
    savedOffset: saved === undefined ? undefined : saved.getBoundingClientRect().top - rect.top,
    top: viewport.scrollTop, maxTop: viewport.scrollHeight - viewport.clientHeight,
    thumbnails: imageRects, columns: Math.max(0, ...bands.values()), galleryWidth: galleryRect?.width,
    mountedSources: chat.renderRoot.querySelectorAll(".image-output-source").length,
    historyRequests,
  };
}

declare global {
  interface Window {
    compoundMountingFixture: {
      start: typeof start;
      liveAppend: typeof liveAppend;
      settled: typeof settled;
      snapshot: typeof snapshot;
    };
  }
}
window.compoundMountingFixture = { start, liveAppend, settled, snapshot };
await start();
document.body.dataset["ready"] = "true";
