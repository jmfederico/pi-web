// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import { COMPOSER_SEND_DESKTOP, COMPOSER_SEND_MOBILE } from "../composerShortcuts";
import { installPopoverFake } from "./anchoredPopup.testSupport";
import { PromptEditor } from "./PromptEditor";

installPopoverFake();
const matchMedia = window.matchMedia.bind(window);

beforeEach(() => {
  stubPointer(false);
  // CodeMirror measurement belongs to browser tests, not the styling contract.
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubPointer(coarse: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const media = matchMedia(query);
    Object.defineProperty(media, "matches", { configurable: true, value: query.includes("pointer: coarse") && coarse });
    return media;
  });
}

function status(): SessionStatus {
  return {
    sessionId: "styling", model: { provider: "test", id: "first-model" }, thinkingLevel: "low",
    isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
  };
}

async function mount(shortcut: string | null = "mod+enter") {
  const editor = new PromptEditor();
  editor.shortcuts = { [COMPOSER_SEND_DESKTOP]: shortcut, [COMPOSER_SEND_MOBILE]: shortcut };
  editor.status = status();
  editor.onSend = vi.fn();
  document.body.append(editor);
  await editor.updateComplete;
  return editor;
}

function required(editor: PromptEditor, selector: string): HTMLElement {
  const element = editor.renderRoot.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`Missing composer element: ${selector}`);
  return element;
}

