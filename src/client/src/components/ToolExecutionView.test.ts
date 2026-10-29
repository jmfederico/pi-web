// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { ToolExecutionView } from "./ToolExecutionView";
import { writeClipboardText } from "../clipboard";
import { TranscriptUiState } from "../transcriptUiState";
import type { ToolExecutionPart } from "../chatTypes";

vi.mock("../clipboard", () => ({ writeClipboardText: vi.fn(() => Promise.resolve(true)) }));

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("keeps command details and complete output while updating live status and errors", async () => {
  const view = new ToolExecutionView();
  const command = "printf 'long output'";
  view.execution = { type: "toolExecution", toolName: "bash", summary: command, args: { command }, status: "running" };
  document.body.append(view);
  await view.updateComplete;
  expect(view.renderRoot.querySelector(".status-label")?.textContent).toBe("running");
  const details = view.renderRoot.querySelector<HTMLDetailsElement>(".text-body");
  expect(details?.open).toBe(false);
  expect(view.renderRoot.querySelector(".detail-target-value")).toBeNull();

  const output = "long line ".repeat(1000);
  view.execution = { ...view.execution, status: "success", resultText: output };
  await view.updateComplete;
  expect(view.renderRoot.querySelector(".status-label")?.textContent).toBe("done");
  expect(view.renderRoot.querySelector(".detail-result")).toBeNull();
  expect(details?.open).toBe(false);
  if (details === null) throw new Error("Expected text disclosure");
  details.open = true; details.dispatchEvent(new Event("toggle"));
  await view.updateComplete;
  expect(view.renderRoot.querySelector(".detail-target-value")?.textContent).toBe(command);
  expect(view.renderRoot.querySelector(".detail-result pre")?.textContent).toBe(output);
  details.open = false; details.dispatchEvent(new Event("toggle"));
  await view.updateComplete;
  expect(view.renderRoot.querySelector(".detail-result")).toBeNull();

  view.execution = { ...view.execution, status: "error", resultText: "Command failed" };
  await view.updateComplete;
  expect(view.renderRoot.querySelector(".status-label")?.textContent).toBe("failed");
  expect(view.renderRoot.querySelector(".error-text")?.textContent).toBe("Command failed");
  expect(details.open).toBe(true);
});

it("retains diff disclosure state, expands long diffs, and copies the full diff", async () => {
  vi.useFakeTimers();
  const view = new ToolExecutionView();
  const diff = Array.from({ length: 200 }, (_, index) => `+line ${String(index)}`).join("\n");
  view.execution = { type: "toolExecution", toolName: "edit", summary: "file.ts", args: { path: "file.ts" }, status: "running", preview: { diff } };
  document.body.append(view);
  await view.updateComplete;
  const details = view.renderRoot.querySelector<HTMLDetailsElement>(".diff-details");
  expect(details?.open).toBe(true);
  expect(view.renderRoot.querySelectorAll(".diff-content > span")).toHaveLength(180);
  if (details === null) throw new Error("Expected diff disclosure");
  details.open = false;
  details.dispatchEvent(new Event("toggle"));
  await view.updateComplete;
  expect(view.renderRoot.querySelector(".diff, .diff-toolbar, .detail-target")).toBeNull();
  const split = vi.spyOn(String.prototype, "split");
  view.execution = { ...view.execution, status: "success", details: { diff } };
  await view.updateComplete;
  expect(details.open).toBe(false);
  expect(view.renderRoot.querySelector(".diff")).toBeNull();
  // The unchanged diff needs neither another statistics scan nor line rendering.
  expect(split.mock.contexts.filter((value) => String(value) === diff)).toHaveLength(0);
  split.mockRestore();
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  await view.updateComplete;

  view.renderRoot.querySelector<HTMLButtonElement>(".show-more")?.click();
  await view.updateComplete;
  expect(view.renderRoot.querySelectorAll(".diff-content > span")).toHaveLength(200);
  expect(view.renderRoot.querySelector(".show-more")).toBeNull();
  const copy = view.renderRoot.querySelector<HTMLButtonElement>(".diff-toolbar button");
  copy?.click();
  await vi.advanceTimersByTimeAsync(0);
  await view.updateComplete;
  expect(writeClipboardText).toHaveBeenCalledWith(diff);
  expect(copy?.textContent).toBe("Copied");
  await vi.advanceTimersByTimeAsync(1200);
  await view.updateComplete;
  expect(copy?.textContent).toBe("Copy diff");
});

const longDiff = Array.from({ length: 200 }, (_, index) => `+line ${String(index)}`).join("\n");
const editExecution: ToolExecutionPart = {
  type: "toolExecution", toolName: "edit", summary: "file.ts", args: { path: "file.ts" },
  status: "success", details: { diff: longDiff },
};

async function mountTool(state?: TranscriptUiState, key?: string, execution = editExecution): Promise<ToolExecutionView> {
  const view = new ToolExecutionView();
  view.uiState = state;
  view.stateKey = key;
  view.execution = execution;
  document.body.append(view);
  await view.updateComplete;
  return view;
}

