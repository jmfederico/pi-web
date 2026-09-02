// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewComment } from "../review/reviewTypes";
import { ReviewThread, type ReviewThreadDraft } from "./ReviewThread";

afterEach(() => {
  document.body.replaceChildren();
});

describe("ReviewThread :host white-space reset", () => {
  it("resets :host's white-space instead of inheriting CodeMirror's `.cm-content` white-space", () => {
    // Root cause (found via live CDP inspection against a running app,
    // 2026-08-22 morning): `.cm-content` sets `white-space: break-spaces`
    // for code display, an INHERITED CSS property. `<pi-web-review-thread>`
    // is mounted as a light-DOM child of `.cm-content` (a CM6 block
    // widget), and `:host` never resets `white-space`, so it inherits
    // `break-spaces` from that ancestor. That makes the plain indentation/
    // newline whitespace TEXT NODES surrounding `.thread` in Lit's own
    // rendered template (an artifact of the multi-line `html\`...\`` tagged
    // template literal in `render()`) render as LITERAL, visible, wrapped
    // multi-line content instead of collapsing per normal HTML whitespace
    // rules -- adding a large, unexplained gap above and below the actual
    // card content (confirmed live: exactly matched two extra 16px line
    // boxes on each side of `.thread`, entirely accounted for by this).
    // `:host` must set its own explicit `white-space`, so it stops
    // inheriting a code-editor-specific value from wherever it happens to
    // be mounted.
    const cssText = ReviewThread.styles.toString();
    const hostRule = /:host\s*\{[^}]*\}/.exec(cssText)?.[0] ?? "";
    expect(hostRule).toMatch(/white-space:\s*normal/);
  });

  it("gives the whole box a small amount of breathing room via :host padding", () => {
    // Once the white-space bug above stopped being (accidentally) treated
    // as vertical spacing, the box sat flush against the surrounding code
    // lines with no gap at all. `:host` is a single shared source of
    // vertical breathing room for both the Files (CM6) and Git surfaces;
    // Git's own wrapper (`.git-review-thread`) only carries its
    // Git-specific horizontal indent now, not vertical padding, so this
    // isn't doubled up there.
    const cssText = ReviewThread.styles.toString();
    const hostRule = /:host\s*\{[^}]*\}/.exec(cssText)?.[0] ?? "";
    expect(hostRule).toMatch(/padding:\s*0\.2em 0\.4em/);
  });
});

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: overrides.id ?? "review-1",
    anchor: overrides.anchor ?? { filePath: "src/app.ts", range: { side: "new", start: 12, end: 12 } },
    body: overrides.body ?? "Nice fix",
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    sourceHash: overrides.sourceHash ?? "hash-1",
  };
}

function draft(overrides: Partial<ReviewThreadDraft> = {}): ReviewThreadDraft {
  return {
    anchor: overrides.anchor ?? { filePath: "src/app.ts", range: { side: "new", start: 20, end: 20 } },
    body: overrides.body ?? "",
  };
}

