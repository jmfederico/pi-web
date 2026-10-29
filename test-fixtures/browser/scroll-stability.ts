import { ChatView } from "../../src/client/src/components/ChatView";
import { DEFAULT_CHAT_BEHAVIORS } from "../../src/client/src/chatBehaviors";
import type { ChatLine } from "../../src/client/src/components/shared";

const style = document.createElement("style");
style.textContent = `
  body { margin: 0; font: 16px system-ui; }
  chat-view { height: 480px; width: min(700px, 100vw); }
`;
document.head.append(style);

const sessionId = "scroll-stability-session";
type Kind = "ordinary" | "activity";
let chat: ChatView;
let anchorId: string;
let anchor: HTMLElement;

function message(index: number, kind: Kind): ChatLine {
  return kind === "ordinary" ? {
    entryId: `entry-${String(index)}`, role: "user",
    parts: [{ type: "text", text: `Message ${String(index)}. ` + "Variable height retained prose with natural wrapping. ".repeat(1 + index % 9) }],
  } : {
    entryId: `entry-${String(index)}`, role: "assistant",
    parts: [
      { type: "thinking", sourcePart: "thinking", text: `Step ${String(index)}. ` + "Retained reasoning with variable height. ".repeat(1 + index % 7) },
      { type: "toolExecution", sourcePart: "execution", toolCallId: `call-${String(index)}`, toolName: "bash", summary: `Inspect ${String(index)}`, status: "success", resultText: "Retained output.\n".repeat(3 + index % 8) },
    ],
  };
}

function scroller(): HTMLElement {
  const element = chat.renderRoot.querySelector<HTMLElement>(".chat");
  if (element === null) throw new Error("Missing production scroller");
  return element;
}

function findAnchor(): HTMLElement | undefined {
  return Array.from(chat.renderRoot.querySelectorAll<HTMLElement>("[data-scroll-anchor-id]"))
    .find((element) => element.dataset["scrollAnchorId"] === anchorId);
}

// A rendering opportunity followed by a task: measurements are not made inside
// the rAF callback before the browser has had its opportunity to paint.
function painted(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => { setTimeout(resolve, 0); }));
}

function geometry() {
  const viewport = scroller();
  const node = findAnchor();
  const bounds = node?.getBoundingClientRect();
  const rect = viewport.getBoundingClientRect();
  return {
    top: viewport.scrollTop,
    maxTop: viewport.scrollHeight - viewport.clientHeight,
    offset: bounds === undefined ? null : bounds.top - rect.top,
    bottom: bounds === undefined ? null : bounds.bottom - rect.top,
    sameNode: node === anchor && anchor.isConnected,
    retained: chat.messages.length,
    mounted: chat.renderRoot.querySelectorAll("[data-transcript-row]").length,
  };
}

async function start(kind: Kind, windowed: boolean) {
  document.querySelector("chat-view")?.remove();
  localStorage.removeItem(`pi-web:chat-scroll:${sessionId}`);
  anchorId = `${kind === "ordinary" ? "m" : "e"}:["entry-150","${kind === "ordinary" ? "user" : "assistant"}","message"]`;
  localStorage.setItem(`pi-web:chat-scroll:${sessionId}`, JSON.stringify({ mode: "anchor", anchorId, offset: -17 }));
  chat = new ChatView();
  chat.sessionId = sessionId;
  chat.behaviors = { ...DEFAULT_CHAT_BEHAVIORS, mountingWindow: windowed, automaticHistory: false, visualEffects: false };
  chat.historyReady = true;
  chat.messages = Array.from({ length: 300 }, (_, index) => message(index, kind));
  chat.messageEnd = chat.messageTotal = chat.messages.length;
  if (kind === "activity") chat.activity = { sessionId, phase: "active", label: "Working", at: "2026-07-20T10:00:00.000Z" };
  document.body.append(chat);
  await chat.updateComplete;
  await document.fonts.ready;
  // Initial readiness is observable saved-anchor restoration and stable layout,
  // not a per-input settle helper that could hide intermediate corrections.
  let previous = "";
  let stable = 0;
  for (let frame = 0; frame < 180; frame++) {
    await painted();
    const node = findAnchor();
    if (node === undefined) continue;
    anchor = node;
    const state = geometry();
    const signature = JSON.stringify(state);
    stable = signature === previous && Math.abs((state.offset ?? Infinity) + 17) <= 1 ? stable + 1 : 0;
    previous = signature;
    if (stable >= 3 && state.top > 200 && state.maxTop - state.top > 200) return { anchorId, ...state };
  }
  throw new Error(`Saved-anchor readiness failed: ${previous}`);
}

async function trace(steps = 50, delta = 4, restFrames = 0) {
  const initial = geometry();
  if (initial.offset === null) throw new Error("Missing initial anchor");
  const samples = [];
  let cumulativeInput = 0;
  for (let frame = 0; frame < steps + restFrames; frame++) {
    let inputBefore = 0;
    let inputAfter = 0;
    const input = frame < steps ? delta : 0;
    // Explicit browser-boundary input, not a synthetic scroll event, planner
    // simulation, or a claim about physical touch/inertia on iOS Safari.
    await new Promise<void>((resolve) => requestAnimationFrame(() => {
      const viewport = scroller();
      inputBefore = viewport.scrollTop;
      viewport.scrollTop += input;
      inputAfter = viewport.scrollTop;
      setTimeout(resolve, 0);
    }));
    cumulativeInput += input;
    const state = geometry();
    samples.push({ frame, input, inputBefore, inputAfter, cumulativeInput,
      expectedOffset: initial.offset - cumulativeInput, ...state });
  }
  return { anchorId, initial, samples };
}

declare global {
  interface Window {
    scrollStabilityFixture: { start: typeof start; trace: typeof trace };
  }
}
window.scrollStabilityFixture = { start, trace };
document.body.dataset["ready"] = "true";
