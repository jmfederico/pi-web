// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPOSER_SEND_DESKTOP, COMPOSER_SEND_MOBILE } from "../composerShortcuts";
import { installPopoverFake } from "./anchoredPopup.testSupport";
installPopoverFake();
import { PromptEditor } from "./PromptEditor";
import { api, type SlashCommand } from "../api";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function mount(shortcut: string | null | undefined, narrow = false, coarse = false) {
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const media = matchMedia(query);
    Object.defineProperty(media, "matches", { value: (query.includes("max-width: 760px") && narrow) || (query.includes("pointer: coarse") && coarse) });
    return media;
  });
  const editor = new PromptEditor();
  editor.shortcuts = shortcut === undefined ? {} : { [COMPOSER_SEND_DESKTOP]: shortcut, [COMPOSER_SEND_MOBILE]: shortcut };
  editor.onSend = vi.fn();
  document.body.append(editor);
  await editor.updateComplete;
  editor.replaceText("Hello");
  return editor;
}

function press(editor: PromptEditor, key: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...modifiers });
  editor.view?.contentDOM.dispatchEvent(event);
  return event;
}

describe("composer send behavior", () => {
  it.each([
    { preference: "steer" as const, streaming: false, compacting: false, expected: undefined },
    { preference: "steer" as const, streaming: true, compacting: false, expected: "steer" },
    { preference: "followUp" as const, streaming: true, compacting: false, expected: "followUp" },
    { preference: "steer" as const, streaming: true, compacting: true, expected: "followUp" },
    { preference: "followUp" as const, streaming: false, compacting: true, expected: "followUp" },
  ])("uses $expected for keyboard while keeping button behavior stable ($preference, streaming=$streaming, compacting=$compacting)", async ({ preference, streaming, compacting, expected }) => {
    const editor = await mount("mod+enter");
    editor.defaultStreamingBehavior = preference;
    editor.canSteer = streaming;
    editor.isCompacting = compacting;
    await editor.updateComplete;
    const highlighted = editor.renderRoot.querySelectorAll(".default-send-action");
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]?.getAttribute("aria-label")).toBe(expected === "steer" ? "Steer current response" : streaming || compacting ? "Queue message" : "Send message");
    press(editor, "Enter", { ctrlKey: true });
    if (editor.onSend === undefined) throw new Error("Missing send callback");
    expect(vi.mocked(editor.onSend).mock.calls[0]?.[1]).toBe(expected);
    editor.replaceText("Next message");
    const button = editor.shadowRoot?.querySelector<HTMLButtonElement>(".send-button");
    expect(button?.getAttribute("aria-label")).toBe(streaming || compacting ? "Queue message" : "Send message");
    button?.click();
    expect(editor.onSend).toHaveBeenCalledTimes(2);
    expect(vi.mocked(editor.onSend).mock.calls[1]?.[1]).toBe(streaming || compacting ? "followUp" : undefined);
    if (compacting) expect(editor.shadowRoot?.querySelector(".steer-button")).toBeNull();
  });

  it.each(["steer", "followUp"] as const)("keeps button order and steering action stable when keyboard default is %s", async (preference) => {
    const editor = await mount("mod+enter");
    expect(editor.defaultStreamingBehavior).toBe("steer");
    editor.defaultStreamingBehavior = preference;
    editor.canSteer = true;
    await editor.updateComplete;
    expect([...editor.renderRoot.querySelectorAll<HTMLButtonElement>(".actions button")].map((button) => button.getAttribute("aria-label"))).toEqual(["Queue message", "Steer current response", "Stop current work"]);
    const steer = editor.shadowRoot?.querySelector<HTMLButtonElement>(".steer-button");
    steer?.click();
    expect(editor.onSend).toHaveBeenCalledOnce();
    if (editor.onSend === undefined) throw new Error("Missing send callback");
    expect(vi.mocked(editor.onSend).mock.calls[0]?.[1]).toBe("steer");
    editor.defaultStreamingBehavior = preference === "steer" ? "followUp" : "steer";
    await editor.updateComplete;
    expect(editor.renderRoot.querySelector(".default-send-action")?.getAttribute("aria-label")).toBe(preference === "steer" ? "Queue message" : "Steer current response");
    expect([...editor.renderRoot.querySelectorAll<HTMLButtonElement>(".actions button")].map((button) => button.getAttribute("aria-label"))).toEqual(["Queue message", "Steer current response", "Stop current work"]);
  });
});

