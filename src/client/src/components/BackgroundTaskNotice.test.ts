// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import type { BackgroundTaskPresentation } from "../backgroundTaskNotification";
import { normalizeMessages } from "../chatMessages";
import { BackgroundTaskNotice } from "./BackgroundTaskNotice";
import { ChatView } from "./ChatView";

afterEach(() => {
  document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const task: BackgroundTaskPresentation = { kind: "backgroundTask", id: "test-1", name: "Reconcile tests", status: "completed", exitCode: 0, outputPath: ".pi/tasks/test-1.output" };

it.each([
  ["completed", 0, "success", "Completed"],
  ["failed", 1, "danger", "Failed"],
  ["killed", null, "warning", "Stopped"],
  ["running", undefined, "warning", "Running"],
] as const)("renders %s with a textual status and matching tone", async (status, exitCode, tone, label) => {
  const card = new BackgroundTaskNotice();
  const current = { ...task, status };
  delete current.exitCode;
  card.task = { ...current, ...(exitCode === undefined ? {} : { exitCode }) };
  card.raw = "<background-task-notification>raw</background-task-notification>";
  document.body.append(card);
  await card.updateComplete;
  const root = card.renderRoot;
  expect(root.querySelector(`.notice.${tone}`)?.getAttribute("aria-label")).toBe(label);
  expect(root.textContent).toContain("Reconcile tests");
  expect(root.textContent).toContain(task.outputPath);
  const details = root.querySelector("details");
  expect(details?.open).toBe(false);
  root.querySelector("summary")?.click();
  expect(details?.open).toBe(true);
  expect(root.querySelector(".raw")?.textContent).toBe(card.raw);
});

it("renders names, diagnostics and paths as inert text, including hostile markup", async () => {
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const card = new BackgroundTaskNotice();
  card.task = { ...task, name: hostile, error: hostile, outputPath: "javascript:alert(3)" };
  card.raw = hostile;
  document.body.append(card);
  await card.updateComplete;
  expect(card.renderRoot.querySelectorAll("img,script,a")).toHaveLength(0);
  expect(card.renderRoot.querySelector(".error")?.textContent).toBe(hostile);
  expect(card.renderRoot.querySelector(".notice.danger")).not.toBeNull();
});

it("does not label a signal termination with a null exit code as exit 0", async () => {
  const card = new BackgroundTaskNotice();
  card.task = { ...task, status: "killed", exitCode: null };
  document.body.append(card);
  await card.updateComplete;
  expect(card.renderRoot.textContent).not.toContain("exit 0");
});

it("wires a normalized custom notification into the actual chat transcript", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  const view = new ChatView();
  view.sessionId = "session-1";
  view.messages = normalizeMessages([{ role: "custom", customType: "background-task-notification", content: "original notification", details: task }]);
  document.body.append(view);
  await view.updateComplete;
  const card = view.renderRoot.querySelector<BackgroundTaskNotice>("background-task-notice");
  expect(card).not.toBeNull();
  await card?.updateComplete;
  expect(card?.task).toEqual(task);
  expect(card?.raw).toBe("original notification");
});
