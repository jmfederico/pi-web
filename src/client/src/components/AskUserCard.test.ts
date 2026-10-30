// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskUserOutcome, AskUserQuestion, AskUserRequest } from "../../../shared/apiTypes";
import { loadAskDraft, saveAskDraft } from "../askDrafts";
import { AskUserCard, type AskUserSubmitCallback } from "./AskUserCard";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("ask-user-card live form", () => {
  it("uses native labelled groups and updates progress for a keyboard-focusable single select", async () => {
    const card = await mountOpenAsk(openAsk([
      question("editor", "Choose an editor", [option("vim", "Vim"), option("code", "VS Code")], { detail: "Used for examples." }),
      question("platforms", "Target platforms", [option("web", "Web"), option("desktop", "Desktop")], { multiple: true }),
    ]));
    const root = renderRoot(card);
    expect(card).toBeInstanceOf(HTMLElement);
    expect(customElements.get("ask-user-card")).toBe(AskUserCard);
    const fieldsets = root.querySelectorAll("fieldset");
    const legends = root.querySelectorAll("legend");
    const vim = inputWithValue(root, "vim");
    const code = inputWithValue(root, "code");
    const web = inputWithValue(root, "web");

    expect(fieldsets).toHaveLength(2);
    expect(legends[0]?.textContent).toContain("Choose an editor");
    expect(fieldsets[0]?.getAttribute("aria-describedby")).toBe("ask-user-question-detail-0");
    expect(root.querySelector("#ask-user-question-detail-0")?.textContent).toBe("Used for examples.");
    expect(vim.type).toBe("radio");
    expect(code.name).toBe(vim.name);
    expect(web.type).toBe("checkbox");
    expect(web.name).not.toBe(vim.name);
    expect(root.querySelector("[aria-live='polite']")?.textContent).toContain("0 of 2 answered");

    // Focus and interaction run through the rendered native control rather than
    // extracting Lit handlers, so this exercises the form's browser boundary.
    vim.focus();
    expect(root.activeElement).toBe(vim);
    vim.click();
    await card.updateComplete;

    expect(vim.checked).toBe(true);
    expect(code.checked).toBe(false);
    expect(root.querySelector("[aria-live='polite']")?.textContent).toContain("1 of 2 answered");
  });

  it("accumulates several checkbox values for a multi-select question", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      question("platforms", "Target platforms", [option("web", "Web"), option("desktop", "Desktop")], { multiple: true }),
    ]), onSubmit);
    const root = renderRoot(card);

    inputWithValue(root, "web").click();
    inputWithValue(root, "desktop").click();
    await card.updateComplete;

    expect(root.querySelector("[aria-live='polite']")?.textContent).toContain("1 of 1 answered");
    buttonWithText(root, "Send answers").click();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith("ask-1", {
      answers: [{ id: "platforms", values: ["web", "desktop"] }],
    });
  });

  it("always offers and focuses a labelled custom field while preserving multi-select options", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      question("stack", "Pick the stack", [option("lit", "Lit"), option("react", "React")], { multiple: true }),
    ]), onSubmit);
    const root = renderRoot(card);

    inputWithValue(root, "lit").click();
    inputWithValue(root, "__pi_web_other__").click();
    await card.updateComplete;
    await Promise.resolve();

    const textarea = requiredElement(root.querySelector("textarea"), "custom textarea");
    const label = fieldLabel(root, textarea);
    expect(label.textContent).toContain("Custom answer");
    expect(textarea.classList.contains("ui-input")).toBe(true);
    expect(root.activeElement).toBe(textarea);

    textarea.value = "Svelte";
    textarea.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await card.updateComplete;
    buttonWithText(root, "Send answers").click();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith("ask-1", {
      answers: [{ id: "stack", values: ["lit"], otherText: "Svelte" }],
    });
  });

  it("shows and submits the custom field directly when no options were supplied", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      question("notes", "Anything else?", []),
    ]), onSubmit);
    const root = renderRoot(card);
    const textarea = requiredElement(root.querySelector("textarea"), "custom textarea");

    expect(root.querySelector("input")).toBeNull();
    expect(root.textContent).not.toContain("Add a comment");
    expect(root.querySelectorAll("textarea")).toHaveLength(1);
    expect(commentTextareas(root)).toHaveLength(0);
    expect(fieldLabel(root, textarea).textContent).toContain("Custom answer");
    textarea.value = "Keep the first version small.";
    textarea.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await card.updateComplete;
    buttonWithText(root, "Send answers").click();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith("ask-1", {
      answers: [{ id: "notes", values: [], otherText: "Keep the first version small." }],
    });
  });

  it("skips all questions explicitly without sending retained draft values", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([question("editor", "Choose an editor", [option("vim", "Vim")])]), onSubmit);
    inputWithValue(renderRoot(card), "vim").click();
    await card.updateComplete;
    buttonWithText(renderRoot(card), "Skip questions").click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith("ask-1", { answers: [] });
    card.open = false;
    await card.updateComplete;
    expect(renderRoot(card).textContent).toContain("Draft answer · not sent");
    expect(renderRoot(card).textContent).toContain("Vim");
  });

  it("submits a comment together with the selection it was typed beside", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      question("editor", "Choose an editor", [option("vim", "Vim"), option("code", "VS Code")]),
    ]), onSubmit);
    const root = renderRoot(card);
    expect(root.querySelectorAll("textarea")).toHaveLength(0);
    expect(root.textContent).not.toContain("Add a comment");
    inputWithValue(root, "vim").click();
    await card.updateComplete;
    expect(root.querySelectorAll("textarea")).toHaveLength(0);
    const addComment = buttonWithText(root, "Add a comment");
    addComment.focus();
    expect(root.activeElement).toBe(addComment);
    addComment.click();
    await card.updateComplete;
    const comment = commentTextarea(root, 0);
    expect(root.activeElement).toBe(comment);
    expect(onSubmit).not.toHaveBeenCalled();

    expect(root.querySelectorAll("textarea")).toHaveLength(1);
    expect(comment.classList.contains("ui-input")).toBe(true);
    expect(fieldLabel(root, comment).getAttribute("for")).toBe(comment.id);
    expect(fieldLabel(root, comment).textContent).toContain("Comment (optional)");
    expect(root.textContent).not.toContain("Add a comment");
    typeInto(comment, "Only for quick edits.");
    await card.updateComplete;
    // Changing the selection afterwards must not discard the comment.
    inputWithValue(root, "code").click();
    await card.updateComplete;

    expect(commentTextarea(root, 0).value).toBe("Only for quick edits.");
    expect(root.querySelector("[aria-live='polite']")?.textContent).toContain("1 of 1 answered");
    buttonWithText(root, "Send answers").click();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith("ask-1", {
      answers: [{ id: "editor", values: ["code"], comment: "Only for quick edits." }],
    });
  });

  it("hides but retains the comment when the last offered checkbox is cleared", async () => {
    const card = await mountOpenAsk(openAsk([
      question("platforms", "Target platforms", [option("web", "Web"), option("desktop", "Desktop")], { multiple: true }),
    ]));
    const root = renderRoot(card);
    expect(root.querySelectorAll("textarea")).toHaveLength(0);

    inputWithValue(root, "web").click();
    inputWithValue(root, "desktop").click();
    await card.updateComplete;
    buttonWithText(root, "Add a comment").click();
    await card.updateComplete;
    typeInto(commentTextarea(root, 0), "Desktop later, maybe.");
    await card.updateComplete;
    inputWithValue(root, "desktop").click();
    await card.updateComplete;
    expect(commentTextarea(root, 0).value).toBe("Desktop later, maybe.");

    inputWithValue(root, "web").click();
    await card.updateComplete;
    expect(root.querySelectorAll("textarea")).toHaveLength(0);
    expect(root.querySelector("[aria-live='polite']")?.textContent).toContain("0 of 1 answered");
    expect(loadAskDraft("local:session-1", "ask-1")).toEqual({
      platforms: { values: [], comment: "Desktop later, maybe.", commentOpen: true },
    });

    inputWithValue(root, "web").click();
    await card.updateComplete;
    expect(commentTextarea(root, 0).value).toBe("Desktop later, maybe.");
  });

  it.each([false, true])("replaces a comment with a separate custom answer (multiple: %s)", async (multiple) => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      question("editor", "Choose an editor", [option("vim", "Vim")], { multiple }),
    ]), onSubmit);
    const root = renderRoot(card);
    inputWithValue(root, "vim").click();
    await card.updateComplete;
    buttonWithText(root, "Add a comment").click();
    await card.updateComplete;
    typeInto(commentTextarea(root, 0), "Only for quick edits.");
    await card.updateComplete;

    inputWithValue(root, "__pi_web_other__").click();
    await card.updateComplete;
    const custom = requiredElement(root.querySelector("textarea"), "custom textarea");
    expect(root.querySelectorAll("textarea")).toHaveLength(1);
    expect(commentTextareas(root)).toHaveLength(0);
    expect(root.textContent).not.toContain("Add a comment");
    expect(fieldLabel(root, custom).textContent).toContain("Custom answer");
    expect(custom.value).toBe("");
    expect(root.activeElement).toBe(custom);
    typeInto(custom, "Emacs");
    await card.updateComplete;
    expect(loadAskDraft("local:session-1", "ask-1")).toEqual({
      editor: {
        values: multiple ? ["vim"] : [], otherText: "Emacs", customSelected: true,
        comment: "Only for quick edits.", commentOpen: true,
      },
    });

    buttonWithText(root, "Send answers").click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith("ask-1", {
      answers: [{ id: "editor", values: multiple ? ["vim"] : [], otherText: "Emacs" }],
    });
  });

  it.each([false, true])("does not reinterpret a custom answer as a comment (multiple: %s)", async (multiple) => {
    const card = await mountOpenAsk(openAsk([
      question("editor", "Choose an editor", [option("vim", "Vim")], { multiple }),
    ]));
    const root = renderRoot(card);
    inputWithValue(root, "__pi_web_other__").click();
    await card.updateComplete;
    typeInto(requiredElement(root.querySelector("textarea"), "custom textarea"), "Emacs");
    await card.updateComplete;

    inputWithValue(root, "vim").click();
    await card.updateComplete;
    if (multiple) {
      expect(commentTextareas(root)).toHaveLength(0);
      expect(requiredElement(root.querySelector("textarea"), "custom textarea").value).toBe("Emacs");
      inputWithValue(root, "__pi_web_other__").click();
      await card.updateComplete;
    }
    expect(root.querySelectorAll("textarea")).toHaveLength(0);
    expect(buttonWithText(root, "Add a comment")).toBeDefined();
  });

  it("closes a comment without sending or losing its draft, including across reloads", async () => {
    const ask = openAsk([question("editor", "Choose an editor", [option("vim", "Vim")])]);
    const card = await mountOpenAsk(ask);
    const root = renderRoot(card);
    inputWithValue(root, "vim").click();
    await card.updateComplete;
    buttonWithText(root, "Add a comment").click();
    await card.updateComplete;
    typeInto(commentTextarea(root, 0), "Only for quick edits.");
    await card.updateComplete;
    const close = requiredElement(root.querySelector<HTMLButtonElement>('button[aria-label="Close comment"]'), "close comment");
    close.click();
    await card.updateComplete;
    expect(commentTextareas(root)).toHaveLength(0);
    expect(root.activeElement).toBe(buttonWithText(root, "Add a comment"));
    expect(loadAskDraft("local:session-1", "ask-1")).toMatchObject({
      editor: { comment: "Only for quick edits.", commentOpen: false },
    });

    card.remove();
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const reloaded = await mountOpenAsk(ask, onSubmit);
    const reloadedRoot = renderRoot(reloaded);
    expect(commentTextareas(reloadedRoot)).toHaveLength(0);
    buttonWithText(reloadedRoot, "Send answers").click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith("ask-1", { answers: [{ id: "editor", values: ["vim"] }] });
    buttonWithText(reloadedRoot, "Add a comment").click();
    await reloaded.updateComplete;
    expect(commentTextarea(reloadedRoot, 0).value).toBe("Only for quick edits.");
  });

  it.each([false, true])("restores separate custom and comment buffers when switching and reloading (multiple: %s)", async (multiple) => {
    const ask = openAsk([question("editor", "Choose an editor", [option("vim", "Vim")], { multiple })]);
    const card = await mountOpenAsk(ask);
    const root = renderRoot(card);
    inputWithValue(root, "vim").click();
    await card.updateComplete;
    buttonWithText(root, "Add a comment").click();
    await card.updateComplete;
    typeInto(commentTextarea(root, 0), "Only for quick edits.");
    await card.updateComplete;
    inputWithValue(root, "__pi_web_other__").click();
    await card.updateComplete;
    typeInto(requiredElement(root.querySelector("textarea"), "custom textarea"), "Emacs");
    await card.updateComplete;
    card.remove();

    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const reloaded = await mountOpenAsk(ask, onSubmit);
    const reloadedRoot = renderRoot(reloaded);
    expect(inputWithValue(reloadedRoot, "__pi_web_other__").checked).toBe(true);
    expect(requiredElement(reloadedRoot.querySelector("textarea"), "custom textarea").value).toBe("Emacs");
    expect(commentTextareas(reloadedRoot)).toHaveLength(0);
    inputWithValue(reloadedRoot, multiple ? "__pi_web_other__" : "vim").click();
    await reloaded.updateComplete;
    expect(commentTextarea(reloadedRoot, 0).value).toBe("Only for quick edits.");
    buttonWithText(reloadedRoot, "Send answers").click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith("ask-1", {
      answers: [{ id: "editor", values: ["vim"], comment: "Only for quick edits." }],
    });
    inputWithValue(reloadedRoot, "__pi_web_other__").click();
    await reloaded.updateComplete;
    expect(requiredElement(reloadedRoot.querySelector("textarea"), "custom textarea").value).toBe("Emacs");
  });

  it("keeps an opened empty comment between offered choices without submitting it", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      question("editor", "Choose an editor", [option("vim", "Vim"), option("code", "VS Code")]),
    ]), onSubmit);
    const root = renderRoot(card);
    inputWithValue(root, "vim").click();
    await card.updateComplete;
    buttonWithText(root, "Add a comment").click();
    await card.updateComplete;
    inputWithValue(root, "code").click();
    await card.updateComplete;
    expect(commentTextarea(root, 0).value).toBe("");
    buttonWithText(root, "Send answers").click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith("ask-1", { answers: [{ id: "editor", values: ["code"] }] });
  });

  it("restores a visible comment with its selection after a reload", async () => {
    saveAskDraft("local:session-1", "ask-1", { editor: { values: ["vim"], comment: "Only for quick edits." } });
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      question("editor", "Choose an editor", [option("vim", "Vim")]),
    ]), onSubmit);
    const root = renderRoot(card);
    expect(inputWithValue(root, "vim").checked).toBe(true);
    expect(commentTextarea(root, 0).value).toBe("Only for quick edits.");
    buttonWithText(root, "Send answers").click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith("ask-1", {
      answers: [{ id: "editor", values: ["vim"], comment: "Only for quick edits." }],
    });
  });

  it.each([
    { values: [], otherText: "Emacs" },
    { values: [] },
    { values: ["removed"] },
  ])("retains a hidden comment until an offered option is selected (case %#)", async (draft) => {
    saveAskDraft("local:session-1", "ask-1", { editor: { ...draft, comment: "Old comment" } });
    const card = await mountOpenAsk(openAsk([
      question("editor", "Choose an editor", [option("vim", "Vim")]),
    ]));
    const root = renderRoot(card);
    expect(commentTextareas(root)).toHaveLength(0);
    inputWithValue(root, "vim").click();
    await card.updateComplete;
    expect(commentTextarea(root, 0).value).toBe("Old comment");
  });

  it("names unanswered questions before allowing a partial submit", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      question("editor", "Choose an editor", [option("vim", "Vim")]),
      question("deploy", "Choose a deployment target", [option("cloud", "Cloud")]),
      question("notes", "Add implementation notes", []),
    ]), onSubmit);
    const root = renderRoot(card);

    inputWithValue(root, "vim").click();
    await card.updateComplete;
    buttonWithText(root, "Send answers").click();
    await card.updateComplete;
    await Promise.resolve();

    const confirmation = requiredElement(root.querySelector("[aria-label='Confirm partial answers']"), "partial confirmation");
    expect(confirmation.textContent).toContain("Send without answering these questions?");
    expect(confirmation.textContent).toContain("Choose a deployment target");
    expect(confirmation.textContent).toContain("Add implementation notes");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(root.activeElement).toBe(buttonWithText(root, "Send anyway"));

    buttonWithText(root, "Send anyway").click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith("ask-1", {
      answers: [{ id: "editor", values: ["vim"] }],
    });
  });
});

