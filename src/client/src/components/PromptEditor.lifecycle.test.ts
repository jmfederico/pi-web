// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlashCommand } from "../api";
import { api } from "../api";
import type { PromptEditor as PromptEditorElement } from "./PromptEditor";
import type { AutocompleteMenu } from "./AutocompleteMenu";

const { PromptEditor } = await loadPromptEditor();

async function loadPromptEditor() {
  const notice = "Lit is in dev mode. Not recommended for production! See https://lit.dev/msg/dev-mode for more information.";
  const originalWarn = console.warn;
  const warnings = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    if (args.length === 1 && args[0] === notice) return;
    originalWarn(...args);
  });
  try {
    const module = await import("./PromptEditor");
    expect(warnings.mock.calls).toEqual([[notice]]);
    return module;
  } finally {
    warnings.mockRestore();
  }
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("PromptEditor completion reset lifecycle", () => {
  it.each(["session", "machine"] as const)("synchronizes an empty %s draft without a redundant host update", async (change) => {
    const editor = new PromptEditor();
    editor.sessionId = "session-a";
    editor.cwd = "/repo";
    document.body.append(editor);
    expect(await editor.updateComplete).toBe(true);
    editor.replaceText("Hello");
    expect(await editor.updateComplete).toBe(true);
    expect(editor.view?.state.doc.toString()).toBe("Hello");

    if (change === "session") editor.sessionId = "session-b";
    else editor.machineId = "remote-b";
    const firstComplete = await editor.updateComplete;

    expect(editor.view?.state.doc.toString()).toBe("");
    expect(editor.view?.state.selection.main.head).toBe(0);
    expect(firstComplete).toBe(true);
    expect(editor.isUpdatePending).toBe(false);
    expect(completionMenu(editor).items).toEqual([]);

    // The original machine/session draft survives switching away and back.
    if (change === "session") editor.sessionId = "session-a";
    else editor.machineId = "local";
    expect(await editor.updateComplete).toBe(true);
    expect(editor.view?.state.doc.toString()).toBe("Hello");
    expect(editor.isUpdatePending).toBe(false);
  });

  it("clears a populated menu and resets selection when the document has no trigger", async () => {
    vi.spyOn(api, "commands").mockResolvedValue([
      { name: "tree", source: "builtin" },
      { name: "trim", source: "prompt" },
    ]);
    const editor = new PromptEditor();
    editor.sessionId = "session-a";
    editor.cwd = "/repo";
    document.body.append(editor);
    expect(await editor.updateComplete).toBe(true);
    editDocument(editor, "/tr");
    await vi.waitFor(() => {
      expect(completionMenu(editor).shadowRoot?.querySelectorAll("button")).toHaveLength(2);
    });
    const view = editor.view;
    if (view === undefined) throw new Error("Expected a mounted CodeMirror editor");
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, composed: true, cancelable: true }));
    expect(await editor.updateComplete).toBe(true);
    expect(completionMenu(editor).selectedIndex).toBe(1);

    editDocument(editor, "Hello");
    expect(await editor.updateComplete).toBe(true);
    expect(editor.isUpdatePending).toBe(false);
    expect(completionMenu(editor).items).toEqual([]);
    expect(completionMenu(editor).selectedIndex).toBe(0);
    await completionMenu(editor).updateComplete;
    expect(completionMenu(editor).shadowRoot?.querySelector("button")).toBeNull();
    expect(view.state.doc.toString()).toBe("Hello");
  });

  it.each(["document", "session", "machine"] as const)("invalidates an in-flight command request when the %s changes to a no-trigger draft", async (change) => {
    let resolveCommands!: (commands: SlashCommand[]) => void;
    const pending = new Promise<SlashCommand[]>((resolve) => { resolveCommands = resolve; });
    const commands = vi.spyOn(api, "commands").mockReturnValue(pending);
    const editor = new PromptEditor();
    editor.sessionId = "session-a";
    editor.cwd = "/repo";
    document.body.append(editor);
    expect(await editor.updateComplete).toBe(true);
    editDocument(editor, "/tr");
    expect(commands.mock.calls).toEqual([[{ id: "session-a", cwd: "/repo" }, "local"]]);

    if (change === "document") editDocument(editor, "Hello");
    else if (change === "session") editor.sessionId = "session-b";
    else editor.machineId = "remote-b";
    const firstComplete = await editor.updateComplete;
    expect(editor.view?.state.doc.toString()).toBe(change === "document" ? "Hello" : "");
    expect(firstComplete).toBe(true);
    expect(editor.isUpdatePending).toBe(false);
    expect(completionMenu(editor).items).toEqual([]);

    resolveCommands([{ name: "tree", source: "builtin" }]);
    await pending;
    // Allow the real async refresh continuation to apply or discard its response.
    await Promise.resolve();
    expect(await editor.updateComplete).toBe(true);
    await completionMenu(editor).updateComplete;
    expect(completionMenu(editor).items).toEqual([]);
    expect(completionMenu(editor).shadowRoot?.querySelector("button")).toBeNull();
    expect(editor.view?.state.doc.toString()).toBe(change === "document" ? "Hello" : "");
    expect(editor.isUpdatePending).toBe(false);
  });
});

function editDocument(editor: PromptEditorElement, text: string): void {
  const view = editor.view;
  if (view === undefined) throw new Error("Expected a mounted CodeMirror editor");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } });
}

function completionMenu(editor: PromptEditorElement): AutocompleteMenu {
  const menu = editor.shadowRoot?.querySelector<AutocompleteMenu>("autocomplete-menu");
  if (menu === null || menu === undefined) throw new Error("Expected the rendered completion menu");
  return menu;
}
