import type { PluginCatalogV1 } from "@jmfederico/pi-web/server-plugin-api";
import type { Execution, Task, TaskInput, ThinkingLevel } from "./domain.js";
import { THINKING_LEVELS, text, validateTask } from "./domain.js";
import type { TaskScheduler } from "./scheduler.js";
import type { TaskStore } from "./store.js";

/** Transport-independent operations shared by the companion and read-only dashboard. */
export class TaskService {
  constructor(
    private readonly store: TaskStore,
    private readonly scheduler: TaskScheduler,
    private readonly validateTarget: (task: TaskInput) => Promise<void>,
    private readonly defaultTimezone: string | undefined,
    private readonly now: () => string,
    private readonly catalog: PluginCatalogV1,
  ) {}

  async request(operation: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const args = object(input ?? {});
    switch (operation) {
      case "targets": {
        only(args, ["projectId"]);
        const options = signal === undefined ? {} : { signal };
        return args["projectId"] === undefined
          ? { projects: await this.catalog.projects.list(options) }
          : { workspaces: await this.catalog.workspaces.list(identifier(args, "projectId"), options) };
      }
      case "overview":
        only(args, []);
        return { defaultTimezone: this.defaultTimezone ?? null, tasks: this.store.listTasks().map((task) => ({
          ...taskSummary(task), latestExecution: executionSummary(this.store.executions(task.id, 1)[0]),
        })) };
      case "inspect": {
        only(args, ["taskId"]);
        const id = identifier(args, "taskId");
        return this.store.task(id);
      }
      case "history": {
        only(args, ["taskId", "limit", "offset"]);
        const taskId = args["taskId"] === undefined ? undefined : identifier(args, "taskId");
        const limit = pageInteger(args["limit"] ?? 20, "limit", 1, 50);
        const offset = pageInteger(args["offset"] ?? 0, "offset", 0, Number.MAX_SAFE_INTEGER);
        const rows = this.store.executions(taskId, limit + 1, offset);
        return { executions: rows.slice(0, limit).map(executionSummary), nextOffset: rows.length > limit ? offset + limit : null };
      }
      case "execution":
        only(args, ["executionId"]);
        return this.store.execution(identifier(args, "executionId"));
      case "create": {
        const task = parseDefinition(args, this.defaultTimezone, this.now());
        await this.validateTarget(task);
        return this.store.create(task, this.now());
      }
      case "update": {
        only(args, ["taskId", "revision", "definition"]);
        const task = parseDefinition(object(args["definition"]), this.defaultTimezone, this.now());
        await this.validateTarget(task);
        return this.store.update(identifier(args, "taskId"), revision(args), task, this.now());
      }
      case "pause":
        only(args, ["taskId", "revision", "paused"]);
        if (typeof args["paused"] !== "boolean") throw new Error("paused must be a boolean");
        return this.store.setPaused(identifier(args, "taskId"), revision(args), args["paused"], this.now());
      case "archive":
        only(args, ["taskId", "revision"]);
        return this.store.archive(identifier(args, "taskId"), revision(args), this.now());
      case "delete":
        only(args, ["taskId", "revision"]);
        return this.scheduler.deleteTask(identifier(args, "taskId"), revision(args));
      case "dispatch":
        only(args, ["taskId"]);
        return this.scheduler.dispatchManually(identifier(args, "taskId"));
      case "report":
        only(args, ["executionId", "outcome", "summary"]);
        return this.store.report(identifier(args, "executionId"), text(args["outcome"], "outcome", 32),
          text(args["summary"], "summary", 16 * 1024), this.now());
      default: throw new Error("Unknown scheduled tasks operation");
    }
  }
}

export function configuredTimezone(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const timezone = text(value, "defaultTimezone", 256);
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  return timezone;
}