describe("ask-user-card closed request", () => {
  it("is collapsed and retains every original option and supporting detail without answer controls", async () => {
    const card = new AskUserCard();
    card.ask = openAsk([question("editor", "Choose an editor", [
      { value: "vim", label: "Vim", detail: "Modal editing" },
      { value: "code", label: "VS Code", detail: "Graphical editor" },
    ], { detail: "Used for examples." })]);
    document.body.append(card);
    await card.updateComplete;
    const root = renderRoot(card);
    const disclosure = requiredElement(root.querySelector("details"), "closed question disclosure");
    expect(disclosure.open).toBe(false);
    const summary = requiredElement(disclosure.querySelector("summary"), "question summary");
    expect(summary.classList.contains("ui-transcript-disclosure")).toBe(true);
    expect(summary.querySelector(".disclosure-indicator")).toBeNull();
    expect(summary.textContent).toContain("Questions");
    summary.click();
    expect(disclosure.open).toBe(true);
    expect(root.textContent).toContain("Used for examples.");
    expect(root.textContent).toContain("Vim");
    expect(root.textContent).toContain("Modal editing");
    expect(root.textContent).toContain("VS Code");
    expect(root.textContent).toContain("Graphical editor");
    expect(root.textContent).toContain("Unanswered");
    expect(root.querySelector("input, textarea, button, select")).toBeNull();
  });

  it("restores drafts when the same question is remounted and never makes archived cards writable", async () => {
    const ask = openAsk([question("notes", "Anything else?", [])]);
    const card = await mountOpenAsk(ask);
    const textarea = requiredElement(renderRoot(card).querySelector("textarea"), "draft textarea");
    textarea.value = "Keep this draft";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await card.updateComplete;
    card.remove();
    const restored = await mountOpenAsk(ask);
    expect(renderRoot(restored).querySelector("textarea")?.value).toBe("Keep this draft");
    restored.onSubmit = undefined;
    await restored.updateComplete;
    expect(renderRoot(restored).querySelector("textarea, input, button")).toBeNull();
    expect(renderRoot(restored).textContent).toContain("Keep this draft");
    expect(renderRoot(restored).textContent).toContain("Draft answer · not sent");
  });
});

