// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppAction } from "./actions";
import { KeyboardShortcutDispatcher, parseShortcutInput, resolveShortcutBindings, shortcutTokenFromEvent, type ShortcutKeyEvent } from "./keyboardShortcuts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

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
  it("runs Gmail-style sequences and falls back to plain standalone shortcuts", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const sequence = action("g p");
    const standalone = action("r");
    const actions = [sequence.value, standalone.value];
    expect(dispatcher.handle(keyEvent("g"), actions)).toBe(true);
    expect(sequence.run).not.toHaveBeenCalled();
    expect(dispatcher.handle(keyEvent("p"), actions)).toBe(true);
    expect(sequence.run).toHaveBeenCalledOnce();
    expect(dispatcher.handle(keyEvent("g"), actions)).toBe(true);
    expect(dispatcher.handle(keyEvent("r"), actions)).toBe(true);
    expect(standalone.run).toHaveBeenCalledOnce();
  });

  it.each(["input", "textarea", "select", "contenteditable"])("protects typing in %s while preserving modified shortcuts", (kind) => {
    const target = document.createElement(kind === "contenteditable" ? "div" : kind);
    if (kind === "contenteditable") target.contentEditable = "true";
    const child = kind === "contenteditable" ? target.appendChild(document.createElement("span")) : target;
    const dispatcher = new KeyboardShortcutDispatcher();
    for (const shortcut of ["r", "shift+r", "g p", "shift+g p"]) {
      const { value, run } = action(shortcut);
      expect(dispatcher.handle(keyEvent(shortcut.includes("g") ? "g" : "r", { target: child, shiftKey: shortcut.startsWith("shift") }), [value])).toBe(false);
      expect(run).not.toHaveBeenCalled();
    }
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      const { value, run } = action(modifiers.altKey === true ? "alt+k" : "mod+k");
      expect(dispatcher.handle(keyEvent("k", { target: child, ...modifiers }), [value])).toBe(true);
      expect(run).toHaveBeenCalledOnce();
    }
    const sequence = action("mod+g p");
    expect(dispatcher.handle(keyEvent("g", { target: child, ctrlKey: true }), [sequence.value])).toBe(true);
    expect(dispatcher.handle(keyEvent("p", { target: child }), [sequence.value])).toBe(true);
    expect(sequence.run).toHaveBeenCalledOnce();
  });

  it("detects editable fields through a shadow composed path", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const input = host.attachShadow({ mode: "open" }).appendChild(document.createElement("input"));
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("r");
    const listener = vi.fn((event: KeyboardEvent) => {
      expect(dispatcher.handle(event, [value])).toBe(false);
    });
    host.addEventListener("keydown", listener);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, composed: true }));
    expect(listener).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([false, true])("resets pending sequences when the actual target changes (shadow: %s)", (shadow) => {
    const host = document.body.appendChild(document.createElement("div"));
    const parent = shadow ? host.attachShadow({ mode: "open" }) : host;
    const first = parent.appendChild(document.createElement("button"));
    const second = parent.appendChild(document.createElement("button"));
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("g p");
    const handled: boolean[] = [];
    host.addEventListener("keydown", (event) => handled.push(dispatcher.handle(event, [value])));
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true, composed: true }));
    second.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true, composed: true }));
    expect(handled).toEqual([true, false]);
    expect(run).not.toHaveBeenCalled();
  });

  it("Escape cancels pending sequences instead of executing an Escape binding", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const sequence = action("g p");
    const escape = action("escape");
    const actions = [sequence.value, escape.value];
    expect(dispatcher.handle(keyEvent("g"), actions)).toBe(true);
    expect(dispatcher.handle(keyEvent("Escape"), actions)).toBe(true);
    expect(dispatcher.handle(keyEvent("p"), actions)).toBe(false);
    expect(sequence.run).not.toHaveBeenCalled();
    expect(escape.run).not.toHaveBeenCalled();
  });

  it("ignores composing events without advancing pending sequences", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("g p");
    expect(dispatcher.handle(keyEvent("g", { isComposing: true }), [value])).toBe(false);
    expect(dispatcher.handle(keyEvent("g"), [value])).toBe(true);
    expect(dispatcher.handle(keyEvent("Escape", { isComposing: true }), [value])).toBe(false);
    expect(dispatcher.handle(keyEvent("p", { isComposing: true }), [value])).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(dispatcher.handle(keyEvent("p"), [value])).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "reset"])("clears pending sequences on %s", (reason) => {
    vi.useFakeTimers();
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("g p");
    expect(dispatcher.handle(keyEvent("g"), [value])).toBe(true);
    if (reason === "reset") dispatcher.reset();
    else vi.advanceTimersByTime(1200);
    expect(dispatcher.handle(keyEvent("p"), [value])).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs an enabled matching modified shortcut", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("mod+k");

    const handled = dispatcher.handle(keyEvent("k", { metaKey: true }), [value]);

    expect(handled).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs plain letters outside editable fields", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("r");

    const handled = dispatcher.handle(keyEvent("r"), [value]);

    expect(handled).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("matches manually typed Ctrl shortcuts as the cross-platform Mod modifier", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("ctrl+k");

    const handled = dispatcher.handle(keyEvent("k", { ctrlKey: true }), [value]);

    expect(handled).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs shift-only shortcuts outside editable fields", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("shift+r");

    const handled = dispatcher.handle(keyEvent("r", { shiftKey: true }), [value]);

    expect(handled).toBe(true);
    expect(run).toHaveBeenCalledOnce();
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

  it.each(["r", "shift+r", "g p"])("accepts %s", (shortcut) => {
    expect(parseShortcutInput(shortcut)).toEqual({ ok: true, shortcut, tokens: shortcut.split(" ") });
  });

  it("builds canonical tokens from recorded key events", () => {
    expect(shortcutTokenFromEvent(keyEvent("K", { metaKey: true, shiftKey: true }))).toBe("mod+shift+k");
    expect(shortcutTokenFromEvent(keyEvent("ArrowDown", { altKey: true }))).toBe("alt+arrowdown");
  });
});
