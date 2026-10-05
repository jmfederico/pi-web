// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { foldedRanges } from "@codemirror/language";
import { undo, redo } from "@codemirror/commands";
import { PromptEditor } from "./PromptEditor";
import { KNOWN_THINKING_LEVELS } from "../../../shared/thinkingLevels";
import { loadDraft } from "../promptDraftStorage";
import { machineSessionKey } from "../machineKeys";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

async function mount() {
  const element = new PromptEditor();
  element.sessionId = "paste-test";
  element.onSend = vi.fn();
  document.body.append(element);
  await element.updateComplete;
  return element;
}

it("folds only large pasted ranges while preserving surrounding text, undo, drafts and submission", async () => {
  const element = await mount();
  const view = element.view;
  if (view === undefined) throw new Error("Missing prompt editor");
  element.replaceText("before  after");
  const text = Array.from({ length: 12 }, (_, n) => `line ${String(n)}`).join("\n");
  view.dispatch({ changes: { from: 7, insert: text }, selection: { anchor: 7 + text.length }, userEvent: "input.paste" });
  expect(foldedRanges(view.state).size).toBe(1);
  expect(view.state.doc.toString()).toBe(`before ${text} after`);
  expect(loadDraft(machineSessionKey("local", "paste-test"))).toBe(`before ${text} after`);
  expect(view.dom.querySelector(".cm-foldPlaceholder")?.textContent).toContain("12 lines");
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe("before  after");
  expect(foldedRanges(view.state).size).toBe(0);
  expect(redo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(`before ${text} after`);
  element.shadowRoot?.querySelector<HTMLButtonElement>(".send-button")?.click();
  expect(element.onSend).toHaveBeenCalledWith(`before ${text} after`, undefined, undefined, undefined, undefined);
});

it("expands long single-line pastes for editing and clears folds when changing sessions", async () => {
  const element = await mount();
  const view = element.view;
  if (view === undefined) throw new Error("Missing prompt editor");
  view.dispatch({ changes: { from: 0, insert: "x".repeat(1500) }, selection: { anchor: 1500 }, userEvent: "input.paste" });
  const unfold = view.dom.querySelector<HTMLButtonElement>(".cm-foldPlaceholder");
  expect(unfold?.getAttribute("aria-label")).toContain("Expand pasted text");
  unfold?.click();
  expect(foldedRanges(view.state).size).toBe(0);
  expect(view.state.doc.length).toBe(1500);
  view.dispatch({ changes: { from: 1500, insert: "y".repeat(1500) }, selection: { anchor: 3000 }, userEvent: "input.paste" });
  expect(foldedRanges(view.state).size).toBe(1);
  element.sessionId = "another-session";
  await element.updateComplete;
  expect(view.state.doc.length).toBe(0);
  expect(foldedRanges(view.state).size).toBe(0);
});

it("does not fold short pastes or programmatic draft replacements", async () => {
  const element = await mount();
  const view = element.view;
  if (view === undefined) throw new Error("Missing prompt editor");
  view.dispatch({ changes: { from: 0, insert: "short\npaste" }, userEvent: "input.paste" });
  expect(foldedRanges(view.state).size).toBe(0);
  element.replaceText("long draft\n".repeat(20));
  expect(foldedRanges(view.state).size).toBe(0);
});

it("exposes each thinking level and keeps model/thinking controls actionable", async () => {
  const element = await mount();
  element.onSelectModel = vi.fn();
  element.onSelectThinking = vi.fn();
  for (const level of [...KNOWN_THINKING_LEVELS, "future-level"]) {
    element.status = {
      sessionId: "paste-test", isStreaming: false, isCompacting: false, isBashRunning: false,
      pendingMessageCount: 0, queuedMessages: [], cost: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      model: { id: "model", provider: "provider" }, thinkingLevel: level,
    };
    await element.updateComplete;
    const thinking = element.shadowRoot?.querySelector<HTMLButtonElement>(".select-thinking");
    expect(thinking?.dataset["thinking"]).toBe(level);
    expect(thinking?.textContent).toContain(level);
    expect(thinking?.getAttribute("aria-label")).toBe(`Thinking level: ${level}`);
    thinking?.click();
  }
  element.shadowRoot?.querySelector<HTMLButtonElement>(".select-model")?.click();
  expect(element.onSelectModel).toHaveBeenCalledOnce();
  expect(element.onSelectThinking).toHaveBeenCalledTimes(8);
});
