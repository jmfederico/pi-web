import { describe, expect, it } from "vitest";
import { COMPOSER_SEND_DESKTOP, COMPOSER_SEND_MOBILE, composerSendShortcut, matchesComposerSend } from "./composerShortcuts";
import type { ShortcutKeyEvent } from "./keyboardShortcuts";

describe("composer send bindings", () => {
  it("defaults to Enter on desktop and Shift+Enter on mobile", () => {
    expect(composerSendShortcut({}, { matches: false }, "auto")).toBe("enter");
    expect(composerSendShortcut({}, { matches: true }, "auto")).toBe("shift+enter");
  });

  it("preserves legacy preferences only for contexts without explicit configuration", () => {
    expect(composerSendShortcut({}, { matches: true }, "send")).toBe("enter");
    expect(composerSendShortcut({}, { matches: false }, "newline")).toBe("shift+enter");
    const shortcuts = { [COMPOSER_SEND_DESKTOP]: "mod+enter", [COMPOSER_SEND_MOBILE]: null };
    expect(composerSendShortcut(shortcuts, { matches: false }, "send")).toBe("mod+enter");
    expect(composerSendShortcut(shortcuts, { matches: true }, "send")).toBeNull();
  });

  it.each(["enter", "shift+enter", "mod+enter"])("allows %s on both contexts independently", (shortcut) => {
    const shortcuts = { [COMPOSER_SEND_DESKTOP]: shortcut, [COMPOSER_SEND_MOBILE]: shortcut };
    expect(composerSendShortcut(shortcuts, { matches: false })).toBe(shortcut);
    expect(composerSendShortcut(shortcuts, { matches: true })).toBe(shortcut);
  });

  it("matches exact modifiers, rejects sequences and never submits during composition", () => {
    const event: ShortcutKeyEvent = { key: "Enter", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, target: null };
    expect(matchesComposerSend(event, "mod+enter")).toBe(true);
    expect(matchesComposerSend({ ...event, ctrlKey: false, metaKey: true }, "mod+enter")).toBe(true);
    expect(matchesComposerSend({ ...event, shiftKey: true }, "mod+enter")).toBe(false);
    expect(matchesComposerSend({ ...event, isComposing: true }, "mod+enter")).toBe(false);
    expect(matchesComposerSend(event, "mod+enter x")).toBe(false);
    expect(matchesComposerSend(event, null)).toBe(false);
  });
});
