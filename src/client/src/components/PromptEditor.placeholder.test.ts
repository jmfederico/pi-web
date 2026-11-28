// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { PromptEditor } from "./PromptEditor";

const editors: PromptEditor[] = [];
afterEach(() => {
  for (const editor of editors) editor.remove();
  editors.length = 0;
  document.body.replaceChildren();
  localStorage.clear();
});

it("keeps the empty prompt hint out of the editable line and restores it after clearing", async () => {
  const editor = new PromptEditor();
  editors.push(editor);
  document.body.append(editor);
  await editor.updateComplete;
  const view = editor.view;
  if (!view) throw new Error("Prompt editor did not mount");

  const assertEmptyHint = () => {
    expect(view.state.doc.toString()).toBe("");
    expect(view.contentDOM.textContent).toBe("");
    // A widget in the empty line makes iOS place the caret after it and
    // CodeMirror correct it, which dismisses the native long-press edit menu.
    expect(view.contentDOM.querySelector(".cm-line")?.innerHTML).toBe("<br>");
    expect(view.contentDOM.hasAttribute("data-empty")).toBe(true);
    expect(view.contentDOM.getAttribute("data-placeholder")).toBe(view.contentDOM.getAttribute("aria-placeholder"));
    expect(view.contentDOM.getAttribute("data-placeholder")).toContain("# for models");
  };
  assertEmptyHint();

  editor.replaceText("Hello");
  expect(view.contentDOM.textContent).toBe("Hello");
  expect(view.contentDOM.hasAttribute("data-empty")).toBe(false);

  editor.replaceText("");
  assertEmptyHint();
});
