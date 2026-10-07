// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  frames.clear();
  vi.unstubAllGlobals();
});

function flushFrame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}

const transitions = {
  streaming: (view: ChatView, active: boolean) => {
    view.status = {
      sessionId: "dock-test", isStreaming: active, isCompacting: false, isBashRunning: false,
      pendingMessageCount: 0, queuedMessages: [], cost: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  },
  activity: (view: ChatView, active: boolean) => {
    view.activity = {
      sessionId: "dock-test", phase: active ? "active" : "idle", label: active ? "receiving response" : "idle",
      at: "2026-09-01T00:00:00Z",
    };
  },
  sending: (view: ChatView, active: boolean) => { view.isSendingPrompt = active; },
};

describe.each(Object.entries(transitions))("ChatView composer-owned activity: %s", (_name, transition) => {
  it.each([true, false])("does not render an activity overlay or scroll (at bottom: %s)", async (atBottom) => {
    const view = new ChatView();
    transition(view, false);
    document.body.append(view);
    await view.updateComplete;
    flushFrame();
    const chat = view.shadowRoot?.querySelector<HTMLElement>(".chat");
    if (!chat) throw new Error("Missing transcript");

    // Supply stable browser metrics, not simulated CSS layout. Activity
    // visual geometry is checked in a browser; this verifies scroll side effects.
    let top = atBottom ? 600 : 200;
    const scroll = vi.fn((value: number) => { top = value; });
    Object.defineProperties(chat, {
      clientHeight: { get: () => 400 },
      scrollHeight: { get: () => 1000 },
      scrollTop: { get: () => top, set: scroll },
    });
    if (!atBottom) chat.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    chat.dispatchEvent(new Event("scroll"));
    await view.updateComplete;
    flushFrame();
    scroll.mockClear();

    for (const active of [true, false]) {
      transition(view, active);
      await view.updateComplete;
      flushFrame();
      expect(view.shadowRoot?.querySelector(".activity-dock")).toBeNull();
      expect(scroll).not.toHaveBeenCalled();
    }
  });
});
