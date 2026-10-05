/* eslint-disable @typescript-eslint/consistent-type-definitions -- Type aliases retain implicit JSON index signatures at the public backend boundary. */
export const STATUSES = ["Open", "Doing", "On hold", "Done"] as const;
export type TaskStatus = typeof STATUSES[number];
export type Task = {
  id: string;
  revision: number;
  title: string;
  context: string;
  project: null;
  status: TaskStatus;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};
export type TaskFilter = { status?: TaskStatus; text?: string; archived?: boolean | "all"; project?: null };
export type Mutation = {
  id?: string; revision?: number; title?: string; context?: string;
  project?: null; status?: TaskStatus; archived?: boolean;
};
export type Failure = { ok: false; error: { code: "invalid" | "missing" | "conflict"; message: string } };
export type TaskResult = { ok: true; task: Task } | Failure;
export type ListResult = { ok: true; tasks: Task[] } | Failure;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isStatus(value: unknown): value is TaskStatus {
  return STATUSES.some((status) => status === value);
}
export function isTask(value: unknown): value is Task {
  return isRecord(value) && typeof value["id"] === "string" && Number.isSafeInteger(value["revision"])
    && typeof value["revision"] === "number" && value["revision"] > 0
    && typeof value["title"] === "string" && typeof value["context"] === "string"
    && value["project"] === null && isStatus(value["status"]) && typeof value["archived"] === "boolean"
    && typeof value["createdAt"] === "string" && typeof value["updatedAt"] === "string";
}
export function resultTask(value: unknown): Task {
  if (isRecord(value) && value["ok"] === true && isTask(value["task"])) return value["task"];
  throw resultError(value);
}
export function resultTasks(value: unknown): Task[] {
  if (isRecord(value) && value["ok"] === true && Array.isArray(value["tasks"]) && value["tasks"].every(isTask)) return value["tasks"];
  throw resultError(value);
}
function resultError(value: unknown): Error {
  if (isRecord(value) && value["ok"] === false && isRecord(value["error"]) && typeof value["error"]["message"] === "string") {
    return new Error(value["error"]["message"]);
  }
  return new Error("Invalid to-do backend response; update matching packages on both machines");
}
