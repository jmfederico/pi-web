// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { MessageActionsMenu } from "./MessageActionsMenu";
import { installPopoverFake } from "../anchoredPopup.testSupport";

installPopoverFake();
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount() {
  const menu = new MessageActionsMenu();
  const content = document.createElement("div");
  const action = document.createElement("button"); action.textContent = "Copy message";
  content.append(action); menu.append(content); document.body.append(menu);
  await menu.updateComplete;
  const trigger = menu.shadowRoot?.querySelector("button");
  const panel = menu.shadowRoot?.querySelector<HTMLDivElement>("[popover]");
  const slot = menu.shadowRoot?.querySelector("slot");
  if (!trigger || !panel || !slot) throw new Error("Missing message actions controls");
  return { menu, content, action, trigger, panel, slot };
}

it("keeps action content parent-owned and uses a named trigger", async () => {
  const { content, action, trigger, panel, slot } = await mount();
  expect(trigger.getAttribute("aria-label")).toBe("Message actions");
  expect(trigger.getAttribute("aria-controls")).toBe(panel.id);
  expect(panel.getAttribute("popover")).toBe("auto");
  expect(slot.assignedElements()).toEqual([content]);
  const copy = vi.fn(); action.addEventListener("click", copy); action.click();
  expect(copy).toHaveBeenCalledOnce();
});

it("reconciles native dismissal and can reopen", async () => {
  const { menu, trigger, panel } = await mount();
  trigger.click(); await menu.updateComplete;
  expect(menu.hasAttribute("open")).toBe(true);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  panel.hidePopover(); await menu.updateComplete;
  expect(menu.hasAttribute("open")).toBe(false);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  trigger.click(); await menu.updateComplete;
  expect(menu.hasAttribute("open")).toBe(true);
});

it("closes on request and returns focus to its trigger", async () => {
  const { menu, trigger, action } = await mount();
  menu.close();
  trigger.click(); await menu.updateComplete;
  action.focus(); menu.close(); await menu.updateComplete;
  expect(menu.hasAttribute("open")).toBe(false);
  expect(menu.shadowRoot?.activeElement).toBe(trigger);
});

it("uses shared left-strip placement and cleans pending viewport work on disconnect", async () => {
  const frames = new Map<number, FrameRequestCallback>(); let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => { frames.delete(key); });
  const { menu, trigger, panel } = await mount();
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(200, 100, 28, 28));
  trigger.click(); await menu.updateComplete;
  expect(panel.style.maxWidth).toBe("192px");
  expect(panel.style.right).toBe(`${String(window.innerWidth - 200)}px`);
  window.dispatchEvent(new Event("resize"));
  expect(frames.size).toBe(1);
  menu.remove();
  expect(frames.size).toBe(0);
  expect(menu.hasAttribute("open")).toBe(false);
  window.dispatchEvent(new Event("resize"));
  expect(frames.size).toBe(0);
});
