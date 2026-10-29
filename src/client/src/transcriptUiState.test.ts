import { expect, it } from "vitest";
import { TranscriptUiState } from "./transcriptUiState";

it("merges only boolean intents without retaining caller content or mutable objects", () => {
  const state = new TranscriptUiState();
  const patch = { textOpen: false, source: "large output", node: { element: true } };
  state.setTool("machine/session/part", patch);
  patch.textOpen = true;
  // @ts-expect-error Exercise the untyped caller boundary with non-boolean data.
  state.setTool("machine/session/part", { diffOpen: true, showFullDiff: "source" });
  expect(state.getTool("machine/session/part")).toEqual({ textOpen: false, diffOpen: true });
  expect(Object.isFrozen(state.getTool("machine/session/part"))).toBe(true);
  expect(new TranscriptUiState().getTool("machine/session/part")).toBeUndefined();
});

it("bounds retained tools and evicts the least recently read or written identity", () => {
  const state = new TranscriptUiState(2);
  state.setTool("a", { textOpen: true });
  state.setTool("b", { diffOpen: false });
  state.getTool("a");
  state.setTool("c", { showFullDiff: true });
  expect(state.getTool("b")).toBeUndefined();
  state.setTool("a", { textOpen: false });
  state.setTool("d", { diffOpen: true });
  expect(state.getTool("c")).toBeUndefined();
  expect(state.getTool("a")).toEqual({ textOpen: false });
  expect(state.getTool("d")).toEqual({ diffOpen: true });
});

it("rejects invalid capacity limits", () => {
  for (const limit of [0, -1, 1.5, Infinity]) expect(() => new TranscriptUiState(limit)).toThrow(RangeError);
});
