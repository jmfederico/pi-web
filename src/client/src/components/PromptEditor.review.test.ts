// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewComment } from "../review/reviewTypes";
import type { ReviewSendSnapshot } from "../controllers/reviewController";
import { PromptEditor } from "./PromptEditor";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

function comment(id: string, filePath: string, start: number, end: number, body: string, createdAt = 0): ReviewComment {
  return {
    id,
    anchor: { filePath, range: { side: "new", start, end } },
    body,
    createdAt,
    updatedAt: createdAt,
    sourceHash: "hash",
  };
}

async function mount(editor: PromptEditor): Promise<void> {
  document.body.appendChild(editor);
  await editor.updateComplete;
}

type SendFn = (streamingBehavior?: "steer" | "followUp") => Promise<void>;

function isSendFn(value: unknown): value is SendFn {
  return typeof value === "function";
}

function callSend(editor: PromptEditor, streamingBehavior?: "steer" | "followUp"): Promise<void> {
  const method: unknown = Reflect.get(editor, "send");
  if (!isSendFn(method)) throw new Error("PromptEditor.send was unavailable");
  return method.call(editor, streamingBehavior);
}

function chipRemoveButtons(editor: PromptEditor): HTMLButtonElement[] {
  const root = editor.shadowRoot;
  if (root === null) throw new Error("Expected a shadow root");
  return Array.from(root.querySelectorAll<HTMLButtonElement>(".review-chip-remove"));
}

function chipLabels(editor: PromptEditor): string[] {
  const root = editor.shadowRoot;
  if (root === null) throw new Error("Expected a shadow root");
  return Array.from(root.querySelectorAll(".review-chip")).map((chip) => chip.textContent.trim());
}

