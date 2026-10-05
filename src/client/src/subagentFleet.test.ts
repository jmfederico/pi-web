import { describe, expect, it } from "vitest";
import { parseSubagentFleet, SUBAGENT_ASYNC_WIDGET_KEY, SUBAGENT_ASYNC_WIDGET_PREFIX } from "./subagentFleet";

const timestamp = 1_750_000_000_000;

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt: timestamp,
    caps: { maxRuns: 20, maxChildrenPerNode: 8, maxDepth: 3, maxStringLength: 160, maxSerializedBytes: 32_768 },
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [
      {
        id: "workflow-1",
        kind: "workflow",
        label: "planner, worker",
        state: "running",
        startedAt: timestamp - 5_000,
        updatedAt: timestamp,
        activity: { currentTool: "read", lastActivityAt: timestamp - 1_000, turnCount: 3, toolCount: 2 },
        children: [
          { id: "step-a", kind: "step", label: "Plan", state: "complete", startedAt: timestamp - 4_000, endedAt: timestamp - 2_000 },
          { id: "step-b", kind: "step", label: "Build", state: "paused", startedAt: timestamp - 2_000, updatedAt: timestamp },
        ],
      },
    ],
    ...overrides,
  };
}

function widget(value: unknown): Record<string, string[]> {
  return { [SUBAGENT_ASYNC_WIDGET_KEY]: [`${SUBAGENT_ASYNC_WIDGET_PREFIX}${JSON.stringify(value)}`] };
}

describe("parseSubagentFleet", () => {
  it("projects the installed versioned hierarchy and distinguishes real lifecycle states", () => {
    const result = parseSubagentFleet(widget(snapshot()));

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected a parsed async snapshot");
    expect(result.snapshot.runs[0]).toMatchObject({
      id: "workflow-1",
      kind: "workflow",
      label: "planner, worker",
      state: "running",
      activity: { currentTool: "read", toolCount: 2, turnCount: 3 },
      children: [
        { id: "step-a", state: "complete" },
        { id: "step-b", state: "paused" },
      ],
    });
    expect(result.snapshot.generatedAt).toBe(timestamp);
  });

  it("reports missing structured data as unavailable instead of an empty fleet", () => {
    expect(parseSubagentFleet(undefined).status).toBe("unavailable");
    expect(parseSubagentFleet({ [SUBAGENT_ASYNC_WIDGET_KEY]: ["async subagent worker · background"] }).status).toBe("unavailable");
    expect(parseSubagentFleet({ "another-widget": [`${SUBAGENT_ASYNC_WIDGET_PREFIX}{}`] }).status).toBe("unavailable");
  });

  it("accepts a valid empty snapshot as an available empty fleet", () => {
    const result = parseSubagentFleet(widget(snapshot({ runs: [] })));
    expect(result).toMatchObject({ status: "ready", snapshot: { runs: [] } });
  });

  it("accepts the protocol's full run limit without confusing it with the child limit", () => {
    const runs = Array.from({ length: 20 }, (_, index) => ({
      id: `run-${String(index)}`,
      kind: "subagent",
      label: "worker",
      state: "running",
    }));
    const result = parseSubagentFleet(widget(snapshot({ runs })));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected the maximum supported run count to parse");
    expect(result.snapshot.runs).toHaveLength(20);
  });

  it("preserves bounded stale host-step verdict and reason metadata from the installed v1 projection", () => {
    const staleHostStep = {
      id: "ci-check",
      kind: "host-step",
      label: "CI check",
      state: "partial",
      updatedAt: timestamp,
      hostStep: {
        kind: "ci",
        state: "done",
        verdict: "inconclusive",
        reasonCode: "stale_ref",
        stale: true,
      },
    };
    const result = parseSubagentFleet(widget(snapshot({ runs: [staleHostStep] })));

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected the host-step snapshot to parse");
    expect(result.snapshot.runs[0]?.hostStep).toEqual({ stale: true, verdict: "inconclusive", reasonCode: "stale_ref" });
  });

  it("rejects malformed JSON, unsupported versions, and unsupported kinds", () => {
    expect(parseSubagentFleet({ [SUBAGENT_ASYNC_WIDGET_KEY]: [`${SUBAGENT_ASYNC_WIDGET_PREFIX}{`] }).status).toBe("error");
    expect(parseSubagentFleet(widget(snapshot({ version: 2 }))).status).toBe("error");
    expect(parseSubagentFleet(widget(snapshot({ kind: "pi-subagents.other" }))).status).toBe("error");
  });

  it("rejects oversized, over-deep, over-count, and ambiguous inputs", () => {
    const large = snapshot({ runs: [{ id: "large", kind: "subagent", label: "x".repeat(33_000), state: "running" }] });
    expect(parseSubagentFleet(widget(large))).toMatchObject({ status: "error", message: "The async status snapshot exceeds the supported size limit." });

    const tooManyChildren = Array.from({ length: 9 }, (_, index) => ({ id: `child-${String(index)}`, kind: "step", label: "step", state: "queued" }));
    expect(parseSubagentFleet(widget(snapshot({ runs: [{ id: "run", kind: "workflow", label: "main", state: "running", children: tooManyChildren }] }))).status).toBe("error");

    const tooDeep = { id: "a", kind: "step", label: "a", state: "running", children: [{ id: "b", kind: "step", label: "b", state: "running", children: [{ id: "c", kind: "step", label: "c", state: "running", children: [{ id: "d", kind: "step", label: "d", state: "running", children: [{ id: "e", kind: "step", label: "e", state: "running" }] }] }] }] };
    expect(parseSubagentFleet(widget(snapshot({ runs: [tooDeep] }))).status).toBe("error");

    const line = `${SUBAGENT_ASYNC_WIDGET_PREFIX}${JSON.stringify(snapshot())}`;
    expect(parseSubagentFleet({ [SUBAGENT_ASYNC_WIDGET_KEY]: [line, line] }).status).toBe("error");
  });

  it("rejects unknown lifecycle states and duplicate sibling identities", () => {
    expect(parseSubagentFleet(widget(snapshot({ runs: [{ id: "run", kind: "subagent", label: "agent", state: "healthy" }] }))).status).toBe("error");
    const duplicateChildren = [
      { id: "same", kind: "step", label: "one", state: "running" },
      { id: "same", kind: "step", label: "two", state: "complete" },
    ];
    expect(parseSubagentFleet(widget(snapshot({ runs: [{ id: "run", kind: "workflow", label: "main", state: "running", children: duplicateChildren }] }))).status).toBe("error");
  });

  it("cleans display controls, bounds labels, and ignores unrecognized fields", () => {
    const result = parseSubagentFleet(widget(snapshot({
      task: "not part of v1",
      model: "not part of v1",
      runs: [{ id: "run", kind: "subagent", label: ` agent\u001b${"x".repeat(200)}`, state: "running", task: "ignored" }],
    })));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected a parsed async snapshot");
    expect(result.snapshot.runs[0]?.label).toBe(`agent ${"x".repeat(154)}`);
    expect(result.snapshot.runs[0]).not.toHaveProperty("task");
    expect(result.snapshot.runs[0]).not.toHaveProperty("model");
  });
});
