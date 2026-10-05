// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { SUBAGENT_ASYNC_WIDGET_KEY, SUBAGENT_ASYNC_WIDGET_PREFIX } from "../subagentFleet";
import { SubagentFleetView } from "./SubagentFleetView";

const generatedAt = 1_750_000_000_000;

function widget(runs: unknown[], observationTime = generatedAt): Record<string, string[]> {
  const payload = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt: observationTime,
    caps: { maxRuns: 20, maxChildrenPerNode: 8, maxDepth: 3, maxStringLength: 160, maxSerializedBytes: 32_768 },
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs,
  };
  return { [SUBAGENT_ASYNC_WIDGET_KEY]: [`${SUBAGENT_ASYNC_WIDGET_PREFIX}${JSON.stringify(payload)}`] };
}

function workflowRun(label = "planner", at = generatedAt): Record<string, unknown> {
  const id = `workflow-${label}`;
  return {
    id,
    kind: "workflow",
    label,
    state: "running",
    startedAt: at - 5_000,
    updatedAt: at,
    activity: { currentTool: "read", lastActivityAt: at - 1_000, toolCount: 2, turnCount: 3 },
    children: [
      { id: "done", kind: "step", label: "Research", state: "complete", startedAt: at - 4_000, endedAt: at - 2_000 },
      { id: "failed", kind: "subagent", label: "Reviewer", state: "failed", startedAt: at - 3_000, endedAt: at - 1_000 },
      { id: "paused", kind: "subagent", label: "Paused worker", state: "paused", startedAt: at - 2_000, endedAt: at },
      { id: "stopped", kind: "subagent", label: "Stopped worker", state: "stopped", startedAt: at - 2_000, endedAt: at },
      { id: "queued", kind: "subagent", label: "Queued worker", state: "queued" },
      { id: "rejected", kind: "subagent", label: "Rejected worker", state: "rejected", startedAt: at - 1_000, endedAt: at },
    ],
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("SubagentFleetView", () => {
  it("shows the structured workflow tree and distinct child states without inventing task, model, or usage data", async () => {
    const view = mount(widget([workflowRun()]));
    await view.updateComplete;

    const text = view.shadowRoot?.textContent ?? "";
    expect(text).toContain("planner");
    expect(text).toContain("Workflow");
    expect(text).toContain("Research");
    expect(text).toContain("Succeeded");
    expect(text).toContain("Failed");
    expect(text).toContain("Paused");
    expect(text).toContain("Stopped");
    expect(text).toContain("Queued · not yet running");
    expect(text).toContain("Launch rejected");
    expect(text).toContain("Current tool");
    expect(text).toContain("Tools reported");
    expect(text).toContain("Task, model, and token/cost usage are unavailable");
  });

  it("uses native details summaries for keyboard-accessible hierarchy expansion and resets it for a new session", async () => {
    const view = mount(widget([workflowRun()]));
    await view.updateComplete;
    const details = view.shadowRoot?.querySelector("details");
    const summary = details?.querySelector("summary");
    expect(details?.open).toBe(true);
    expect(summary?.textContent).toContain("Workflow");

    summary?.click();
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector("details")?.open).toBe(false);

    view.sessionKey = "session-2";
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector("details")?.open).toBe(true);
  });

  it("keeps collapsed root identity through snapshot reordering and a later refresh", async () => {
    const view = mount(widget([workflowRun("A"), workflowRun("B")]));
    await view.updateComplete;
    rootDetails(view, "A")?.querySelector("summary")?.click();
    await view.updateComplete;
    expect(rootDetails(view, "A")?.open).toBe(false);

    view.widgets = widget([workflowRun("B"), workflowRun("A")], generatedAt + 1_000);
    await view.updateComplete;
    expect(rootDetails(view, "B")?.open).toBe(true);
    expect(rootDetails(view, "A")?.open).toBe(false);

    view.widgets = widget([workflowRun("B"), workflowRun("A")], generatedAt + 2_000);
    await view.updateComplete;
    expect(rootDetails(view, "B")?.open).toBe(true);
    expect(rootDetails(view, "A")?.open).toBe(false);
  });

  it("keeps collapsed child identity through reorder and refresh", async () => {
    const parent = {
      id: "parent",
      kind: "workflow",
      label: "Parent",
      state: "running",
      children: [childRun("A"), childRun("B")],
    };
    const view = mount(widget([parent]));
    await view.updateComplete;
    childDetails(view, "A")?.querySelector("summary")?.click();
    await view.updateComplete;
    expect(childDetails(view, "A")?.open).toBe(false);

    view.widgets = widget([{ ...parent, children: [childRun("B"), childRun("A")] }], generatedAt + 1_000);
    await view.updateComplete;
    expect(childDetails(view, "B")?.open).toBe(true);
    expect(childDetails(view, "A")?.open).toBe(false);

    view.widgets = widget([{ ...parent, children: [childRun("B"), childRun("A")] }], generatedAt + 2_000);
    await view.updateComplete;
    expect(childDetails(view, "B")?.open).toBe(true);
    expect(childDetails(view, "A")?.open).toBe(false);
  });

  it("labels an old unchanged widget as a point-in-time observation without advancing elapsed time", async () => {
    const oldTime = 1_600_000_000_000;
    const oldWidgets = widget([workflowRun("Old run", oldTime)], oldTime);
    const view = mount(oldWidgets);
    await view.updateComplete;

    const initialText = view.shadowRoot?.textContent ?? "";
    expect(initialText).toContain(new Date(oldTime).toISOString());
    expect(initialText).toContain("Lifecycle states and elapsed values describe this snapshot only");
    expect(initialText).toContain("Elapsed at snapshot");
    expect(initialText).toContain("5s");

    view.widgets = { ...oldWidgets, [SUBAGENT_ASYNC_WIDGET_KEY]: [...(oldWidgets[SUBAGENT_ASYNC_WIDGET_KEY] ?? [])] };
    await view.updateComplete;
    expect(view.shadowRoot?.textContent).toBe(initialText);
  });

  it("renders installed stale host-step verdict and reason metadata", async () => {
    const hostStep = {
      id: "ci-check",
      kind: "host-step",
      label: "CI check",
      state: "partial",
      updatedAt: generatedAt,
      hostStep: { kind: "ci", state: "done", verdict: "inconclusive", reasonCode: "stale_ref", stale: true },
    };
    const view = mount(widget([hostStep]));
    await view.updateComplete;

    const text = view.shadowRoot?.textContent ?? "";
    expect(text).toContain("Stale result");
    expect(text).toContain("inconclusive");
    expect(text).toContain("stale_ref");
  });

  it("does not treat absent widget data as a successful empty fleet", async () => {
    const view = mount({});
    await view.updateComplete;
    expect(view.shadowRoot?.textContent).toContain("Fleet status unavailable");
    expect(view.shadowRoot?.textContent).not.toContain("No async subagent runs are reported");
  });

  it("renders hostile labels as text rather than HTML", async () => {
    const view = mount(widget([{ ...workflowRun(), label: '<img src=x onerror="alert(1)">' }]));
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector("img")).toBeNull();
    expect(view.shadowRoot?.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});

function mount(widgets: Record<string, string[]>): SubagentFleetView {
  const view = new SubagentFleetView();
  view.widgets = widgets;
  view.sessionKey = "session-1";
  document.body.append(view);
  return view;
}

function childRun(label: string): Record<string, unknown> {
  return {
    id: `child-${label}`,
    kind: "step",
    label,
    state: "running",
    children: [{ id: `leaf-${label}`, kind: "subagent", label: `Worker ${label}`, state: "running" }],
  };
}

function rootDetails(view: SubagentFleetView, label: string): HTMLDetailsElement | undefined {
  return Array.from(view.shadowRoot?.querySelectorAll<HTMLDetailsElement>(".roots > li > details") ?? [])
    .find((details) => details.querySelector(".node-label")?.textContent === label);
}

function childDetails(view: SubagentFleetView, label: string): HTMLDetailsElement | undefined {
  return Array.from(view.shadowRoot?.querySelectorAll<HTMLDetailsElement>(".roots > li > details .children > li > details") ?? [])
    .find((details) => details.querySelector(".node-label")?.textContent === label);
}