describe("ask-user-card record mode", () => {
  it("has no answer controls and displays draft answers retained for a superseded ask", async () => {
    const draftSessionId = "remote-a:session-1";
    saveAskDraft(draftSessionId, "ask-old", {
      speed: { values: ["fast"] },
      rationale: { values: [], otherText: "It keeps the feedback loop short." },
    });
    const outcome: AskUserOutcome = {
      askId: "ask-old",
      reason: "superseded",
      askedAt: "2026-07-20T10:00:00.000Z",
      closedAt: "2026-07-20T10:05:00.000Z",
      questions: [
        unansweredRecord(question("speed", "Preferred pace", [option("fast", "Fast"), option("careful", "Careful")])),
        unansweredRecord(question("rationale", "Why?", [])),
        unansweredRecord(question("region", "Deployment region", [option("eu", "Europe")])),
      ],
      answeredCount: 0,
      unansweredIds: ["speed", "rationale", "region"],
      summary: "Answered 0 of 3; unanswered: speed, rationale, region",
    };
    const card = new AskUserCard();
    card.draftSessionId = draftSessionId;
    card.outcome = outcome;
    document.body.append(card);
    await card.updateComplete;
    const root = renderRoot(card);

    expect(root.querySelector("input, textarea, button, select")).toBeNull();
    expect(root.textContent).toContain("Superseded");
    expect(root.textContent).toContain("Fast");
    expect(root.textContent).toContain("It keeps the feedback loop short.");
    expect(root.textContent).toContain("Draft answer · not sent");
    expect(root.textContent).toContain("Deployment region");
    expect(root.textContent).toContain("Unanswered");
  });

  it("shows a submitted answer's comment in the record", async () => {
    const outcome: AskUserOutcome = {
      askId: "ask-2",
      reason: "submitted",
      askedAt: "2026-07-20T10:00:00.000Z",
      closedAt: "2026-07-20T10:05:00.000Z",
      questions: [{
        question: question("speed", "Preferred pace", [option("fast", "Fast")]),
        answered: true,
        values: ["fast"],
        comment: "Ship it once the suite is green.",
      }],
      answeredCount: 1,
      unansweredIds: [],
      summary: "Answered 1 of 1",
    };
    const card = new AskUserCard();
    card.draftSessionId = "local:session-1";
    card.outcome = outcome;
    document.body.append(card);
    await card.updateComplete;
    const root = renderRoot(card);

    expect(root.textContent).toContain("Fast");
    expect(root.textContent).toContain("Comment:");
    expect(root.textContent).toContain("Ship it once the suite is green.");
  });
});