function action(editor: PromptEditor, name: string) {
  const button = required(editor, `button[data-composer-action="${name}"]`);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Expected native button: ${name}`);
  return button;
}

function root(editor: PromptEditor) {
  return required(editor, '[data-ui-context="composer"]');
}

function expectDefault(editor: PromptEditor, expected: "send" | "queue" | "steer" | "none") {
  expect(root(editor).dataset["defaultAction"]).toBe(expected);
  const eligible = editor.renderRoot.querySelectorAll<HTMLButtonElement>('[data-composer-action="send"], [data-composer-action="queue"], [data-composer-action="steer"]');
  for (const button of eligible) {
    const selected = expected !== "none" && button.dataset["composerAction"] === expected;
    expect(button.getAttribute("data-default")).toBe(String(selected));
  }
  expect(editor.renderRoot.querySelectorAll('[data-default="true"]')).toHaveLength(expected === "none" ? 0 : 1);
  expect(action(editor, "stop").hasAttribute("data-default")).toBe(false);
}

describe("composer styling contract", () => {
  it("exposes composer anatomy and initial state through supported hooks", async () => {
    const editor = await mount();
    const footer = root(editor);
    const toolbar = required(editor, ".ui-composer-toolbar");
    expect(footer.contains(toolbar)).toBe(true);
    expect(toolbar.contains(required(editor, ".ui-composer-settings"))).toBe(true);
    expect(required(editor, ".ui-composer-actions").parentElement).toBe(toolbar);
    for (const name of ["model", "thinking", "attach", "send", "stop"]) {
      expect(action(editor, name).classList.contains("ui-button")).toBe(true);
    }
    expect(footer.dataset).toMatchObject({ mode: "text", busy: "false", disabled: "false", compacting: "false" });
    // An empty draft does not remove the configured default.
    expectDefault(editor, "send");
  });

  it("refreshes default-action hooks as streaming preference and compaction change", async () => {
    const editor = await mount();
    const primary = action(editor, "send");
    editor.canSteer = true;
    await editor.updateComplete;
    expect(action(editor, "queue")).toBe(primary);
    expectDefault(editor, "steer");
    editor.defaultStreamingBehavior = "followUp";
    await editor.updateComplete;
    expectDefault(editor, "queue");
    editor.defaultStreamingBehavior = "steer";
    editor.isCompacting = true;
    await editor.updateComplete;
    expect(root(editor).dataset["compacting"]).toBe("true");
    expectDefault(editor, "queue");
    editor.canSteer = false;
    editor.isCompacting = false;
    await editor.updateComplete;
    expect(root(editor).dataset["compacting"]).toBe("false");
    expectDefault(editor, "send");
  });

  it("clears the default hook when submission has no configured shortcut", async () => {
    const editor = await mount(null);
    expectDefault(editor, "none");
  });

  it.each(["disabled", "sending"] as const)("distinguishes native disabled controls from busy state for %s", async (property) => {
    const editor = await mount();
    editor.canSteer = true;
    editor.canStop = true;
    editor.onStop = vi.fn();
    editor[property] = true;
    await editor.updateComplete;
    expect(root(editor).dataset["busy"]).toBe(String(property === "sending"));
    expect(root(editor).dataset["disabled"]).toBe(String(property === "disabled"));
    expectDefault(editor, "none");
    for (const name of ["attach", "queue", "steer"]) expect(action(editor, name).disabled).toBe(true);
    const stop = action(editor, "stop");
    expect(stop.disabled).toBe(property === "disabled");
    stop.click();
    expect(editor.onStop).toHaveBeenCalledTimes(property === "disabled" ? 0 : 1);
    editor[property] = false;
    await editor.updateComplete;
    expectDefault(editor, "steer");
    expect(action(editor, "queue").disabled).toBe(false);
  });

  it("marks chip acknowledgment pending as busy until delivery settles", async () => {
    const editor = await mount();
    editor.promptChips = [{ id: "context", key: "context", pluginId: "test", target: { machineId: "local", sessionId: "styling" }, label: "Context", text: "Context content" }];
    let acknowledge: ((accepted: boolean) => void) | undefined;
    const pending = new Promise<boolean>((resolve) => { acknowledge = resolve; });
    editor.onSend = vi.fn(() => pending);
    await editor.updateComplete;
    action(editor, "send").click();
    await editor.updateComplete;
    expect(editor.sending).toBe(false);
    expect(root(editor).dataset["busy"]).toBe("true");
    expect(root(editor).dataset["disabled"]).toBe("false");
    expect(action(editor, "send").disabled).toBe(true);
    expectDefault(editor, "none");
    acknowledge?.(true);
    await pending;
    await editor.updateComplete;
    expect(root(editor).dataset["busy"]).toBe("false");
    expectDefault(editor, "send");
  });

  it("exposes model and thinking purposes without claiming externally owned dialog state", async () => {
    const editor = await mount();
    editor.onSelectModel = vi.fn();
    editor.onSelectThinking = vi.fn();
    action(editor, "model").click();
    action(editor, "thinking").click();
    expect(editor.onSelectModel).toHaveBeenCalledOnce();
    expect(editor.onSelectThinking).toHaveBeenCalledOnce();
    for (const name of ["model", "thinking"]) {
      expect(action(editor, name).hasAttribute("aria-expanded")).toBe(false);
      expect(action(editor, name).hasAttribute("aria-controls")).toBe(false);
    }
  });

  it("reports shell mode only when the shell UI actually renders", async () => {
    const editor = await mount();
    editor.replaceText("!pwd");
    await editor.updateComplete;
    expect(root(editor).dataset["mode"]).toBe("shell");
    editor.promptChips = [{ id: "context", key: "context", pluginId: "test", target: { machineId: "local", sessionId: "styling" }, label: "Context", text: "Context content" }];
    await editor.updateComplete;
    expect(root(editor).dataset["mode"]).toBe("text");
  });

  it.each([false, true])("exposes attachment popup ownership only on Android (%s)", async (android) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(android ? "Mozilla/5.0 (Linux; Android 14)" : "Unknown browser");
    const editor = await mount();
    const attach = action(editor, "attach");
    const panel = required(editor, '[data-ui-context="composer-attachment-sources"]');
    expect(panel.matches(".ui-menu.ui-popup-panel[popover]")).toBe(true);
    expect(attach.classList.contains("ui-popup-trigger")).toBe(android);
    for (const name of ["attach-photos", "attach-camera", "attach-files"]) {
      expect(panel.contains(action(editor, name))).toBe(true);
      expect(action(editor, name).matches(".ui-button.ui-menu-item")).toBe(true);
    }
    expect(attach.getAttribute("aria-controls")).toBe(android ? panel.id : null);
    expect(attach.getAttribute("aria-expanded")).toBe(android ? "false" : null);
    if (android) {
      attach.click();
      await editor.updateComplete;
      expect(attach.getAttribute("aria-expanded")).toBe("true");
      panel.hidePopover();
      await editor.updateComplete;
      expect(attach.getAttribute("aria-expanded")).toBe("false");
    }
  });
});
