import { vi } from "vitest";
import type { ChatView } from "./ChatView";

/** Control only the browser frame boundary; component updates remain real. */
export function manualChatFrames() {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    id += 1; frames.set(id, callback); return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => { frames.delete(key); });
  return () => {
    const batch = [...frames.values()]; frames.clear();
    for (const callback of batch) callback(0);
  };
}

/** Explicit metrics collaborator, not a claim that happy-dom computes layout. */
export function controlledChatViewport(view: ChatView) {
  const chat = view.renderRoot.querySelector<HTMLDivElement>(".chat");
  if (!chat) throw new Error("Expected chat viewport");
  const metrics = { top: 100, height: 2000 };
  const write = vi.fn((value: number) => { metrics.top = Math.max(0, Math.min(value, metrics.height - 300)); });
  Object.defineProperties(chat, {
    scrollTop: { get: () => metrics.top, set: write },
    scrollHeight: { get: () => metrics.height }, clientHeight: { value: 300 },
  });
  vi.spyOn(chat, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 600, 300));
  return { metrics, write };
}
