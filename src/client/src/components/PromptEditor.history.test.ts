// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { PromptEditor, promptHistoryFromMessages } from "./PromptEditor";
import { api } from "../api";
import { loadDraft } from "../promptDraftStorage";
import { machineSessionKey } from "../machineKeys";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

async function mount() {
  const editor = new PromptEditor();
  editor.sessionId = "history";
  editor.promptHistory = ["first prompt", "second prompt"];
  editor.onSend = vi.fn();
  document.body.append(editor);
  await editor.updateComplete;
  return editor;
}

function press(editor: PromptEditor, key: string, options: KeyboardEventInit = {}) {
  editor.view?.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...options }));
}

it("recalls loaded user prompts in order and restores the unsent draft", async () => {
  const editor = await mount();
  editor.replaceText("unsent draft");
  press(editor, "ArrowUp");
  expect(editor.view?.state.doc.toString()).toBe("second prompt");
  press(editor, "ArrowUp");
  expect(editor.view?.state.doc.toString()).toBe("first prompt");
  press(editor, "ArrowUp");
  expect(editor.view?.state.doc.toString()).toBe("first prompt");
  press(editor, "ArrowDown");
  expect(editor.view?.state.doc.toString()).toBe("second prompt");
  press(editor, "ArrowDown");
  expect(editor.view?.state.doc.toString()).toBe("unsent draft");
  expect(editor.view?.state.selection.main.head).toBe("unsent draft".length);
  expect(editor.onSend).not.toHaveBeenCalled();
});

it("preserves plugin context and activity controls while recalling prompts", async () => {
  const editor = await mount();
  const chip = { id: "note", pluginId: "notes", key: "note-key", label: "Selected note", text: "Plugin context",
    target: { machineId: "local", sessionId: "history" } };
  editor.promptChips = [chip];
  editor.onRemoveChip = vi.fn();
  editor.isCompacting = true;
  editor.replaceText("unsent draft");
  await editor.updateComplete;

  press(editor, "ArrowUp");
  await editor.updateComplete;
  expect(editor.view?.state.doc.toString()).toBe("second prompt");
  expect(editor.shadowRoot?.querySelector('[aria-label="Pending plugin context"]')?.textContent).toContain("Selected note");
  expect(editor.shadowRoot?.querySelector('[role="status"]')?.textContent).toContain("Compacting history");
  press(editor, "ArrowDown");
  expect(editor.view?.state.doc.toString()).toBe("unsent draft");
  editor.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Remove Selected note"]')?.click();
  expect(editor.onRemoveChip).toHaveBeenCalledExactlyOnceWith(chip);
  expect(editor.onSend).not.toHaveBeenCalled();
});

it("freezes history while browsing and resets on edits or programmatic replacement", async () => {
  const editor = await mount();
  editor.replaceText("draft");
  press(editor, "ArrowUp");
  editor.promptHistory = ["prepended", "first prompt", "second prompt", "new prompt"];
  await editor.updateComplete;
  press(editor, "ArrowUp");
  expect(editor.view?.state.doc.toString()).toBe("first prompt");
  editor.view?.dispatch({ changes: { from: 0, insert: "edited " } });
  press(editor, "ArrowUp");
  expect(editor.view?.state.doc.toString()).toBe("new prompt");
  press(editor, "ArrowDown");
  expect(editor.view?.state.doc.toString()).toBe("edited first prompt");
  editor.replaceText("replacement");
  press(editor, "ArrowUp"); press(editor, "ArrowDown");
  expect(editor.view?.state.doc.toString()).toBe("replacement");
});

it("leaves multiline editing, selections, modifiers and IME input alone", async () => {
  const editor = await mount();
  editor.replaceText("top\nbottom");
  press(editor, "ArrowUp");
  expect(editor.view?.state.doc.toString()).toBe("top\nbottom");
  editor.view?.dispatch({ selection: { anchor: 0, head: 3 } });
  press(editor, "ArrowUp");
  expect(editor.view?.state.doc.toString()).toBe("top\nbottom");
  editor.replaceText("draft");
  press(editor, "ArrowUp", { shiftKey: true });
  expect(editor.view?.state.doc.toString()).toBe("draft");
  press(editor, "ArrowUp", { isComposing: true });
  expect(editor.view?.state.doc.toString()).toBe("draft");
});

it.each(["machine", "session"])("does not carry recalled prompts across a %s switch", async (kind) => {
  const editor = await mount();
  editor.replaceText("original draft");
  press(editor, "ArrowUp");
  if (kind === "machine") editor.machineId = "remote";
  else editor.sessionId = "other";
  editor.promptHistory = [];
  await editor.updateComplete;
  expect(loadDraft(machineSessionKey("local", "history"))).toBe("original draft");
  press(editor, "ArrowUp");
  expect(editor.view?.state.doc.toString()).toBe("");
});

it("gives autocomplete priority over history", async () => {
  vi.spyOn(api, "commands").mockResolvedValue([{ name: "alpha", source: "builtin" }, { name: "beta", source: "builtin" }]);
  const editor = await mount();
  editor.cwd = "/repo";
  await editor.updateComplete;
  editor.view?.dispatch({ changes: { from: 0, insert: "/" }, selection: { anchor: 1 } });
  await vi.waitFor(() => { expect(editor.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.textContent).toContain("alpha"); });
  press(editor, "ArrowUp");
  expect(editor.view?.state.doc.toString()).toBe("/");
  press(editor, "Enter");
  expect(editor.view?.state.doc.toString()).toBe("/beta ");
});

it("extracts original user text, not display replacements, tools or assistant output", () => {
  expect(promptHistoryFromMessages([
    { role: "assistant", parts: [{ type: "text", text: "ignore" }] },
    { role: "user", parts: [{ type: "text", text: "original", displayText: "pretty" }, { type: "text", text: "more" }] },
    { role: "tool", parts: [{ type: "text", text: "ignore" }] },
    { role: "user", parts: [{ type: "text", text: " " }] },
  ])).toEqual(["original\n\nmore"]);
});
