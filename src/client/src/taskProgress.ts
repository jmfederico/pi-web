import type { ChatLine } from "./components/shared";

const MAX_TASKS = 200;
const MAX_DEPENDENCIES = 500;
const MAX_TASK_DEPENDENCIES = 200;
const MAX_CODEMODE_CALLS = 200;
const MAX_LABEL_LENGTH = 500;

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

interface SnapshotTask {
  id: number;
  subject: string;
  status: TaskStatus;
  activeForm?: string;
  blockedBy: number[];
}

export interface TaskDependency {
  id: number;
  subject?: string;
  status?: Exclude<TaskStatus, "deleted">;
  blocksProgress: boolean;
}

export interface TaskProgressTask {
  id: number;
  subject: string;
  status: Exclude<TaskStatus, "deleted">;
  activeForm?: string;
  dependencies: readonly TaskDependency[];
}

export interface TaskProgress {
  tasks: readonly TaskProgressTask[];
  inProgress: readonly TaskProgressTask[];
  total: number;
  completed: number;
  pending: number;
  blocked: number;
}

export type TaskProgressIssue =
  | "no_snapshot"
  | "todo_result_missing_snapshot"
  | "todo_result_invalid_snapshot"
  | "codemode_todo_unobservable"
  | "codemode_metadata_unavailable";

export type TaskProgressObservation =
  | { state: "current"; progress: TaskProgress }
  | { state: "stale"; progress: TaskProgress; reason: TaskProgressIssue }
  | { state: "unavailable"; reason: TaskProgressIssue };

interface TaskDetailsSnapshot {
  tasks: SnapshotTask[];
}

/** Read the latest complete rpiv-todo result retained in normalized chat messages. */
export function taskProgressFromMessages(messages: readonly ChatLine[]): TaskProgressObservation {
  let progress: TaskProgress | undefined;
  let observation: TaskProgressObservation = { state: "unavailable", reason: "no_snapshot" };
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.parts) {
      const result = todoResultCandidate(part);
      if (result !== undefined) {
        const snapshot = result.details === undefined ? undefined : parseTaskDetails(result.details);
        if (snapshot === undefined) {
          const reason = result.details === undefined ? "todo_result_missing_snapshot" : "todo_result_invalid_snapshot";
          observation = unknownObservation(progress, reason);
        } else {
          progress = progressFromSnapshot(snapshot);
          observation = { state: "current", progress };
        }
        continue;
      }

      const issue = codemodeMetadataIssue(part);
      if (issue !== undefined) observation = unknownObservation(progress, issue);
    }
  }
  return observation;
}

interface TodoResultCandidate {
  details: unknown;
}

function todoResultCandidate(part: ChatLine["parts"][number]): TodoResultCandidate | undefined {
  if (part.type === "toolResult" && part.toolName === "todo") return { details: part.details };
  if (part.type === "toolExecution" && part.toolName === "todo" && (part.status === "success" || part.status === "error")) {
    return { details: part.details };
  }
  return undefined;
}

function codemodeMetadataIssue(part: ChatLine["parts"][number]): TaskProgressIssue | undefined {
  let details: unknown;
  if (part.type === "toolResult" && part.toolName === "codemode") details = part.details;
  else if (part.type === "toolExecution" && part.toolName === "codemode") {
    details = part.details;
    if (details === undefined && part.status !== "success" && part.status !== "error") return undefined;
  }
  else return undefined;
  if (details === undefined) return "codemode_metadata_unavailable";
  if (!isRecord(details)) return "codemode_metadata_unavailable";

  const calls = details["calls"];
  if (!Array.isArray(calls) || calls.length > MAX_CODEMODE_CALLS) return "codemode_metadata_unavailable";
  for (const call of calls) {
    if (!isRecord(call) || typeof call["name"] !== "string") return "codemode_metadata_unavailable";
    if (call["name"] === "todo") return "codemode_todo_unobservable";
  }
  return undefined;
}

function unknownObservation(progress: TaskProgress | undefined, reason: TaskProgressIssue): TaskProgressObservation {
  return progress === undefined ? { state: "unavailable", reason } : { state: "stale", progress, reason };
}

function parseTaskDetails(value: unknown): TaskDetailsSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const nextId = value["nextId"];
  const rawTasks = value["tasks"];
  if (!isAction(value["action"])
    || !isRecord(value["params"])
    || !isPositiveSafeInteger(nextId)
    || (value["error"] !== undefined && typeof value["error"] !== "string")
    || !Array.isArray(rawTasks)
    || rawTasks.length > MAX_TASKS) return undefined;

  const tasks: SnapshotTask[] = [];
  let dependencyCount = 0;
  const ids = new Set<number>();
  for (const rawTask of rawTasks) {
    const task = parseTask(rawTask);
    if (task === undefined || ids.has(task.id)) return undefined;
    ids.add(task.id);
    dependencyCount += task.blockedBy.length;
    if (dependencyCount > MAX_DEPENDENCIES) return undefined;
    tasks.push(task);
  }
  if (tasks.some((task) => task.id >= nextId)) return undefined;
  return { tasks };
}

function parseTask(value: unknown): SnapshotTask | undefined {
  if (!isRecord(value)) return undefined;
  const id = value["id"];
  const subject = value["subject"];
  const status = value["status"];
  if (!isPositiveSafeInteger(id) || typeof subject !== "string" || !isTaskStatus(status)) return undefined;

  const activeForm = value["activeForm"];
  if (activeForm !== undefined && typeof activeForm !== "string") return undefined;
  const rawBlockedBy = value["blockedBy"];
  if (rawBlockedBy !== undefined
    && (!Array.isArray(rawBlockedBy)
      || rawBlockedBy.length > MAX_TASK_DEPENDENCIES
      || !rawBlockedBy.every(isPositiveSafeInteger))) return undefined;

  return {
    id,
    subject: boundedLabel(subject),
    status,
    ...(typeof activeForm !== "string" || activeForm === "" ? {} : { activeForm: boundedLabel(activeForm) }),
    blockedBy: rawBlockedBy === undefined ? [] : rawBlockedBy.filter(isPositiveSafeInteger),
  };
}

function progressFromSnapshot(snapshot: TaskDetailsSnapshot): TaskProgress {
  const allTasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const tasks = snapshot.tasks
    .filter((task): task is SnapshotTask & { status: Exclude<TaskStatus, "deleted"> } => task.status !== "deleted")
    .map((task): TaskProgressTask => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      ...(task.activeForm === undefined ? {} : { activeForm: task.activeForm }),
      dependencies: task.blockedBy.map((id) => {
        const dependency = allTasks.get(id);
        if (dependency === undefined || dependency.status === "deleted") return { id, blocksProgress: false };
        return {
          id,
          subject: dependency.subject,
          status: dependency.status,
          blocksProgress: dependency.status === "pending" || dependency.status === "in_progress",
        };
      }),
    }));
  const inProgress = tasks.filter((task) => task.status === "in_progress");
  return {
    tasks,
    inProgress,
    total: tasks.length,
    completed: tasks.filter((task) => task.status === "completed").length,
    pending: tasks.filter((task) => task.status === "pending").length,
    blocked: tasks.filter((task) => task.status !== "completed" && task.dependencies.some((dependency) => dependency.blocksProgress)).length,
  };
}

function boundedLabel(value: string): string {
  return value.length <= MAX_LABEL_LENGTH ? value : `${value.slice(0, MAX_LABEL_LENGTH - 1)}…`;
}

function isAction(value: unknown): boolean {
  return value === "create" || value === "update" || value === "list" || value === "get" || value === "delete" || value === "clear";
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "deleted";
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
