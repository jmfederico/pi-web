import { CronExpressionParser } from "cron-parser";

export type TaskSchedule = { kind: "once"; at: string } | { kind: "cron"; expression: string };

export interface TaskInput {
  name: string;
  projectId: string;
  workspaceId: string;
  prompt: string;
  timezone: string;
  schedule: TaskSchedule;
  /** Workspace-relative files to read at execution time, not copied into the ledger. */
  contextPaths: string[];
}

export interface Task extends TaskInput {
  id: string;
  revision: number;
  paused: boolean;
  archived: boolean;
  nextDue: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ExecutionStatus = "dispatching" | "dispatched" | "completed" | "errored" | "failed" | "uncertain";
export interface OutcomeReport {
  at: string;
  outcome: "completed" | "errored";
  summary: string;
}
export interface Execution {
  id: string;
  taskId: string;
  /** Immutable task revision and instructions used for this dispatch. */
  task: Task;
  trigger: "scheduled" | "manual";
  dueAt: string;
  createdAt: string;
  status: ExecutionStatus;
  sessionId: string | null;
  dispatchError: string | null;
  reports: OutcomeReport[];
}

export function text(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0") || Buffer.byteLength(value) > maxBytes) {
    throw new Error(`Invalid ${label}: expected non-empty text, at most ${String(maxBytes)} UTF-8 bytes, without NUL`);
  }
  return value;
}

/** Validation is shared by all write entry points; it never guesses a timezone. */
export function validateTask(input: TaskInput, now: string): TaskInput {
  text(input.name, "name", 512);
  text(input.projectId, "projectId", 512);
  text(input.workspaceId, "workspaceId", 512);
  // Leave room for dispatch attribution within the host's 64 KiB initial prompt bound.
  text(input.prompt, "prompt", 48 * 1024);
  text(input.timezone, "timezone", 256);
  new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format();
  if (!Array.isArray(input.contextPaths) || input.contextPaths.length > 32) throw new Error("At most 32 context paths are allowed");
  for (const path of input.contextPaths) {
    text(path, "context path", 1024);
    if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "")) {
      throw new Error("Context paths must be workspace-relative without parent traversal");
    }
  }
  if (!["once", "cron"].includes(input.schedule.kind)) throw new Error("Unknown schedule kind");
  if (input.schedule.kind === "once") {
    // Require an explicit UTC offset so local wall times never silently use the daemon's timezone.
    if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(input.schedule.at) || !Number.isFinite(Date.parse(input.schedule.at))) {
      throw new Error("One-off time must be an ISO timestamp with an explicit UTC offset");
    }
  } else {
    text(input.schedule.expression, "cron expression", 256);
    // Keep occurrence identity deterministic and the initial scheduler minute-granular.
    if (input.schedule.expression.trim().split(/\s+/u).length !== 5 || /(?:^|[^A-Z])H(?:$|[^A-Z])/iu.test(input.schedule.expression)) {
      throw new Error("Use a deterministic five-field cron expression (minute hour day month weekday)");
    }
    nextOccurrence(input, now);
  }
  if (Buffer.byteLength(JSON.stringify(input.contextPaths)) > 8 * 1024) throw new Error("Combined context paths exceed 8 KiB");
  return {
    name: input.name, projectId: input.projectId, workspaceId: input.workspaceId, prompt: input.prompt,
    timezone: input.timezone, contextPaths: [...input.contextPaths],
    schedule: input.schedule.kind === "once"
      ? { kind: "once", at: new Date(input.schedule.at).toISOString() }
      : { kind: "cron", expression: input.schedule.expression },
  };
}

export function nextOccurrence(task: Pick<TaskInput, "schedule" | "timezone">, after: string): string {
  return task.schedule.kind === "once"
    ? new Date(task.schedule.at).toISOString()
    : CronExpressionParser.parse(task.schedule.expression, { currentDate: after, tz: task.timezone }).next().toDate().toISOString();
}
