import { describe, expect, it } from "vitest";
import { overviewGroups, reportPreview } from "./overview.js";
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

describe("scheduled task overview", () => {
  it("shows each task once, prioritizing latest errors including paused tasks but excluding archived tasks from attention", () => {
    const groups = overviewGroups([
      task("failed", "failed", { paused: true }, "2026-10-01T10:00:00+02:00"),
      task("uncertain", "uncertain", { nextDue: "2026-10-02T09:00:00Z" }),
      task("errored", "errored", {}, "2026-10-01T09:30:00Z"),
      task("archived", "errored", { archived: true }),
      task("new"), task("launched", "dispatched"),
    ]);
    expect(ids(groups.attention)).toEqual(["errored", "uncertain", "failed"]);
    expect(ids(groups.current)).toEqual(["launched", "new"]);
    expect(ids(groups.archived)).toEqual(["archived"]);
  });

  it("sorts scheduled tasks by due instant ahead of tasks without an eligible next run", () => {
    const groups = overviewGroups([
      task("paused", null, { paused: true, nextDue: "2026-10-01T01:00:00Z" }),
      task("consumed", "completed"),
      task("later", null, { nextDue: "2026-10-01T09:00:00Z" }),
      task("earlier", null, { nextDue: "2026-10-01T10:00:00+02:00" }),
    ]);
    expect(ids(groups.current)).toEqual(["earlier", "later", "consumed", "paused"]);
  });

  it("previews only the opening line and bounds long single-line reports", () => {
    expect(reportPreview("Reviewed 18 issues.")).toEqual({ text: "Reviewed 18 issues.", truncated: false });
    expect(reportPreview("Reviewed 18 issues.\nA second line.")).toEqual({ text: "Reviewed 18 issues.", truncated: true });
    expect(reportPreview("🕒".repeat(500))).toEqual({ text: "🕒".repeat(160), truncated: true });
  });
});
