// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { TaskProgressView } from "./TaskProgressView";
import type { ChatLine } from "./shared";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

function result(tasks: unknown[], action = "update", nextId = tasks.length + 1): ChatLine {
  return {
    role: "tool",
    parts: [{
      type: "toolResult",
      toolName: "todo",
      text: "stored result text is not used",
      isError: false,
      details: { action, params: {}, tasks, nextId },
    }],
  };
}

async function mount(messages: readonly ChatLine[], sessionKey = "session-a") {
  const view = new TaskProgressView();
  view.messages = messages;
  view.sessionKey = sessionKey;
  document.body.append(view);
  await view.updateComplete;
  return view;
}

function root(view: TaskProgressView): ShadowRoot {
  if (!view.shadowRoot) throw new Error("Expected task progress shadow root");
  return view.shadowRoot;
}

async function expandTaskList(view: TaskProgressView): Promise<ShadowRoot> {
  const summary = root(view).querySelector<HTMLElement>("details > summary");
  if (!summary) throw new Error("Expected task list disclosure");
  summary.click();
  await view.updateComplete;
  return root(view);
}

describe("TaskProgressView", () => {
  it("renders accessible progress, activeForm, pending dependencies, and a labelled goal hint", async () => {
    const view = await mount([result([
      { id: 1, subject: "Compile <img src=x>", status: "in_progress", activeForm: "running tests", blockedBy: [2] },
      { id: 2, subject: "Resolve dependency", status: "pending" },
    ])]);

    view.goalStatus = "Review in progress";
    await view.updateComplete;
    const panel = await expandTaskList(view);
    expect(panel.querySelector("h2")?.textContent).toBe("Task progress");
    expect(panel.querySelector('[role="status"]')?.textContent).toContain("0 of 2 tasks complete");
    expect(panel.textContent).toContain("In progress: #1 Compile <img src=x> — running tests");
    expect(panel.textContent).toContain("Blocked by #2: Resolve dependency");
    expect(panel.textContent).toContain("Goal status: Review in progress");
    expect(panel.querySelector("img")).toBeNull();
    expect(panel.querySelector("details > summary")?.textContent).toContain("Task list");
  });

  it("marks missing legacy snapshots unavailable instead of claiming zero progress", async () => {
    const view = await mount([]);

    expect(root(view).querySelector('[role="status"]')?.textContent).toBe("Task progress unavailable.");
    expect(root(view).querySelector('[role="status"]')?.getAttribute("data-state")).toBe("unavailable");
    expect(root(view).querySelector("details")).toBeNull();
  });

  it("labels last known counts stale after a missing result and restores current state on a newer snapshot", async () => {
    const missingResult: ChatLine = {
      role: "tool",
      parts: [{ type: "toolResult", toolName: "todo", text: "Updated", isError: false }],
    };
    const valid = result([{ id: 1, subject: "Previously completed", status: "completed" }]);
    const view = await mount([valid, missingResult]);

    expect(root(view).querySelector('[role="status"]')?.getAttribute("data-state")).toBe("stale");
    expect(root(view).querySelector('[role="status"]')?.textContent).toContain("Last known snapshot: 1 of 1 tasks complete");

    view.messages = [valid, missingResult, result([], "clear")];
    await view.updateComplete;
    expect(root(view).querySelector('[role="status"]')?.getAttribute("data-state")).toBe("current");
    expect(root(view).querySelector('[role="status"]')?.textContent).toContain("No tasks in the latest snapshot");
  });

  it("shows a real clear snapshot as empty and omits tombstoned task rows", async () => {
    const cleared = await mount([result([], "clear")]);
    expect(root(cleared).querySelector('[role="status"]')?.textContent).toContain("No tasks in the latest snapshot");

    const deleted = await mount([result([
      { id: 8, subject: "Tombstone", status: "deleted" },
      { id: 9, subject: "Visible", status: "completed" },
    ], "update", 10)]);
    const panel = await expandTaskList(deleted);
    expect(panel.textContent).toContain("#9 Visible");
    expect(panel.textContent).not.toContain("Tombstone");
  });

  it("resets the task list disclosure when the session changes", async () => {
    const view = await mount([result([{ id: 1, subject: "Build panel", status: "pending" }])]);
    const disclosure = root(view).querySelector<HTMLDetailsElement>("details");
    const summary = disclosure?.querySelector("summary");
    if (!disclosure || !summary) throw new Error("Expected task list disclosure");

    summary.click();
    await view.updateComplete;
    expect(disclosure.open).toBe(true);
    view.sessionKey = "session-b";
    await view.updateComplete;
    expect(root(view).querySelector("details")?.open).toBe(false);
  });
});
