// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { promptArgumentHintExtension, promptArgumentHintState } from "../promptArgumentHint";
import { PromptEditor } from "./PromptEditor";
import type { CompletionItem } from "./shared";

afterEach(() => {
  document.body.replaceChildren();
});

describe("PromptEditor argument hint ghost", () => {
  it("shows the hint at the cursor after picking a command and clears it on the next edit", () => {
    const view = createEditorView("/pr");
    try {
      const editor = promptEditorWith(view, "/pr");

      pick(editor, { kind: "command", replaceFrom: 0, replaceTo: 3, insertText: "/pr", detail: "prompt", description: "Review PRs", argumentHint: "<PR-URL>" });

      expect(view.state.doc.toString()).toBe("/pr ");
      expect(view.state.selection.main.head).toBe(4);
      expect(view.state.field(promptArgumentHintState)).toEqual({ pos: 4, text: "<PR-URL>" });

      view.dispatch({ changes: { from: 4, insert: "https://" } });
      expect(view.state.field(promptArgumentHintState)).toBeNull();
    } finally {
      view.destroy();
    }
  });

  it("does not show a hint when picking a command without one", () => {
    const view = createEditorView("/tr");
    try {
      const editor = promptEditorWith(view, "/tr");

      pick(editor, { kind: "command", replaceFrom: 0, replaceTo: 3, insertText: "/tree", detail: "builtin" });

      expect(view.state.doc.toString()).toBe("/tree ");
      expect(view.state.field(promptArgumentHintState)).toBeNull();
    } finally {
      view.destroy();
    }
  });
});

function createEditorView(doc: string): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  return new EditorView({ parent: host, state: EditorState.create({ doc, extensions: [promptArgumentHintExtension] }) });
}

// pick() is private and normally reached through the autocomplete menu; calling
// it through Reflect mirrors the PromptEditor.draft.test.ts seam while a real
// EditorView stands in so the CodeMirror transaction and hint state are genuine.
function promptEditorWith(view: EditorView, draft: string): PromptEditor {
  const editor = new PromptEditor();
  Reflect.set(editor, "editor", view);
  Reflect.set(editor, "draft", draft);
  return editor;
}

function pick(editor: PromptEditor, item: CompletionItem): void {
  const pickMethod: unknown = Reflect.get(editor, "pick");
  if (!isPickMethod(pickMethod)) throw new Error("PromptEditor.pick is not callable");
  pickMethod.call(editor, item);
}

function isPickMethod(value: unknown): value is (this: PromptEditor, item: CompletionItem) => void {
  return typeof value === "function";
}