async function mount(props: Partial<ReviewThread> = {}): Promise<ReviewThread> {
  const element = document.createElement("pi-web-review-thread");
  Object.assign(element, props);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function root(element: ReviewThread): ShadowRoot {
  const shadowRoot = element.shadowRoot;
  if (shadowRoot === null) throw new Error("Expected pi-web-review-thread shadow root");
  return shadowRoot;
}

function buttonWithText(shadowRoot: ShadowRoot | Element, text: string): HTMLButtonElement {
  const button = [...shadowRoot.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === text);
  if (button === undefined) throw new Error(`Expected button named ${text}`);
  return button;
}

function textareaAt(shadowRoot: ShadowRoot | Element, index = 0): HTMLTextAreaElement {
  const textarea = shadowRoot.querySelectorAll("textarea")[index];
  if (textarea === undefined) throw new Error(`Expected textarea at index ${String(index)}`);
  return textarea;
}

function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("pi-web-review-thread", () => {
  it("renders nothing but its empty shell with no comments and no draft", async () => {
    const element = await mount();
    // Runtime reference to the class (not just the type) so the bundler
    // cannot elide this import as type-only and skip the customElements
    // registration side effect (see AskUserCard.test.ts for the same pattern).
    expect(customElements.get("pi-web-review-thread")).toBe(ReviewThread);
    const shadowRoot = root(element);
    expect(shadowRoot.querySelectorAll(".card")).toHaveLength(0);
  });

  it("renders comment body and coordinate caption", async () => {
    const element = await mount({ comments: [comment({ body: "Consider renaming this.", anchor: { filePath: "src/app.ts", range: { side: "new", start: 12, end: 15 } } })] });
    const shadowRoot = root(element);
    expect(shadowRoot.textContent).toContain("Consider renaming this.");
    expect(shadowRoot.textContent).toContain("src/app.ts:12-15");
  });

  it("opens the action menu, edits a comment, and saves the new body", async () => {
    const onUpdate = vi.fn();
    const element = await mount({ comments: [comment({ id: "review-1", body: "Original body" })], onUpdate });
    const shadowRoot = root(element);

    buttonWithText(shadowRoot, "⋯").click();
    await element.updateComplete;
    buttonWithText(shadowRoot, "Edit").click();
    await element.updateComplete;

    const editor = textareaAt(shadowRoot);
    expect(editor.value).toBe("Original body");
    typeInto(editor, "Edited body");
    await element.updateComplete;
    buttonWithText(shadowRoot, "Save").click();
    await element.updateComplete;

    expect(onUpdate).toHaveBeenCalledWith("review-1", "Edited body", expect.any(Object));
    expect(shadowRoot.querySelectorAll("textarea")).toHaveLength(0);
    expect(shadowRoot.textContent).toContain("Original body");
  });

  it("disables Save while the edited body is empty or whitespace-only, without calling onUpdate", async () => {
    const onUpdate = vi.fn();
    const element = await mount({ comments: [comment({ id: "review-1", body: "Original body" })], onUpdate });
    const shadowRoot = root(element);

    buttonWithText(shadowRoot, "⋯").click();
    await element.updateComplete;
    buttonWithText(shadowRoot, "Edit").click();
    await element.updateComplete;

    typeInto(textareaAt(shadowRoot), "   ");
    await element.updateComplete;
    expect(buttonWithText(shadowRoot, "Save").disabled).toBe(true);
    buttonWithText(shadowRoot, "Save").click();
    expect(onUpdate).not.toHaveBeenCalled();

    typeInto(textareaAt(shadowRoot), "Real edit");
    await element.updateComplete;
    expect(buttonWithText(shadowRoot, "Save").disabled).toBe(false);
  });

  it("reverts without calling onUpdate when edit is cancelled", async () => {
    const onUpdate = vi.fn();
    const element = await mount({ comments: [comment({ body: "Original body" })], onUpdate });
    const shadowRoot = root(element);

    buttonWithText(shadowRoot, "⋯").click();
    await element.updateComplete;
    buttonWithText(shadowRoot, "Edit").click();
    await element.updateComplete;
    typeInto(textareaAt(shadowRoot), "Discarded edit");
    await element.updateComplete;
    buttonWithText(shadowRoot, "Cancel").click();
    await element.updateComplete;

    expect(onUpdate).not.toHaveBeenCalled();
    expect(shadowRoot.textContent).toContain("Original body");
    expect(shadowRoot.textContent).not.toContain("Discarded edit");
  });

  it("calls onRemove immediately for Delete, without a confirmation dialog", async () => {
    const onRemove = vi.fn();
    const element = await mount({ comments: [comment({ id: "review-9" })], onRemove });
    const shadowRoot = root(element);

    buttonWithText(shadowRoot, "⋯").click();
    await element.updateComplete;
    buttonWithText(shadowRoot, "Delete").click();
    await element.updateComplete;

    expect(onRemove).toHaveBeenCalledWith("review-9");
  });

  it("renders a draft textarea with the coordinate caption and submits typed text on Comment", async () => {
    const onSubmitDraft = vi.fn();
    const onCancelDraft = vi.fn();
    const element = await mount({ draft: draft({ anchor: { filePath: "src/app.ts", range: { side: "old", start: 8, end: 9 } } }), onSubmitDraft, onCancelDraft });
    const shadowRoot = root(element);

    expect(shadowRoot.textContent).toContain("src/app.ts:8-9 (deleted)");
    typeInto(textareaAt(shadowRoot), "New comment text");
    await element.updateComplete;
    buttonWithText(shadowRoot, "Comment").click();

    expect(onSubmitDraft).toHaveBeenCalledWith("New comment text", expect.objectContaining({
      filePath: "src/app.ts",
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      range: expect.objectContaining({ side: "old", start: 8, end: 9 }),
    }));
    expect(onCancelDraft).not.toHaveBeenCalled();
  });

  it("disables the Comment button while the draft body is empty or whitespace-only", async () => {
    const onSubmitDraft = vi.fn();
    const element = await mount({ draft: draft(), onSubmitDraft });
    const shadowRoot = root(element);

    // Empty from the start.
    expect(buttonWithText(shadowRoot, "Comment").disabled).toBe(true);

    // Whitespace-only is not a real comment either.
    typeInto(textareaAt(shadowRoot), "   \n  ");
    await element.updateComplete;
    expect(buttonWithText(shadowRoot, "Comment").disabled).toBe(true);
    buttonWithText(shadowRoot, "Comment").click();
    expect(onSubmitDraft).not.toHaveBeenCalled();

    // Real content enables it again.
    typeInto(textareaAt(shadowRoot), "Actual comment");
    await element.updateComplete;
    expect(buttonWithText(shadowRoot, "Comment").disabled).toBe(false);
  });

  it("does not auto-submit the draft on blur, only on explicit Comment click", async () => {
    const onSubmitDraft = vi.fn();
    const element = await mount({ draft: draft(), onSubmitDraft });
    const shadowRoot = root(element);

    const textarea = textareaAt(shadowRoot);
    typeInto(textarea, "Typed but not submitted");
    textarea.dispatchEvent(new Event("blur", { bubbles: true }));
    await element.updateComplete;

    expect(onSubmitDraft).not.toHaveBeenCalled();
  });

  it("cancels the draft without submitting when Cancel is clicked", async () => {
    const onSubmitDraft = vi.fn();
    const onCancelDraft = vi.fn();
    const element = await mount({ draft: draft(), onSubmitDraft, onCancelDraft });
    const shadowRoot = root(element);

    typeInto(textareaAt(shadowRoot), "Abandoned draft");
    await element.updateComplete;
    buttonWithText(shadowRoot, "Cancel").click();

    expect(onCancelDraft).toHaveBeenCalledTimes(1);
    expect(onSubmitDraft).not.toHaveBeenCalled();
  });

  it("works when created imperatively via document.createElement outside a Lit render tree", async () => {
    const onRemove = vi.fn();
    const element = document.createElement("pi-web-review-thread");
    element.comments = [comment({ id: "review-standalone", body: "Standalone mount" })];
    element.onRemove = onRemove;
    document.body.appendChild(element);
    await element.updateComplete;

    const shadowRoot = root(element);
    expect(shadowRoot.textContent).toContain("Standalone mount");
    buttonWithText(shadowRoot, "⋯").click();
    await element.updateComplete;
    buttonWithText(shadowRoot, "Delete").click();

    expect(onRemove).toHaveBeenCalledWith("review-standalone");
  });

  it("renders multiple comments independently, editing one without affecting the other", async () => {
    const onUpdate = vi.fn();
    const element = await mount({
      comments: [comment({ id: "review-a", body: "First comment" }), comment({ id: "review-b", body: "Second comment" })],
      onUpdate,
    });
    const shadowRoot = root(element);

    const cards = shadowRoot.querySelectorAll(".card");
    expect(cards).toHaveLength(2);
    const firstCard = cards[0];
    if (firstCard === undefined) throw new Error("Expected first .card");

    buttonWithText(firstCard, "⋯").click();
    await element.updateComplete;
    buttonWithText(shadowRoot, "Edit").click();
    await element.updateComplete;

    expect(shadowRoot.querySelectorAll("textarea")).toHaveLength(1);
    expect(shadowRoot.textContent).toContain("Second comment");

    typeInto(textareaAt(shadowRoot), "First comment edited");
    await element.updateComplete;
    buttonWithText(shadowRoot, "Save").click();
    await element.updateComplete;

    expect(onUpdate).toHaveBeenCalledWith("review-a", "First comment edited", expect.any(Object));
    expect(shadowRoot.textContent).toContain("Second comment");
  });

  it("submits the draft on Enter keydown when the body is not empty", async () => {
    const onSubmitDraft = vi.fn();
    const element = await mount({ draft: draft(), onSubmitDraft });
    const shadowRoot = root(element);

    const textarea = textareaAt(shadowRoot);
    typeInto(textarea, "Draft comment");
    await element.updateComplete;

    const enterEvent = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    textarea.dispatchEvent(enterEvent);
    await element.updateComplete;

    expect(onSubmitDraft).toHaveBeenCalledWith("Draft comment", expect.any(Object));
  });

  it("does not submit the draft on Enter keydown when the body is empty", async () => {
    const onSubmitDraft = vi.fn();
    const element = await mount({ draft: draft(), onSubmitDraft });
    const shadowRoot = root(element);

    const textarea = textareaAt(shadowRoot);
    const enterEvent = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    textarea.dispatchEvent(enterEvent);
    await element.updateComplete;

    expect(onSubmitDraft).not.toHaveBeenCalled();
  });

  it("does not submit the draft on Enter keydown when the body is whitespace-only", async () => {
    const onSubmitDraft = vi.fn();
    const element = await mount({ draft: draft(), onSubmitDraft });
    const shadowRoot = root(element);

    const textarea = textareaAt(shadowRoot);
    typeInto(textarea, "   \n  ");
    await element.updateComplete;

    const enterEvent = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    textarea.dispatchEvent(enterEvent);
    await element.updateComplete;

    expect(onSubmitDraft).not.toHaveBeenCalled();
  });

  it("saves the edited comment on Enter keydown when the body is not empty", async () => {
    const onUpdate = vi.fn();
    const element = await mount({ comments: [comment()], onUpdate });
    const shadowRoot = root(element);

    buttonWithText(shadowRoot, "⋯").click();
    await element.updateComplete;
    buttonWithText(shadowRoot, "Edit").click();
    await element.updateComplete;

    const textarea = textareaAt(shadowRoot);
    typeInto(textarea, "Edited comment");
    await element.updateComplete;

    const enterEvent = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    textarea.dispatchEvent(enterEvent);
    await element.updateComplete;

    expect(onUpdate).toHaveBeenCalledWith(comment().id, "Edited comment", expect.any(Object));
  });

  it("does not save the edited comment on Enter keydown when the body is empty", async () => {
    const onUpdate = vi.fn();
    const element = await mount({ comments: [comment()], onUpdate });
    const shadowRoot = root(element);

    buttonWithText(shadowRoot, "⋯").click();
    await element.updateComplete;
    buttonWithText(shadowRoot, "Edit").click();
    await element.updateComplete;

    const textarea = textareaAt(shadowRoot);
    textarea.value = "";
    textarea.dispatchEvent(new Event("input"));
    await element.updateComplete;

    const enterEvent = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    textarea.dispatchEvent(enterEvent);
    await element.updateComplete;

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("renders markdown in saved comment bodies", async () => {
    const element = await mount({
      comments: [comment({ id: "review-md", body: "This is **bold** and this is `code` and [link](http://example.com)" })],
    });
    const shadowRoot = root(element);
    const body = shadowRoot.querySelector(".body");

    expect(body?.innerHTML).toContain("<strong>bold</strong>");
    expect(body?.innerHTML).toContain("<code>code</code>");
    expect(body?.innerHTML).toContain('href="http://example.com"');
  });

  it("renders markdown list items and blockquotes in comments", async () => {
    const element = await mount({
      comments: [comment({ id: "review-list", body: "- Item 1\n- Item 2\n\n> A quote" })],
    });
    const shadowRoot = root(element);
    const body = shadowRoot.querySelector(".body");

    expect(body?.innerHTML).toContain("<li>Item 1</li>");
    expect(body?.innerHTML).toContain("<li>Item 2</li>");
    expect(body?.innerHTML).toContain("<blockquote>");
    expect(body?.innerHTML).toContain("A quote");
  });

  it("renders single line without range notation", async () => {
    const element = await mount({ draft: draft({ anchor: { filePath: "src/app.ts", range: { side: "new", start: 42, end: 42 } } }) });
    const shadowRoot = root(element);

    expect(shadowRoot.textContent).toContain("src/app.ts:42");
    expect(shadowRoot.textContent).not.toContain("-");
  });

  it("sends updated anchor when Comment is clicked", async () => {
    const onSubmitDraft = vi.fn();
    const element = await mount({ draft: draft(), onSubmitDraft });
    const shadowRoot = root(element);

    const textarea = textareaAt(shadowRoot);
    typeInto(textarea, "Updated comment");
    await element.updateComplete;

    buttonWithText(shadowRoot, "Comment").click();
    await element.updateComplete;

    expect(onSubmitDraft).toHaveBeenCalledWith("Updated comment", expect.objectContaining({
      filePath: "src/app.ts",
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      range: expect.objectContaining({ start: 20, end: 20 }),
    }));
  });

  it("submits draft with modified line range", async () => {
    const onSubmitDraft = vi.fn();
    const element = await mount({ draft: draft({ anchor: { filePath: "src/test.ts", range: { side: "new", start: 5, end: 10 } } }), onSubmitDraft });
    const shadowRoot = root(element);

    const textarea = textareaAt(shadowRoot);
    typeInto(textarea, "Test comment with range change");
    await element.updateComplete;

    // Click line number to open edit form
    const lineNumber = shadowRoot.querySelector(".line-number-clickable");
    if (lineNumber instanceof HTMLElement) {
      lineNumber.click();
      await element.updateComplete;

      // Change start line to 3
      const inputs = shadowRoot.querySelectorAll("input[type=\"number\"]");
      const startInput = inputs[0];
      if (startInput instanceof HTMLInputElement) {
        startInput.value = "3";
        startInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await element.updateComplete;
    }

    // Submit
    buttonWithText(shadowRoot, "Comment").click();
    await element.updateComplete;

    expect(onSubmitDraft).toHaveBeenCalledWith("Test comment with range change", expect.objectContaining({
      filePath: "src/test.ts",
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      range: expect.objectContaining({ side: "new", start: 3, end: 10 }),
    }));
  });


});