function parseDefinition(args: Record<string, unknown>, defaultTimezone: string | undefined, now: string): TaskInput {
  only(args, ["name", "projectId", "workspaceId", "prompt", "timezone", "schedule", "contextPaths", "model", "thinkingLevel"]);
  const timezone = args["timezone"] === undefined ? defaultTimezone : args["timezone"];
  if (timezone === undefined) throw new Error("No default timezone is configured. Ask the user for a timezone before creating or rescheduling a task.");
  const schedule = object(args["schedule"]);
  let parsedSchedule: TaskInput["schedule"];
  if (schedule["kind"] === "once") {
    only(schedule, ["kind", "at"]);
    parsedSchedule = { kind: "once", at: text(schedule["at"], "at", 256) };
  } else if (schedule["kind"] === "cron") {
    only(schedule, ["kind", "expression"]);
    parsedSchedule = { kind: "cron", expression: text(schedule["expression"], "expression", 256) };
  } else throw new Error("Schedule kind must be once or cron");
  const paths = args["contextPaths"] ?? [];
  if (!Array.isArray(paths)) throw new Error("contextPaths must be an array");
  return validateTask({
    name: text(args["name"], "name", 512), projectId: identifier(args, "projectId"), workspaceId: identifier(args, "workspaceId"),
    prompt: text(args["prompt"], "prompt", 48 * 1024), timezone: text(timezone, "timezone", 256),
    schedule: parsedSchedule, contextPaths: paths.map((path: unknown) => text(path, "context path", 1024)),
    ...(args["model"] === undefined ? {} : { model: text(args["model"], "model", 512) }),
    ...(args["thinkingLevel"] === undefined ? {} : { thinkingLevel: parseThinkingLevel(args["thinkingLevel"]) }),
  }, now);
}

function parseThinkingLevel(value: unknown): ThinkingLevel {
  const level = THINKING_LEVELS.find((candidate) => candidate === value);
  if (level === undefined) throw new Error("Invalid thinkingLevel");
  return level;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an input object");
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Narrowed JSON transport object.
  return value as Record<string, unknown>;
}
function only(args: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error("Unexpected input field");
}
function identifier(args: Record<string, unknown>, key: string): string { return text(args[key], key, 512); }
function revision(args: Record<string, unknown>): number {
  const value = args["revision"];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Expected a positive task revision");
  return value;
}

function pageInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${String(min)} to ${String(max)}`);
  }
  return value;
}

function taskSummary(task: Task) {
  return {
    id: task.id, name: task.name, revision: task.revision, projectId: task.projectId, workspaceId: task.workspaceId,
    schedule: task.schedule, timezone: task.timezone, paused: task.paused, archived: task.archived, nextDue: task.nextDue,
    ...(task.model === undefined ? {} : { model: task.model }),
    ...(task.thinkingLevel === undefined ? {} : { thinkingLevel: task.thinkingLevel }),
  };
}
function executionSummary(execution: Execution | undefined) {
  if (execution === undefined) return null;
  return {
    id: execution.id, taskId: execution.taskId, task: taskSummary(execution.task), trigger: execution.trigger,
    dueAt: execution.dueAt, createdAt: execution.createdAt, status: execution.status, sessionId: execution.sessionId,
    dispatchError: execution.dispatchError, latestReport: execution.reports.at(-1) ?? null, notices: execution.notices,
    ...(execution.model === undefined ? {} : { model: execution.model }),
    ...(execution.thinkingLevel === undefined ? {} : { thinkingLevel: execution.thinkingLevel }),
  };
}

/** Instructions are attributed in the ordinary initial message, not inferred from session activity. */
export function dispatchPrompt(execution: Execution): string {
  return [
    "This conversation was dispatched by the Scheduled agent tasks plugin.",
    `Task ID: ${execution.taskId}; execution ID: ${execution.id}; task revision: ${String(execution.task.revision)}.`,
    "Discover scheduled_tasks tools through tool_search or codemode searchTools. Retrieve this execution's context with scheduled_tasks_execution.",
    "After doing the work, use scheduled_tasks_report to explicitly report completed or errored with a summary for this execution ID. You may correct an earlier report; reports never stop the conversation.",
    "You have the same task-management authority as an ordinary session. Do not infer an execution outcome from session activity.",
    ...(execution.task.contextPaths.length === 0 ? [] : [
      `Read these workspace-relative shared context files before starting (their contents may have changed): ${JSON.stringify(execution.task.contextPaths)}`,
    ]),
    "", "Task instructions:", execution.task.prompt,
  ].join("\n");
}
