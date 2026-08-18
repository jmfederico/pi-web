import { describe, expect, it, vi } from "vitest";
import type { AppAction } from "./actions";
import { KeyboardShortcutDispatcher, parseShortcutInput, resolveShortcutBindings, shortcutTokenFromEvent, type ShortcutKeyEvent } from "./keyboardShortcuts";

function keyEvent(key: string, modifiers: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    target: null,
    ...modifiers,
  };
}

function action(shortcut: string, enabled = true) {
  return actionWithId(shortcut, shortcut, enabled);
}

function actionWithId(id: string, shortcut: string, enabled = true) {
  const run = vi.fn();
  const value: AppAction = {
    id,
    title: id,
    shortcut,
    enabled,
    run,
  };
  return { value, run };
}

describe("KeyboardShortcutDispatcher", () => {
  it("runs an enabled matching modified shortcut", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("mod+k");

    const handled = dispatcher.handle(keyEvent("k", { metaKey: true }), [value]);

    expect(handled).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ignores plain letters so normal typing is never captured", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("r");

    const handled = dispatcher.handle(keyEvent("r"), [value]);

    expect(handled).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("matches manually typed Ctrl shortcuts as the cross-platform Mod modifier", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("ctrl+k");

    const handled = dispatcher.handle(keyEvent("k", { ctrlKey: true }), [value]);

    expect(handled).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ignores shift-only shortcuts so capitalized typing is never captured", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("shift+r");

    const handled = dispatcher.handle(keyEvent("r", { shiftKey: true }), [value]);

    expect(handled).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("ignores disabled matching shortcuts", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("mod+enter", false);

    const handled = dispatcher.handle(keyEvent("Enter", { ctrlKey: true }), [value]);

    expect(handled).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("requires shift for shift shortcuts", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("mod+shift+r");

    expect(dispatcher.handle(keyEvent("r", { ctrlKey: true }), [value])).toBe(false);
    expect(dispatcher.handle(keyEvent("r", { ctrlKey: true, shiftKey: true }), [value])).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs a shortcut sequence that starts with a modified key", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("mod+g p");

    expect(dispatcher.handle(keyEvent("g", { ctrlKey: true }), [value])).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(dispatcher.handle(keyEvent("p"), [value])).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("deterministically runs the lowest action id when default shortcuts conflict", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const later = actionWithId("plugin:z", "mod+k");
    const earlier = actionWithId("plugin:a", "mod+k");

    const handled = dispatcher.handle(keyEvent("k", { ctrlKey: true }), [later.value, earlier.value]);

    expect(handled).toBe(true);
    expect(earlier.run).toHaveBeenCalledTimes(1);
    expect(later.run).not.toHaveBeenCalled();
  });

  it("runs custom shortcut winners before default shortcut conflicts", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const defaultAction = actionWithId("plugin:a", "mod+j");
    const customAction = actionWithId("plugin:z", "mod+k");

    const handled = dispatcher.handle(keyEvent("j", { ctrlKey: true }), [defaultAction.value, customAction.value], { shortcuts: { "plugin:z": "mod+j" } });

    expect(handled).toBe(true);
    expect(customAction.run).toHaveBeenCalledTimes(1);
    expect(defaultAction.run).not.toHaveBeenCalled();
  });

  it("dispatches a saved shortcut through a migrated action id", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const migrated = actionWithId("git:view.git", "mod+3");
    migrated.value.shortcutAliases = ["core:view.git"];

    const handled = dispatcher.handle(keyEvent("8", { ctrlKey: true }), [migrated.value], { shortcuts: { "core:view.git": "mod+8" } });

    expect(handled).toBe(true);
    expect(migrated.run).toHaveBeenCalledOnce();
  });

  it("uses the same shadowing rules when a standalone shortcut is a sequence prefix", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const standalone = actionWithId("plugin:standalone", "mod+g");
    const sequence = actionWithId("plugin:sequence", "mod+g p");

    const handled = dispatcher.handle(keyEvent("g", { ctrlKey: true }), [standalone.value, sequence.value]);

    expect(handled).toBe(true);
    expect(standalone.run).toHaveBeenCalledTimes(1);
    expect(sequence.run).not.toHaveBeenCalled();
  });

  it("falls back to a standalone modified shortcut when a pending sequence misses", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const sequence = action("mod+g p");
    const standalone = action("mod+k");

    expect(dispatcher.handle(keyEvent("g", { ctrlKey: true }), [sequence.value, standalone.value])).toBe(true);
    expect(dispatcher.handle(keyEvent("k", { ctrlKey: true }), [sequence.value, standalone.value])).toBe(true);
    expect(sequence.run).not.toHaveBeenCalled();
    expect(standalone.run).toHaveBeenCalledTimes(1);
  });
});

describe("shortcut conflict resolution", () => {
  it("reports which duplicate bindings shadow and which are shadowed", () => {
    const defaultAction = actionWithId("plugin:a", "mod+k");
    const customAction = actionWithId("plugin:z", "mod+j");

    const resolutions = resolveShortcutBindings([defaultAction.value, customAction.value], { "plugin:z": "mod+k" });
    const defaultResolution = resolutions.find((resolution) => resolution.action.id === "plugin:a");
    const customResolution = resolutions.find((resolution) => resolution.action.id === "plugin:z");

    expect(customResolution?.active).toBe(true);
    expect(customResolution?.shadows.map((binding) => binding.action.id)).toEqual(["plugin:a"]);
    expect(defaultResolution?.active).toBe(false);
    expect(defaultResolution?.shadowedBy?.action.id).toBe("plugin:z");
  });

  it("reports sequence bindings shadowed by shorter shortcut prefixes", () => {
    const standalone = actionWithId("plugin:standalone", "mod+g");
    const sequence = actionWithId("plugin:sequence", "mod+g p");

    const resolutions = resolveShortcutBindings([sequence.value, standalone.value]);
    const standaloneResolution = resolutions.find((resolution) => resolution.action.id === "plugin:standalone");
    const sequenceResolution = resolutions.find((resolution) => resolution.action.id === "plugin:sequence");

    expect(standaloneResolution?.active).toBe(true);
    expect(standaloneResolution?.shadows.map((binding) => binding.action.id)).toEqual(["plugin:sequence"]);
    expect(sequenceResolution?.active).toBe(false);
    expect(sequenceResolution?.shadowedBy?.action.id).toBe("plugin:standalone");
  });
});

describe("shortcut input parsing", () => {
  it("normalizes manually typed shortcuts", () => {
    expect(parseShortcutInput("Ctrl + Shift + K")).toEqual({ ok: true, shortcut: "mod+shift+k", tokens: ["mod+shift+k"] });
    expect(parseShortcutInput("cmd+g p")).toEqual({ ok: true, shortcut: "mod+g p", tokens: ["mod+g", "p"] });
  });

  it("rejects shortcuts that would capture normal typing", () => {
    expect(parseShortcutInput("r")).toEqual({ ok: false, message: "Shortcuts must start with Ctrl/⌘ or Alt so normal typing is not captured." });
    expect(parseShortcutInput("shift+r")).toEqual({ ok: false, message: "Shortcuts must start with Ctrl/⌘ or Alt so normal typing is not captured." });
  });

  it("builds canonical tokens from recorded key events", () => {
    expect(shortcutTokenFromEvent(keyEvent("K", { metaKey: true, shiftKey: true }))).toBe("mod+shift+k");
    expect(shortcutTokenFromEvent(keyEvent("ArrowDown", { altKey: true }))).toBe("alt+arrowdown");
  });
});
