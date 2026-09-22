// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPOSER_SEND_DESKTOP, COMPOSER_SEND_MOBILE } from "../composerShortcuts";
import { PromptEditor } from "./PromptEditor";
import { api } from "../api";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function mount(shortcut: string | null, mobile = false) {
  const media = window.matchMedia("(pointer: coarse)");
  Object.defineProperty(media, "matches", { value: mobile });
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
  const editor = new PromptEditor();
  editor.shortcuts = { [COMPOSER_SEND_DESKTOP]: shortcut, [COMPOSER_SEND_MOBILE]: shortcut };
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
    });
    press(editor, "Enter");
    expect(editor.view?.state.doc.toString()).toBe("/tree ");
    expect(editor.onSend).not.toHaveBeenCalled();
  });

  it("does not submit while composing", async () => {
    const editor = await mount("enter");
    press(editor, "Enter", { isComposing: true });
    expect(editor.onSend).not.toHaveBeenCalled();
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
