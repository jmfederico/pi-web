import { EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { promptArgumentHintState, setPromptArgumentHint } from "./promptArgumentHint";

const unrelatedEffect = StateEffect.define();
const hint = { pos: 4, text: "<PR-URL>" };

function createState(doc = "/pr "): EditorState {
  return EditorState.create({ doc, extensions: [promptArgumentHintState] });
}

function stateWithHint(): EditorState {
  return createState().update({ effects: setPromptArgumentHint.of(hint) }).state;
}

describe("prompt argument hint state", () => {
  it("starts empty and shows the hint when the effect fires", () => {
    expect(createState().field(promptArgumentHintState)).toBeNull();
    expect(stateWithHint().field(promptArgumentHintState)).toEqual(hint);
  });

  it("clears the hint on the next document change", () => {
    const next = stateWithHint().update({ changes: { from: 4, insert: "https://" } }).state;
    expect(next.field(promptArgumentHintState)).toBeNull();
  });

  it("clears the hint when the cursor moves without an edit", () => {
    const next = stateWithHint().update({ selection: EditorSelection.cursor(0) }).state;
    expect(next.field(promptArgumentHintState)).toBeNull();
  });

  it("clears the hint on an explicit dismiss effect", () => {
    const next = stateWithHint().update({ effects: setPromptArgumentHint.of(null) }).state;
    expect(next.field(promptArgumentHintState)).toBeNull();
  });

  it("survives transactions that neither edit nor move the cursor", () => {
    const next = stateWithHint().update({ effects: unrelatedEffect.of(null) }).state;
    expect(next.field(promptArgumentHintState)).toEqual(hint);
  });
});
