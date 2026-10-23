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

it("keeps the empty prompt hint out of editable text and restores it after clearing", async () => {
  const editor = new PromptEditor();
  editors.push(editor);
  document.body.append(editor);
  await editor.updateComplete;
  const view = editor.view;
  if (!view) throw new Error("Prompt editor did not mount");

  const assertEmptyHint = () => {
    expect(view.state.doc.toString()).toBe("");
    expect(view.contentDOM.textContent).toBe("");
    const hint = view.contentDOM.querySelector(".prompt-placeholder");
    expect(hint?.getAttribute("data-placeholder")).toBe(view.contentDOM.getAttribute("aria-placeholder"));
    expect(hint?.getAttribute("data-placeholder")).toContain("# for models");
    expect(hint?.closest(".cm-placeholder")?.getAttribute("aria-hidden")).toBe("true");
  };
  assertEmptyHint();

  editor.replaceText("Hello");
  expect(view.contentDOM.textContent).toBe("Hello");
  expect(view.contentDOM.querySelector(".cm-placeholder")).toBeNull();

  editor.replaceText("");
  assertEmptyHint();
});