async function mountOpenAsk(ask: AskUserRequest, onSubmit: AskUserSubmitCallback = vi.fn<AskUserSubmitCallback>()): Promise<AskUserCard> {
  const card = new AskUserCard();
  card.ask = ask;
  card.open = true;
  card.draftSessionId = "local:session-1";
  card.onSubmit = onSubmit;
  document.body.append(card);
  await card.updateComplete;
  return card;
}

function renderRoot(card: AskUserCard): ShadowRoot {
  return requiredElement(card.shadowRoot, "ask-user-card shadow root");
}

function fieldLabel(root: ShadowRoot, textarea: HTMLTextAreaElement): HTMLLabelElement {
  return requiredElement(root.querySelector<HTMLLabelElement>(`label[for="${textarea.id}"]`), "textarea label");
}

function commentTextareas(root: ShadowRoot): HTMLTextAreaElement[] {
  return [...root.querySelectorAll<HTMLTextAreaElement>("textarea")]
    .filter((textarea) => fieldLabel(root, textarea).textContent.includes("Comment (optional)"));
}

function commentTextarea(root: ShadowRoot, index: number): HTMLTextAreaElement {
  return requiredElement(commentTextareas(root)[index], `comment textarea ${String(index)}`);
}

function typeInto(textarea: HTMLTextAreaElement, text: string): void {
  textarea.value = text;
  textarea.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

function inputWithValue(root: ShadowRoot, value: string): HTMLInputElement {
  const input = [...root.querySelectorAll("input")].find((candidate) => candidate.value === value);
  return requiredElement(input, `input with value ${value}`);
}

function buttonWithText(root: ShadowRoot, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === text);
  return requiredElement(button, `button named ${text}`);
}

function requiredElement<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label}`);
  return value;
}

function openAsk(questions: AskUserQuestion[]): AskUserRequest {
  return { askId: "ask-1", askedAt: "2026-07-20T10:00:00.000Z", questions };
}

function question(
  id: string,
  text: string,
  options: AskUserQuestion["options"],
  settings: { detail?: string; multiple?: boolean } = {},
): AskUserQuestion {
  return {
    id,
    question: text,
    options,
    ...(settings.detail === undefined ? {} : { detail: settings.detail }),
    ...(settings.multiple === undefined ? {} : { multiple: settings.multiple }),
  };
}

function option(value: string, label: string): AskUserQuestion["options"][number] {
  return { value, label };
}

function unansweredRecord(questionValue: AskUserQuestion): AskUserOutcome["questions"][number] {
  return { question: questionValue, answered: false, values: [] };
}