describe("composer keyboard handling", () => {
  it("inserts newlines with Enter/Shift+Enter and sends with the configured combination", async () => {
    const editor = await mount("mod+enter");
    press(editor, "Enter");
    press(editor, "Enter", { shiftKey: true });
    expect(editor.view?.state.doc.toString()).toBe("Hello\n\n");
    expect(editor.onSend).not.toHaveBeenCalled();
    press(editor, "Enter", { ctrlKey: true });
    expect(editor.onSend).toHaveBeenCalledOnce();
  });

  it("claims send keys before global dispatch even when sending is unavailable", async () => {
    const editor = await mount("mod+enter");
    const ownership: boolean[] = [];
    const capture = (event: KeyboardEvent) => { ownership.push(editor.ownsKeyboardEvent(event)); };
    window.addEventListener("keydown", capture, true);
    try {
      editor.replaceText("");
      press(editor, "Enter", { ctrlKey: true });
      editor.disabled = true;
      await editor.updateComplete;
      press(editor, "Enter", { metaKey: true });
      press(editor, "k", { ctrlKey: true });
      expect(ownership).toEqual([true, true, false]);
      expect(editor.onSend).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", capture, true);
    }
  });

  it("keeps keyboard submission disabled with None while the send button works", async () => {
    const editor = await mount(null);
    press(editor, "Enter");
    press(editor, "Enter", { shiftKey: true });
    expect(editor.onSend).not.toHaveBeenCalled();
    editor.shadowRoot?.querySelector<HTMLButtonElement>(".send-button")?.click();
    expect(editor.onSend).toHaveBeenCalledOnce();
  });

  it("accepts a completion before sending on plain Enter", async () => {
    vi.spyOn(api, "commands").mockResolvedValue([{ name: "tree", source: "builtin" }]);
    const editor = await mount("enter");
    editor.sessionId = "test-session";
    editor.cwd = "/repo";
    await editor.updateComplete;
    editor.view?.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "/tr" }, selection: { anchor: 3 } });
    await vi.waitFor(() => {
      const menu = editor.shadowRoot?.querySelector("autocomplete-menu");
      expect(menu?.shadowRoot?.textContent).toContain("/tree");
      expect(menu?.shadowRoot?.querySelector("[popover]")).not.toBeNull();
    });
    press(editor, "Enter");
    await editor.updateComplete;
    expect(editor.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.querySelector("[popover]")).toBeNull();
    expect(editor.view?.state.doc.toString()).toBe("/tree ");
    expect(editor.onSend).not.toHaveBeenCalled();
  });

  it("reconciles native completion dismissal with editor shortcuts without moving focus", async () => {
    vi.spyOn(api, "commands").mockResolvedValue([{ name: "tree", source: "builtin" }]);
    const editor = await mount("enter");
    editor.sessionId = "test-session"; editor.cwd = "/repo"; await editor.updateComplete;
    editor.view?.focus();
    editor.view?.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "/tr" }, selection: { anchor: 3 } });
    await vi.waitFor(() => {
      expect(editor.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.querySelector("[popover]")).not.toBeNull();
    });
    const panel = editor.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.querySelector<HTMLElement>("[popover]");
    panel?.hidePopover();
    await editor.updateComplete;
    expect(editor.view?.hasFocus).toBe(true);
    press(editor, "Enter");
    expect(editor.onSend).toHaveBeenCalledOnce();
  });

  it("does not reopen a dismissed popup when an in-flight completion load finishes", async () => {
    const commands: SlashCommand[] = [{ name: "tree", source: "builtin" }];
    let finish: ((value: SlashCommand[]) => void) | undefined;
    const pending = new Promise<SlashCommand[]>((resolve) => { finish = resolve; });
    const load = vi.spyOn(api, "commands").mockResolvedValueOnce(commands).mockReturnValueOnce(pending);
    const editor = await mount("enter");
    editor.sessionId = "test-session";
    editor.cwd = "/repo";
    await editor.updateComplete;
    editor.view?.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "/" }, selection: { anchor: 1 } });
    await vi.waitFor(() => {
      expect(editor.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.querySelector("[popover]")).not.toBeNull();
    });
    editor.view?.dispatch({ changes: { from: 1, insert: "t" }, selection: { anchor: 2 } });
    expect(load).toHaveBeenCalledTimes(2);
    editor.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.querySelector<HTMLElement>("[popover]")?.hidePopover();
    finish?.(commands);
    await pending;
    await editor.updateComplete;
    await editor.updateComplete;
    expect(editor.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.querySelector("[popover]")).toBeNull();
  });

  it("does not submit while composing", async () => {
    const editor = await mount("enter");
    press(editor, "Enter", { isComposing: true });
    expect(editor.onSend).not.toHaveBeenCalled();
  });

  it("keeps Enter as newline on a wide touch screen and requires explicit Shift to send", async () => {
    const editor = await mount(undefined, false, true);
    press(editor, "Enter");
    press(editor, "Enter", { shiftKey: true });
    expect(editor.view?.state.doc.toString()).toBe("Hello\n\n");
    expect(editor.onSend).not.toHaveBeenCalled();
    press(editor, "Shift", { shiftKey: true });
    press(editor, "Enter", { shiftKey: true });
    expect(editor.onSend).toHaveBeenCalledOnce();
  });

  it("ignores touch autocapitalization but accepts explicit Shift+Enter", async () => {
    const editor = await mount("shift+enter", true);
    press(editor, "Enter", { shiftKey: true });
    expect(editor.onSend).not.toHaveBeenCalled();
    press(editor, "Shift", { shiftKey: true });
    press(editor, "Enter", { shiftKey: true });
    expect(editor.onSend).toHaveBeenCalledOnce();
  });
});
