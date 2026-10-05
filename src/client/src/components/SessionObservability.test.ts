// @vitest-environment happy-dom

import { LitElement } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionUiState } from "../../../server/sessions/extensionUiState";
import { parseSessionSocketEvent } from "../sessionSocket";
import type { AppState } from "../appState";
import { SessionObservability } from "./SessionObservability";
import { SubagentFleetView } from "./SubagentFleetView";
import { BallastStatusView } from "./BallastStatusView";
import { TaskProgressView } from "./TaskProgressView";
import { ExtensionStatusStrip } from "./ExtensionStatusStrip";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

function source(): NonNullable<AppState["selectedExtensionUi"]> {
  return { machineId: "local", sessionId: "one", cwd: "/repo", snapshot: {
    statuses: { ballast: "memory warning", goal: "Build", demo: "ready" }, widgets: {},
  } };
}

async function settle(view: LitElement): Promise<void> {
  await view.updateComplete;
  for (const child of view.shadowRoot?.querySelectorAll("*") ?? []) if (child instanceof LitElement) await settle(child);
}

function child<T extends Element>(view: SessionObservability, tag: string, ctor: new () => T): T {
  const node = view.shadowRoot?.querySelector(tag);
  if (!(node instanceof ctor)) throw new Error(`Missing ${tag}`);
  return node;
}

describe("session observability composition", () => {
  it("keeps a labelled activity table outside disclosures without inventing unavailable counts", async () => {
    const view = new SessionObservability(); view.sessionId = "one"; view.cwd = "/repo";
    document.body.append(view); await settle(view);
    const table = view.shadowRoot?.querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.closest("details")).toBeNull();
    expect(table?.querySelector("caption")?.textContent).toContain("Session activity");
    expect(Array.from(table?.querySelectorAll('th[scope="row"]') ?? [], (cell) => cell.textContent)).toEqual(["Extensions", "Tasks", "Fleet", "Memory"]);
    const summaries = Array.from(table?.querySelectorAll("summary") ?? [], (summary) => summary.textContent).join(" ");
    expect(summaries).toContain("Unavailable");
    expect(summaries).toContain("Unknown");
    expect(summaries).not.toContain("0 of 0");
    expect(summaries).not.toContain("healthy");
  });

  it("shows current and stale task summaries and resets row disclosures on selection changes", async () => {
    const view = new SessionObservability(); view.sessionId = "one"; view.cwd = "/repo";
    view.messages = [{ role: "tool", parts: [{ type: "toolResult", toolName: "todo", text: "", isError: false,
      details: { action: "list", params: {}, nextId: 3, tasks: [
        { id: 1, subject: "Done", status: "completed" }, { id: 2, subject: "Working", status: "in_progress" },
      ] },
    }] }];
    document.body.append(view); await settle(view);
    const summary = view.shadowRoot?.querySelector<HTMLElement>('[data-activity="tasks"] summary');
    expect(summary?.textContent).toContain("1 of 2 complete");
    expect(summary?.textContent).toContain("1 active");
    summary?.click(); await settle(view);
    expect(view.shadowRoot?.querySelector<HTMLDetailsElement>('[data-activity="tasks"] details')?.open).toBe(true);
    view.messages = [...view.messages, { role: "tool", parts: [{ type: "toolResult", toolName: "todo", text: "Updated", isError: false }] }];
    await settle(view);
    expect(view.shadowRoot?.querySelector('[data-activity="tasks"] summary')?.textContent).toContain("Stale");
    view.sessionId = "two"; view.messages = []; await settle(view);
    expect(view.shadowRoot?.querySelector<HTMLDetailsElement>('[data-activity="tasks"] details')?.open).toBe(false);
    expect(view.shadowRoot?.querySelector('[data-activity="tasks"] summary')?.textContent).toContain("Unavailable");
  });

  it("binds dedicated cards, filters duplicate statuses, and clears mismatched or missing snapshots", async () => {
    const view = new SessionObservability();
    view.sessionId = "one"; view.cwd = "/repo"; view.extensionUi = source();
    document.body.append(view); await settle(view);
    expect(child(view, "extension-status-strip", ExtensionStatusStrip).statuses).toEqual({ demo: "ready" });
    expect(child(view, "task-progress-view", TaskProgressView).goalStatus).toBe("Build");
    expect(child(view, "ballast-status-view", BallastStatusView).statusText).toBe("memory warning");
    expect(view.shadowRoot?.querySelector('[data-activity="memory"] summary')?.textContent).toContain("memory warning");
    for (const patch of [{ machineId: "other" }, { machineId: "local", sessionId: "two" }, { sessionId: "one", cwd: "/other" }]) {
      Object.assign(view, patch); await settle(view);
      expect(child(view, "ballast-status-view", BallastStatusView).statusText).toBeUndefined();
      expect(child(view, "subagent-fleet-view", SubagentFleetView).widgets).toEqual({});
      expect(view.shadowRoot?.querySelector('[data-activity="memory"] summary')?.textContent).toContain("Unknown");
    }
    view.cwd = "/repo"; view.extensionUi = undefined; await settle(view);
    expect(view.shadowRoot?.textContent).toContain("Extension snapshot unavailable");
    expect(child(view, "task-progress-view", TaskProgressView).goalStatus).toBeUndefined();
  });

  it("preserves a full-size structured widget from the server bridge through socket parsing to Fleet", async () => {
    const payload = { kind: "pi-subagents.async-status-snapshot", version: 1, generatedAt: 1_750_000_000_000,
      caps: { maxRuns: 20, maxChildrenPerNode: 8, maxDepth: 3, maxStringLength: 160, maxSerializedBytes: 32_768 },
      omitted: { runs: 0, children: 0, byteLimitExceeded: false }, runs: [] };
    const line = `PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(payload).padEnd(32_768, " ")}`;
    const bridge = new ExtensionUiState();
    bridge.setWidget("subagent-async", [line]);
    const event = parseSessionSocketEvent({ type: "status.update", status: {
      sessionId: "one", isStreaming: false, isCompacting: false, isBashRunning: false,
      pendingMessageCount: 0, queuedMessages: [], cost: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, extensionUi: bridge.snapshot(),
    } });
    if (event?.type !== "status.update" || event.status.extensionUi === undefined) throw new Error("Snapshot lost in transport");
    const view = new SessionObservability(); view.sessionId = "one"; view.cwd = "/repo";
    view.extensionUi = { ...source(), snapshot: event.status.extensionUi };
    document.body.append(view); await settle(view);
    const fleet = child(view, "subagent-fleet-view", SubagentFleetView);
    expect(fleet.widgets["subagent-async"]).toEqual([line]);
    expect(fleet.shadowRoot?.textContent).toContain("No async subagent runs are reported");
    expect(view.shadowRoot?.querySelector('[data-activity="fleet"] summary')?.textContent).toContain("0 runs reported · snapshot, not live progress");
    expect(child(view, "extension-status-strip", ExtensionStatusStrip).shadowRoot?.textContent).not.toContain("PI_SUBAGENT_ASYNC_JSON");
  });
});