describe("PromptEditor empty-submit guard with review comments", () => {
  it("does not block send() when there is no text/attachments but a review comment is pending", async () => {
    const editor = new PromptEditor();
    editor.reviewComments = [comment("review-1", "src/a.ts", 1, 1, "fix this")];
    const onSend = vi.fn().mockResolvedValue(undefined);
    editor.onSend = onSend;
    editor.onReviewBeginSend = () => ({ ids: ["review-1"], markdown: "Code review comments:\n\n- src/a.ts:1: fix this" });
    await mount(editor);

    await callSend(editor);

    expect(onSend).toHaveBeenCalledOnce();
  });

  it("still blocks send() when text, attachments, and review comments are all empty", async () => {
    const editor = new PromptEditor();
    const onSend = vi.fn();
    editor.onSend = onSend;
    await mount(editor);

    await callSend(editor);

    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("PromptEditor review chips", () => {
  it("renders one chip per comment, ordered like sortComments, with the coordinate label and a body snippet", async () => {
    const editor = new PromptEditor();
    editor.reviewComments = [
      comment("review-2", "src/b.ts", 5, 5, "second file comment", 2),
      comment("review-1", "src/a.ts", 1, 3, "first file comment", 1),
    ];
    await mount(editor);

    const labels = chipLabels(editor);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain("src/a.ts:1-3");
    expect(labels[0]).toContain("first file comment");
    expect(labels[1]).toContain("src/b.ts:5");
    expect(labels[1]).toContain("second file comment");
  });

  it("calls onReviewRemove with the comment id when a chip's × is clicked", async () => {
    const editor = new PromptEditor();
    const target = comment("review-1", "src/a.ts", 1, 1, "fix this");
    editor.reviewComments = [target];
    const onReviewRemove = vi.fn();
    editor.onReviewRemove = onReviewRemove;
    await mount(editor);

    const [button] = chipRemoveButtons(editor);
    if (button === undefined) throw new Error("Expected a chip remove button");
    button.click();

    expect(onReviewRemove).toHaveBeenCalledWith("review-1");
  });

  it("disables the × button while reviewSendLocked is true", async () => {
    const editor = new PromptEditor();
    editor.reviewComments = [comment("review-1", "src/a.ts", 1, 1, "fix this")];
    editor.reviewSendLocked = true;
    await mount(editor);

    const [button] = chipRemoveButtons(editor);
    if (button === undefined) throw new Error("Expected a chip remove button");
    expect(button.disabled).toBe(true);
  });
});

describe("PromptEditor review-bearing send flow", () => {
  function snapshot(): ReviewSendSnapshot {
    return { ids: ["review-1"], markdown: "Code review comments:\n\n- src/a.ts:1: fix this" };
  }

  it("composes the sent body from text + markdown, marks hasReviewContent, and completes the send on success", async () => {
    const editor = new PromptEditor();
    editor.reviewComments = [comment("review-1", "src/a.ts", 1, 1, "fix this")];
    const onReviewBeginSend = vi.fn().mockReturnValue(snapshot());
    const onReviewCompleteSend = vi.fn();
    const onReviewAbortSend = vi.fn();
    const onSend = vi.fn().mockResolvedValue(true);
    editor.onReviewBeginSend = onReviewBeginSend;
    editor.onReviewCompleteSend = onReviewCompleteSend;
    editor.onReviewAbortSend = onReviewAbortSend;
    editor.onSend = onSend;
    await mount(editor);
    Reflect.set(editor, "draft", "please look");

    await callSend(editor);

    expect(onReviewBeginSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith(
      "please look\n\nCode review comments:\n\n- src/a.ts:1: fix this",
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(onReviewCompleteSend).toHaveBeenCalledWith(["review-1"]);
    expect(onReviewAbortSend).not.toHaveBeenCalled();
    // resetComposer clears the draft, not the review comments (the component
    // does not clear them itself -- the parent does via completeSend/abortSend).
    expect(Reflect.get(editor, "draft")).toBe("");
    expect(editor.reviewComments).toHaveLength(1);
  });

  it("sends markdown-only body when the text draft is empty", async () => {
    const editor = new PromptEditor();
    editor.reviewComments = [comment("review-1", "src/a.ts", 1, 1, "fix this")];
    editor.onReviewBeginSend = () => snapshot();
    const onSend = vi.fn().mockResolvedValue(true);
    editor.onSend = onSend;
    await mount(editor);

    await callSend(editor);

    expect(onSend).toHaveBeenCalledWith(
      "Code review comments:\n\n- src/a.ts:1: fix this",
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
  });

  it("aborts the send (and does not complete it) when onSend resolves false", async () => {
    const editor = new PromptEditor();
    editor.reviewComments = [comment("review-1", "src/a.ts", 1, 1, "fix this")];
    editor.onReviewBeginSend = () => snapshot();
    const onReviewCompleteSend = vi.fn();
    const onReviewAbortSend = vi.fn();
    editor.onReviewCompleteSend = onReviewCompleteSend;
    editor.onReviewAbortSend = onReviewAbortSend;
    editor.onSend = vi.fn().mockResolvedValue(false);
    await mount(editor);

    await callSend(editor);

    expect(onReviewAbortSend).toHaveBeenCalledOnce();
    expect(onReviewCompleteSend).not.toHaveBeenCalled();
  });

  it("aborts the send when onSend throws/rejects", async () => {
    const editor = new PromptEditor();
    editor.reviewComments = [comment("review-1", "src/a.ts", 1, 1, "fix this")];
    editor.onReviewBeginSend = () => snapshot();
    const onReviewCompleteSend = vi.fn();
    const onReviewAbortSend = vi.fn();
    editor.onReviewCompleteSend = onReviewCompleteSend;
    editor.onReviewAbortSend = onReviewAbortSend;
    editor.onSend = vi.fn().mockRejectedValue(new Error("network down"));
    await mount(editor);

    await callSend(editor);

    expect(onReviewAbortSend).toHaveBeenCalledOnce();
    expect(onReviewCompleteSend).not.toHaveBeenCalled();
  });

  it("treats an onSend resolving undefined (legacy void callers) as success", async () => {
    const editor = new PromptEditor();
    editor.reviewComments = [comment("review-1", "src/a.ts", 1, 1, "fix this")];
    editor.onReviewBeginSend = () => snapshot();
    const onReviewCompleteSend = vi.fn();
    editor.onReviewCompleteSend = onReviewCompleteSend;
    editor.onSend = vi.fn().mockResolvedValue(undefined);
    await mount(editor);

    await callSend(editor);

    expect(onReviewCompleteSend).toHaveBeenCalledWith(["review-1"]);
  });
});

describe("PromptEditor fast path with zero review comments", () => {
  it("never touches onReviewBeginSend/onReviewCompleteSend/onReviewAbortSend", async () => {
    const editor = new PromptEditor();
    const onReviewBeginSend = vi.fn();
    const onReviewCompleteSend = vi.fn();
    const onReviewAbortSend = vi.fn();
    editor.onReviewBeginSend = onReviewBeginSend;
    editor.onReviewCompleteSend = onReviewCompleteSend;
    editor.onReviewAbortSend = onReviewAbortSend;
    const onSend = vi.fn();
    editor.onSend = onSend;
    await mount(editor);
    Reflect.set(editor, "draft", "plain message");

    await callSend(editor);

    expect(onReviewBeginSend).not.toHaveBeenCalled();
    expect(onReviewCompleteSend).not.toHaveBeenCalled();
    expect(onReviewAbortSend).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith("plain message", undefined, undefined, undefined, undefined);
  });
});