async function toggle(view: ToolExecutionView, selector: string, open: boolean): Promise<void> {
  const details = view.renderRoot.querySelector<HTMLDetailsElement>(selector);
  if (details === null) throw new Error("Expected disclosure");
  details.open = open;
  details.dispatchEvent(new Event("toggle"));
  await view.updateComplete;
}

it("restores diff choices on remount and isolates rebindings, including native disclosure state", async () => {
  const state = new TranscriptUiState();
  const first = await mountTool(state, "machine/session/a");
  first.renderRoot.querySelector<HTMLButtonElement>(".show-more")?.click();
  await first.updateComplete;
  await toggle(first, ".diff-details", false);
  first.remove();
  const view = await mountTool(state, "machine/session/a");
  expect(view.renderRoot.querySelector<HTMLDetailsElement>(".diff-details")?.open).toBe(false);
  await toggle(view, ".diff-details", true);
  expect(view.renderRoot.querySelectorAll(".diff-content > span")).toHaveLength(200);
  await toggle(view, ".diff-details", false);

  // Both templates want the default `true`; live binding must still reset native state.
  view.stateKey = "machine/session/b";
  await view.updateComplete;
  expect(view.renderRoot.querySelector<HTMLDetailsElement>(".diff-details")?.open).toBe(true);
  expect(view.renderRoot.querySelectorAll(".diff-content > span")).toHaveLength(180);
  view.stateKey = "machine/session/a";
  await view.updateComplete;
  expect(view.renderRoot.querySelector<HTMLDetailsElement>(".diff-details")?.open).toBe(false);
  await toggle(view, ".diff-details", true);
  expect(view.renderRoot.querySelectorAll(".diff-content > span")).toHaveLength(200);
  expect(state.getTool("machine/session/a")).toEqual({ diffOpen: true, showFullDiff: true });
});

it("restores a deliberate error collapse without re-expanding on remount or repeated error updates", async () => {
  const state = new TranscriptUiState();
  const error: ToolExecutionPart = {
    type: "toolExecution", toolName: "bash", summary: "command", args: { command: "false" },
    status: "error", resultText: "failed",
  };
  const first = await mountTool(state, "a", error);
  expect(first.renderRoot.querySelector<HTMLDetailsElement>(".text-body")?.open).toBe(true);
  await toggle(first, ".text-body", false);
  first.remove();
  const view = await mountTool(state, "a", error);
  view.execution = { ...error, resultText: "more diagnostics" };
  await view.updateComplete;
  expect(view.renderRoot.querySelector<HTMLDetailsElement>(".text-body")?.open).toBe(false);
  view.stateKey = "b";
  await view.updateComplete;
  expect(view.renderRoot.querySelector<HTMLDetailsElement>(".text-body")?.open).toBe(true);
  view.stateKey = "a";
  await view.updateComplete;
  expect(view.renderRoot.querySelector<HTMLDetailsElement>(".text-body")?.open).toBe(false);
});

it("keeps fallback state local and resets it when the caller changes identity", async () => {
  const view = await mountTool(undefined, "a");
  await toggle(view, ".diff-details", false);
  const other = await mountTool(undefined, "a");
  expect(other.renderRoot.querySelector<HTMLDetailsElement>(".diff-details")?.open).toBe(true);
  view.stateKey = "b";
  await view.updateComplete;
  expect(view.renderRoot.querySelector<HTMLDetailsElement>(".diff-details")?.open).toBe(true);
  view.stateKey = "a";
  await view.updateComplete;
  expect(view.renderRoot.querySelector<HTMLDetailsElement>(".diff-details")?.open).toBe(true);
});

it("does not apply an old asynchronous copy result or feedback timer to a rebound tool", async () => {
  vi.useFakeTimers();
  let finishCopy: ((result: boolean) => void) | undefined;
  vi.mocked(writeClipboardText).mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishCopy = resolve; }));
  const view = await mountTool(new TranscriptUiState(), "a");
  const copy = () => view.renderRoot.querySelector<HTMLButtonElement>(".diff-toolbar button");
  copy()?.click();
  view.stateKey = "b";
  await view.updateComplete;
  finishCopy?.(true);
  await vi.advanceTimersByTimeAsync(0);
  await view.updateComplete;
  expect(copy()?.textContent).toBe("Copy diff");

  copy()?.click();
  await vi.advanceTimersByTimeAsync(0);
  await view.updateComplete;
  expect(copy()?.textContent).toBe("Copied");
  await vi.advanceTimersByTimeAsync(600);
  view.stateKey = "c";
  await view.updateComplete;
  copy()?.click();
  await vi.advanceTimersByTimeAsync(0);
  await view.updateComplete;
  await vi.advanceTimersByTimeAsync(600);
  await view.updateComplete;
  expect(copy()?.textContent).toBe("Copied");
  await vi.advanceTimersByTimeAsync(600);
  await view.updateComplete;
  expect(copy()?.textContent).toBe("Copy diff");
});
