import type { TaskSchedule, ExecutionStatus } from "../domain.js";

export interface TaskView {
  id: string;
  name: string;
  revision: number;
  projectId: string;
  workspaceId: string;
  schedule: TaskSchedule;
  timezone: string;
  paused: boolean;
  archived: boolean;
  nextDue: string | null;
  model?: string;
  thinkingLevel?: string;
}
export interface ExecutionView {
  id: string;
  task: TaskView;
  status: ExecutionStatus;
  trigger: "scheduled" | "manual";
  createdAt: string;
  sessionId: string | null;
  dispatchError: string | null;
  latestReport: { summary: string } | null;
  notices?: string[];
  model?: string;
  thinkingLevel?: string;
}
export interface TaskOverview extends TaskView { latestExecution: ExecutionView | null }
export interface HistoryPage { executions: ExecutionView[]; nextOffset: number | null }

/** Validate the paired transport at the browser boundary; never render opaque objects as markup. */
export function readOverview(value: unknown): TaskOverview[] {
  const tasks = record(value)["tasks"];
  if (!Array.isArray(tasks)) throw new Error("Invalid tasks");
  return tasks.map((row: unknown) => ({ ...readTask(row), latestExecution: nullable(record(row)["latestExecution"], readExecution) }));
}
export function readHistory(value: unknown): HistoryPage {
  const data = record(value);
  const rows = data["executions"];
  const offset = data["nextOffset"];
  if (!Array.isArray(rows) || !(offset === null || (typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0))) throw new Error("Invalid history");
  return { executions: rows.map(readExecution), nextOffset: offset };
}
function readTask(value: unknown): TaskView {
  const row = record(value);
  const schedule = record(row["schedule"]);
  const kind = schedule["kind"];
  if (typeof row["paused"] !== "boolean" || typeof row["archived"] !== "boolean" || typeof row["revision"] !== "number") throw new Error("Invalid task");
  if (kind !== "once" && kind !== "cron") throw new Error("Invalid schedule");
  const timezone = string(row["timezone"]);
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  return {
    id: string(row["id"]), name: string(row["name"]), revision: row["revision"], projectId: string(row["projectId"]), workspaceId: string(row["workspaceId"]),
    schedule: kind === "once" ? { kind, at: timestamp(schedule["at"]) } : { kind, expression: string(schedule["expression"]) },
    timezone, paused: row["paused"], archived: row["archived"], nextDue: nullable(row["nextDue"], timestamp),
    ...readModelSettings(row),
  };
}
function readExecution(value: unknown): ExecutionView {
  const row = record(value);
  const status = row["status"];
  const trigger = row["trigger"];
  if (status !== "dispatching" && status !== "dispatched" && status !== "completed" && status !== "errored" && status !== "failed" && status !== "uncertain") throw new Error("Invalid status");
  if (trigger !== "scheduled" && trigger !== "manual") throw new Error("Invalid trigger");
  return {
    id: string(row["id"]), task: readTask(row["task"]), status, trigger, createdAt: timestamp(row["createdAt"]),
    sessionId: nullable(row["sessionId"], string), dispatchError: nullable(row["dispatchError"], string),
    latestReport: nullable(row["latestReport"], (report) => ({ summary: string(record(report)["summary"]) })),
    ...readModelSettings(row),
    ...(row["notices"] === undefined ? {} : { notices: readNotices(row["notices"]) }),
  };
}
function readModelSettings(row: Record<string, unknown>): { model?: string; thinkingLevel?: string } {
  return {
    ...(row["model"] === undefined ? {} : { model: string(row["model"]) }),
    ...(row["thinkingLevel"] === undefined ? {} : { thinkingLevel: string(row["thinkingLevel"]) }),
  };
}
function readNotices(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Invalid notices");
  return value.map(string);
}
function nullable<T>(value: unknown, parse: (input: unknown) => T): T | null { return value === null ? null : parse(value); }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid object");
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Narrowed JSON object.
  return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== "string") throw new Error("Invalid string"); return value; }
function timestamp(value: unknown): string { const result = string(value); if (!Number.isFinite(Date.parse(result))) throw new Error("Invalid timestamp"); return result; }
