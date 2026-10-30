import { describe, expect, it } from "vitest";
import { overviewGroups } from "./overview.js";
import type { ExecutionView, TaskOverview, TaskView } from "./responses.js";

function task(id: string, status: ExecutionView["status"] | null = null, overrides: Partial<TaskView> = {}, createdAt = "2026-10-01T09:00:00Z"): TaskOverview {
  const view: TaskView = {
    id, name: id, revision: 1, projectId: "project", workspaceId: "workspace",
    schedule: { kind: "cron", expression: "0 9 * * *" }, timezone: "UTC",
    paused: false, archived: false, nextDue: null, ...overrides,
  };
  return { ...view, latestExecution: status === null ? null : {
    id: `run-${id}`, task: view, status, trigger: "scheduled", createdAt,
    sessionId: status === "failed" ? null : `session-${id}`, dispatchError: null,
    latestReport: status === "completed" || status === "errored" ? { summary: id } : null,
  } };
}
const ids = (tasks: TaskOverview[]) => tasks.map((task) => task.id);

describe("scheduled task overview groups", () => {
  it("keeps failed, reported-error, and uncertain latest runs in attention even when paused, but excludes archived tasks", () => {
    const groups = overviewGroups([
      task("failed", "failed", { paused: true }), task("errored", "errored", { paused: true }),
      task("uncertain", "uncertain"), task("archived", "errored", { archived: true }), task("new"),
    ]);
    expect(ids(groups.attention).sort()).toEqual(["errored", "failed", "uncertain"]);
  });

  it("separates unreported launches from explicit success and errors, without inferring session activity", () => {
    const groups = overviewGroups([
      task("starting", "dispatching"), task("launched", "dispatched"),
      task("success", "completed"), task("problem", "errored"), task("never-run"),
      task("archived-launch", "dispatched", { archived: true }),
    ]);
    expect(ids(groups.awaiting).sort()).toEqual(["launched", "starting"]);
    expect(ids(groups.recent)).toEqual(["success"]);
    expect(ids(groups.attention)).toEqual(["problem"]);
  });

  it.each([
    ["attention", "errored"], ["awaiting", "dispatched"], ["recent", "completed"],
  ] as const)("orders %s by timestamp instant rather than offset spelling", (group, status) => {
    const groups = overviewGroups([
      task("older", status, {}, "2026-10-01T10:00:00+02:00"),
      task("newer", status, {}, "2026-10-01T09:30:00Z"),
    ]);
    expect(ids(groups[group])).toEqual(["newer", "older"]);
  });

  it("shows only eligible upcoming tasks, chronologically bounded to the next five", () => {
    const groups = overviewGroups([
      task("paused", null, { paused: true, nextDue: "2026-10-01T01:00:00Z" }),
      task("archived", null, { archived: true, nextDue: "2026-10-01T02:00:00Z" }),
      task("consumed", "completed", { schedule: { kind: "once", at: "2026-09-01T00:00:00Z" }, nextDue: null }),
      ...[6, 5, 4, 3, 2, 1].map((day) => task(`day-${String(day)}`, null, { nextDue: `2026-10-0${String(day)}T09:00:00Z` })),
      task("offset-earliest", null, { nextDue: "2026-10-01T10:00:00+02:00" }),
    ]);
    expect(ids(groups.upcoming)).toEqual(["offset-earliest", "day-1", "day-2", "day-3", "day-4"]);
  });

  it("bounds recent results to five latest completed task executions, including paused but not archived tasks", () => {
    const groups = overviewGroups([
      ...[1, 6, 3, 2, 5, 4].map((day) => task(`result-${String(day)}`, "completed", { paused: day === 6 }, `2026-10-0${String(day)}T09:00:00Z`)),
      task("archived", "completed", { archived: true }, "2026-10-09T09:00:00Z"),
      task("latest-is-error", "errored", {}, "2026-10-10T09:00:00Z"),
    ]);
    expect(ids(groups.recent)).toEqual(["result-6", "result-5", "result-4", "result-3", "result-2"]);
  });
});
