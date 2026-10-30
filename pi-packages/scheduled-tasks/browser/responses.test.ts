import { describe, expect, it } from "vitest";
import { readHistory, readOverview } from "./responses.js";

const task = { id: "task", name: "Task", revision: 1, projectId: "project", workspaceId: "workspace", schedule: { kind: "cron", expression: "0 9 * * *" }, timezone: "UTC", paused: false, archived: false, nextDue: null };
const execution = { id: "run", task, status: "completed", trigger: "scheduled", createdAt: "2026-10-01T09:00:00Z", sessionId: "session", dispatchError: null, latestReport: null };

describe("Scheduled task response model settings", () => {
  it("accepts older responses without settings or notices", () => {
    expect(readOverview({ tasks: [{ ...task, latestExecution: execution }] })[0]).toEqual({ ...task, latestExecution: execution });
    expect(readHistory({ executions: [execution], nextOffset: null }).executions[0]).toEqual(execution);
  });
  it("keeps requested and effective settings distinct on both response paths", () => {
    const configured = { ...task, model: "provider/requested", thinkingLevel: "high" };
    const run = { ...execution, task: configured, model: "provider/fallback", thinkingLevel: "low", notices: ["Used fallback model"] };
    expect(readOverview({ tasks: [{ ...configured, latestExecution: run }] })[0]).toEqual({ ...configured, latestExecution: run });
    expect(readHistory({ executions: [run], nextOffset: null }).executions[0]).toEqual(run);
  });
  it.each([
    { task: { ...task, model: {} } },
    { task: { ...task, thinkingLevel: null } },
    { model: 42 },
    { thinkingLevel: [] },
    { notices: "warning" },
    { notices: ["warning", {}] },
  ])("rejects malformed optional fields: %j", (fields) => {
    expect(() => readHistory({ executions: [{ ...execution, ...fields }], nextOffset: null })).toThrow();
  });
});
