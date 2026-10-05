import { describe, expect, it } from "vitest";
import { normalizeMessages } from "./chatMessages";
import type { ChatLine } from "./components/shared";
import { taskProgressFromMessages } from "./taskProgress";

const initialDetails = {
  action: "create",
  params: { subject: "Prepare test plan" },
  tasks: [
    { id: 3, subject: "Prepare test plan", status: "in_progress", activeForm: "writing regression tests", blockedBy: [2] },
    { id: 2, subject: "Inspect replay format", status: "pending" },
  ],
  nextId: 4,
};

function directResult(details: unknown): ChatLine {
  return { role: "tool", parts: [{ type: "toolResult", toolName: "todo", text: "Updated #3", isError: false, details }] };
}

function coalescedResult(details: unknown): ChatLine {
  return {
    role: "tool",
    parts: [{ type: "toolExecution", toolName: "todo", summary: "update", status: "success", details }],
  };
}

function codemodeExecution(details: unknown): ChatLine {
  return {
    role: "tool",
    parts: [{ type: "toolExecution", toolName: "codemode", summary: "Run JavaScript", status: "success", details }],
  };
}

function hydratedCodemodeHistory(): ChatLine[] {
  return normalizeMessages([
    { role: "assistant", content: [{ type: "toolCall", id: "code-1", name: "codemode", arguments: { code: "await tools.todo({ action: 'clear' })" } }] },
    {
      role: "toolResult",
      toolCallId: "code-1",
      toolName: "codemode",
      content: [{ type: "text", text: "Script completed" }],
      details: { calls: [{ id: "todo-call-1", name: "todo", args: '{"action":"clear"}', status: "ok" }] },
    },
  ]);
}

