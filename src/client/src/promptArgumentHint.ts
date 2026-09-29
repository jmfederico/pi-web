import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";

/** Position and text of the one-shot argument hint ghost in the prompt editor. */
export interface PromptArgumentHint {
  pos: number;
  text: string;
}

/** Show the argument hint ghost at a position, or dismiss it with `null`. */
export const setPromptArgumentHint = StateEffect.define<PromptArgumentHint | null>();

/**
 * One-shot reminder of the arguments a picked slash command expects (e.g.
 * `<PR-URL>`). The hint is deliberately ephemeral: it survives until the next
 * edit or cursor move, whichever comes first, so it can never linger as stale
 * advice once the user starts typing real arguments or navigates away.
 */
export const promptArgumentHintState = StateField.define<PromptArgumentHint | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setPromptArgumentHint)) return effect.value;
    }
    if (tr.docChanged || tr.selection !== undefined) return null;
    return value;
  },
});

class ArgumentHintWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  override eq(other: ArgumentHintWidget): boolean {
    return other.text === this.text;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-argument-hint";
    span.textContent = this.text;
    return span;
  }
}

/** Editor extension rendering the current argument hint as dimmed ghost text. */
export const promptArgumentHintExtension: Extension = [
  promptArgumentHintState,
  EditorView.decorations.compute([promptArgumentHintState], (state) => {
    const hint = state.field(promptArgumentHintState);
    if (hint === null) return Decoration.none;
    return Decoration.set([Decoration.widget({ widget: new ArgumentHintWidget(hint.text), side: 1 }).range(hint.pos)]);
  }),
];
