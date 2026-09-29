// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("offers a bottom shortcut while unpinned and resumes following new messages", async () => {
  const view = new ChatView();
  document.body.append(view);
  await view.updateComplete;
  expect(view.renderRoot.querySelector(".go-to-bottom")).toBeNull();

  // Supply scroll state explicitly: happy-dom does not calculate layout.
  Reflect.set(view, "pinnedToBottom", false);
  await view.updateComplete;
  const scroll = vi.fn();
  Reflect.set(view, "scrollToBottom", scroll);
  const button = view.renderRoot.querySelector<HTMLButtonElement>(".go-to-bottom");
  expect(button?.getAttribute("aria-label")).toBe("Go to bottom");
  expect(button?.getAttribute("title")).toBe("Go to bottom");
  expect(button?.textContent.trim()).toBe("");
  expect(button?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  button?.click();
  await view.updateComplete;
  expect(scroll).toHaveBeenCalledOnce();
  expect(view.renderRoot.querySelector(".go-to-bottom")).toBeNull();

  view.messages = [{ role: "assistant", parts: [{ type: "text", text: "Latest reply" }] }];
  await view.updateComplete;
  expect(scroll).toHaveBeenCalledTimes(2);
});
