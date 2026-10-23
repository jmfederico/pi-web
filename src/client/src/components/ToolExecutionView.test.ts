// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { ToolExecutionView } from "./ToolExecutionView";
import { writeClipboardText } from "../clipboard";

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