describe("taskProgressFromMessages", () => {
  it("reads rpiv-todo's persisted TaskDetails snapshot from a direct tool result", () => {
    const observation = taskProgressFromMessages([directResult(initialDetails)]);

    expect(observation).toMatchObject({ state: "current", progress: {
      total: 2,
      completed: 0,
      pending: 1,
      blocked: 1,
      inProgress: [{ id: 3, subject: "Prepare test plan", activeForm: "writing regression tests" }],
      tasks: [
        {
          id: 3,
          subject: "Prepare test plan",
          status: "in_progress",
          activeForm: "writing regression tests",
          dependencies: [{ id: 2, subject: "Inspect replay format", status: "pending", blocksProgress: true }],
        },
        { id: 2, subject: "Inspect replay format", status: "pending", dependencies: [] },
      ],
    } });
  });

  it("uses the latest complete snapshot, including a clear or tombstone update", () => {
    const tombstoned = {
      action: "delete",
      params: { id: 3 },
      tasks: [
        { id: 3, subject: "Remove me", status: "deleted" },
        { id: 4, subject: "Keep me", status: "completed" },
      ],
      nextId: 5,
    };
    const deleted = taskProgressFromMessages([directResult(initialDetails), directResult(tombstoned)]);
    expect(deleted).toMatchObject({
      state: "current",
      progress: { tasks: [{ id: 4, subject: "Keep me" }], total: 1, completed: 1 },
    });

    const cleared = taskProgressFromMessages([
      directResult(initialDetails),
      directResult({ action: "clear", params: { action: "clear" }, tasks: [], nextId: 1 }),
    ]);
    expect(cleared).toMatchObject({ state: "current", progress: { tasks: [], total: 0, completed: 0, pending: 0, blocked: 0, inProgress: [] } });
  });

  it("also reads the persisted snapshot from a completed native tool execution", () => {
    expect(taskProgressFromMessages([coalescedResult(initialDetails)])).toMatchObject({ state: "current", progress: { total: 2 } });
  });

  it("ignores malformed snapshots and does not infer progress from prose or nested content", () => {
    const malformed = { ...initialDetails, tasks: [{ id: 1, subject: "Broken", status: "finished" }] };
    expect(taskProgressFromMessages([directResult(malformed)])).toMatchObject({ state: "unavailable", reason: "todo_result_invalid_snapshot" });
    expect(taskProgressFromMessages([
      { role: "tool", parts: [{ type: "toolResult", toolName: "todo", text: "Created 4/4 completed", isError: false }] },
      { role: "tool", parts: [{ type: "toolResult", toolName: "codemode", text: "done", isError: false, details: { result: initialDetails } }] },
    ])).toMatchObject({ state: "unavailable" });
  });

  it("marks later missing, malformed, and oversized direct results stale", () => {
    const malformed = { ...initialDetails, nextId: Number.NaN };
    expect(taskProgressFromMessages([directResult(initialDetails), directResult(undefined)])).toMatchObject({
      state: "stale", reason: "todo_result_missing_snapshot", progress: { total: 2 },
    });
    expect(taskProgressFromMessages([directResult(initialDetails), directResult(malformed)])).toMatchObject({
      state: "stale", reason: "todo_result_invalid_snapshot", progress: { total: 2 },
    });

    const tooManyTasks = Array.from({ length: 201 }, (_, index) => ({ id: index + 1, subject: `Task ${String(index + 1)}`, status: "pending" }));
    expect(taskProgressFromMessages([directResult(initialDetails), directResult({ ...initialDetails, tasks: tooManyTasks, nextId: 202 })])).toMatchObject({
      state: "stale", reason: "todo_result_invalid_snapshot", progress: { total: 2 },
    });
  });

  it("marks direct and hydrated codemode todo calls unobservable, then recovers on a newer snapshot", () => {
    const codemodeDetails = { calls: [{ id: "todo-call-1", name: "todo", args: '{"action":"clear"}', status: "ok" }] };
    const direct = taskProgressFromMessages([directResult(initialDetails), codemodeExecution(codemodeDetails)]);
    expect(direct).toMatchObject({ state: "stale", reason: "codemode_todo_unobservable", progress: { total: 2 } });

    const hydrated = taskProgressFromMessages([directResult(initialDetails), ...hydratedCodemodeHistory()]);
    expect(hydrated).toMatchObject({ state: "stale", reason: "codemode_todo_unobservable", progress: { total: 2 } });

    const recovered = taskProgressFromMessages([
      directResult(initialDetails),
      codemodeExecution(codemodeDetails),
      directResult({ action: "clear", params: { action: "clear" }, tasks: [], nextId: 1 }),
    ]);
    expect(recovered).toMatchObject({ state: "current", progress: { total: 0, tasks: [] } });
  });

  it("reports unavailable when a result is missing before any valid snapshot", () => {
    expect(taskProgressFromMessages([directResult(undefined)])).toMatchObject({
      state: "unavailable", reason: "todo_result_missing_snapshot",
    });
  });

  it("keeps fresh counts when codemode metadata lists only other tools and bounds call metadata", () => {
    const otherTool = { calls: [{ id: "read-call", name: "read", args: '{"path":"README.md"}', status: "ok" }] };
    expect(taskProgressFromMessages([directResult(initialDetails), codemodeExecution(otherTool)])).toMatchObject({
      state: "current", progress: { total: 2 },
    });

    const codeOnly: ChatLine = {
      role: "tool",
      parts: [{
        type: "toolExecution",
        toolName: "codemode",
        summary: "Run JavaScript",
        status: "success",
        args: { code: "await tools.todo({ action: 'clear' })" },
        details: { calls: [] },
      }],
    };
    expect(taskProgressFromMessages([directResult(initialDetails), codeOnly])).toMatchObject({
      state: "current", progress: { total: 2 },
    });

    const missingCodemodeDetails: ChatLine = {
      role: "tool",
      parts: [{ type: "toolExecution", toolName: "codemode", summary: "Run JavaScript", status: "success" }],
    };
    expect(taskProgressFromMessages([directResult(initialDetails), missingCodemodeDetails])).toMatchObject({
      state: "stale", reason: "codemode_metadata_unavailable", progress: { total: 2 },
    });

    const tooManyCalls = Array.from({ length: 201 }, (_, index) => ({
      id: `call-${String(index)}`, name: "read", args: "{}", status: "ok",
    }));
    expect(taskProgressFromMessages([directResult(initialDetails), codemodeExecution({ calls: tooManyCalls })])).toMatchObject({
      state: "stale", reason: "codemode_metadata_unavailable", progress: { total: 2 },
    });
  });

  it("rejects oversized snapshots rather than treating them as progress", () => {
    const tooManyTasks = Array.from({ length: 201 }, (_, index) => ({ id: index + 1, subject: `Task ${String(index + 1)}`, status: "pending" }));
    expect(taskProgressFromMessages([directResult({ ...initialDetails, tasks: tooManyTasks, nextId: 202 })])).toMatchObject({
      state: "unavailable", reason: "todo_result_invalid_snapshot",
    });
  });
});
