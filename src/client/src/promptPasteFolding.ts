import { EditorState } from "@codemirror/state";
import { codeFolding, foldEffect } from "@codemirror/language";
import { isLargeText, textSizeLabel } from "./largeText";

// Folding decorates the document, so drafts, undo and send keep the actual text.
export const promptPasteFolding = [
  codeFolding({
    preparePlaceholder: (state, range) => textSizeLabel(state.sliceDoc(range.from, range.to)),
    placeholderDOM: (_view, expand, label: unknown) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cm-foldPlaceholder";
      button.textContent = `Pasted ${typeof label === "string" ? label : "text"}`;
      button.setAttribute("aria-label", `Expand pasted text: ${button.textContent}`);
      button.addEventListener("click", expand);
      return button;
    },
  }),
  EditorState.transactionExtender.of((transaction) => {
    if (!transaction.isUserEvent("input.paste")) return null;
    const ranges: { from: number; to: number }[] = [];
    transaction.changes.iterChanges((_from, _to, from, to, inserted) => {
      if (isLargeText(inserted.toString())) ranges.push({ from, to });
    });
    return { effects: ranges.map((range) => foldEffect.of(range)) };
  }),
];
