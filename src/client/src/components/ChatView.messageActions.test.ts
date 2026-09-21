// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(entryId: string | undefined = "entry-1") {
  const view = new ChatView();
  view.sessionId = "session-1";
  view.messages = [{ role: "user", entryId, parts: [{ type: "text", text: "Hello" }] }];
  view.onMessageAction = vi.fn(() => Promise.resolve());
  document.body.append(view);
  await view.updateComplete;
  return view;
}

function button(view: ChatView, index: number): HTMLButtonElement {
  const result = buttons(view)[index];
  if (result === undefined) throw new Error(`Missing message action ${String(index)}`);
  return result;
}

function buttons(view: ChatView) {
  return Array.from(view.renderRoot.querySelectorAll<HTMLButtonElement>(".msg-action"));
}

describe("chat message history shortcuts", () => {
  it.each([
    [0, "fork", "Are you sure you want to fork this session?"],
    [1, "back", "Are you sure you want to go back to this message?"],
  ] as const)("confirms shortcut %s before changing history", async (index, action, copy) => {
    const view = await mount();
    expect(buttons(view).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Clone session from this message", "Go back to this message", "Copy user message",
    ]);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    button(view, index).click();
    expect(confirm).toHaveBeenCalledWith(copy);
    expect(view.onMessageAction).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    button(view, index).click();
    await view.updateComplete;
    expect(view.onMessageAction).toHaveBeenCalledWith("entry-1", action);
  });

  it("does not offer history shortcuts for messages without a durable entry", async () => {
    const view = await mount();
    view.messages = [{ role: "assistant", parts: [{ type: "text", text: "Streaming" }] }];
    await view.updateComplete;
    expect(buttons(view).map((button) => button.title)).toEqual(["Copy message"]);
  });

  it("disables history actions while busy and surfaces failures", async () => {
    const view = await mount();
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    view.messageActionsDisabled = true;
    await view.updateComplete;
    button(view, 0).click();
    expect(confirm).not.toHaveBeenCalled();
    expect(button(view, 2).disabled).toBe(false);
    view.messageActionsDisabled = false;
    view.onMessageAction = vi.fn(() => Promise.reject(new Error("History changed")));
    await view.updateComplete;
    button(view, 1).click();
    await view.updateComplete;
    await view.updateComplete;
    expect(view.renderRoot.querySelector('[role="alert"]')?.textContent).toBe("History changed");
  });
});
