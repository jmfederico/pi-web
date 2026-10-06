// @vitest-environment happy-dom

import { html, render, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionStatus } from "../api";
import { initialAppState, type AppState } from "../appState";
import { SessionController } from "../controllers/sessionController";
import { ChatView } from "./ChatView";
import { PiWebApp } from "./PiWebApp";

const session: SessionInfo = {
  id: "session-1", cwd: "/repo", path: "/repo/session.jsonl", created: "now", modified: "now", messageCount: 0, firstMessage: "",
};

function status(suggestedInput?: string): SessionStatus {
  return {
    sessionId: session.id, isStreaming: false, isCompacting: false, isBashRunning: false,
    pendingMessageCount: 0, queuedMessages: [], cost: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...(suggestedInput === undefined ? {} : { suggestedInput }),
  };
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("ChatView suggested input", () => {
  it("shows the latest status suggestion and invokes use only on a real click", async () => {
    const view = new ChatView();
    view.sessionId = session.id;
    view.machineId = "remote";
    view.status = status("first suggestion");
    view.onUseSuggestedInput = vi.fn();
    document.body.append(view);
    await view.updateComplete;
    expect(view.onUseSuggestedInput).not.toHaveBeenCalled();
    view.status = status("latest\n<plain text>");
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector(".suggested-input-text")?.textContent).toBe("latest\n<plain text>");
    expect(view.shadowRoot?.querySelector(".suggested-input")?.textContent).toContain("Replaces your current draft. Nothing is sent.");
    expect(view.onUseSuggestedInput).not.toHaveBeenCalled();
    useButton(view).click();
    expect(view.onUseSuggestedInput).toHaveBeenCalledExactlyOnceWith("remote", session.id);
  });

  it("has no affordance for absent, unrelated, or non-applicable status, but supports explicit empty input", async () => {
    const view = new ChatView();
    view.sessionId = session.id;
    view.onUseSuggestedInput = vi.fn();
    document.body.append(view);
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector(".suggested-input")).toBeNull();
    for (const value of [status(), { ...status("wrong session"), sessionId: "other" }]) {
      view.status = value;
      await view.updateComplete;
      expect(view.shadowRoot?.querySelector(".suggested-input")).toBeNull();
    }
    view.status = status("");
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector(".suggested-input-text")?.textContent).toBe("Empty input");
    useButton(view).click();
    expect(view.onUseSuggestedInput).toHaveBeenCalledOnce();
    view.onUseSuggestedInput = undefined;
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector(".suggested-input")).toBeNull();
  });

  it("wires PiWebApp's rendered button to the current-session controller and omits it for archived sessions", async () => {
    // Render just the app's chat seam: mounting the entire shell would start
    // unrelated network/controller lifecycles. Interaction still uses real DOM.
    const app = new PiWebApp();
    const controller: unknown = Reflect.get(app, "sessions");
    if (!(controller instanceof SessionController)) throw new Error("Expected app session controller");
    const use = vi.spyOn(controller, "useSuggestedInput").mockResolvedValue(undefined);
    const renderChat: unknown = Reflect.get(app, "renderChatView");
    if (!isRenderChat(renderChat)) throw new Error("Expected chat render seam");
    let state: AppState = { ...initialAppState(), selectedSession: session, status: status("suggestion") };
    const container = document.createElement("div");
    document.body.append(container);
    render(renderChat.call(app, state, session), container);
    const view = container.querySelector<ChatView>("chat-view");
    if (view === null) throw new Error("Expected rendered chat view");
    await view.updateComplete;
    expect(use).not.toHaveBeenCalled();
    useButton(view).click();
    expect(use).toHaveBeenCalledExactlyOnceWith("local", session.id);
    const archived = { ...session, archived: true };
    state = { ...state, selectedSession: archived };
    render(renderChat.call(app, state, archived), container);
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector(".suggested-input")).toBeNull();
    render(html``, container);
    controller.dispose();
  });
});

function useButton(view: ChatView): HTMLButtonElement {
  const button = view.shadowRoot?.querySelector<HTMLButtonElement>(".suggested-input button");
  if (button === undefined || button === null) throw new Error("Expected Use suggested input button");
  expect(button.textContent).toBe("Use suggested input");
  return button;
}

type RenderChat = (this: PiWebApp, state: AppState, session: SessionInfo) => TemplateResult;
function isRenderChat(value: unknown): value is RenderChat {
  return typeof value === "function";
}
