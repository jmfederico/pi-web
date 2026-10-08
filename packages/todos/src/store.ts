import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isRecord, isProject, isProjectId, isStatus, isTask, type Failure, type ListResult, type TaskResult, type Task, type Mutation, type TaskFilter } from "./browser/protocol.js";

class InvalidInput extends Error {}
const invalid = (message: string): Failure => ({ ok: false, error: { code: "invalid", message } });

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidInput("Expected a to-do input object");
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new InvalidInput(`Unknown field: ${key}`);
  return value;
}
function boundedString(value: unknown, key: string, max: number, nonempty = false): string {
  if (typeof value !== "string" || value.length > max || (nonempty && value.trim() === "")) {
    throw new InvalidInput(`${key} must be ${nonempty ? "non-empty " : ""}text of at most ${String(max)} characters`);
  }
  return value;
}
function parseFilter(value: unknown): TaskFilter {
  const input = object(value, ["status", "text", "archived", "project"]);
  const filter: TaskFilter = {};
  if (Object.hasOwn(input, "status")) {
    if (!isStatus(input["status"])) throw new InvalidInput("Invalid task status");
    filter.status = input["status"];
  }
  if (Object.hasOwn(input, "text")) filter.text = boundedString(input["text"], "text", 2000);
  if (Object.hasOwn(input, "archived")) {
    if (typeof input["archived"] !== "boolean" && input["archived"] !== "all") throw new InvalidInput("archived must be a boolean or all");
    filter.archived = input["archived"];
  }
  if (Object.hasOwn(input, "project")) {
    if (input["project"] !== null && !isProjectId(input["project"])) throw new InvalidInput("project filter must be a resolved project ID or null");
    filter.project = input["project"];
  }
  return filter;
}
function parseMutation(value: unknown): Mutation {
  const input = object(value, ["id", "revision", "title", "context", "project", "status", "archived"]);
  const mutation: Mutation = {};
  if (Object.hasOwn(input, "id")) {
    mutation.id = boundedString(input["id"], "id", 128, true);
    const revision = input["revision"];
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw new InvalidInput("Existing tasks require their current positive revision");
    mutation.revision = revision;
  } else if (Object.hasOwn(input, "revision")) throw new InvalidInput("New tasks must omit revision");
  if (Object.hasOwn(input, "title")) mutation.title = boundedString(input["title"], "title", 200, true);
  if (Object.hasOwn(input, "context")) mutation.context = boundedString(input["context"], "context", 2000);
  if (Object.hasOwn(input, "project")) {
    if (input["project"] !== null && !isProject(input["project"])) throw new InvalidInput("project must be a resolved descriptor or null for unassigned");
    mutation.project = input["project"];
  }
  if (Object.hasOwn(input, "status")) {
    if (!isStatus(input["status"])) throw new InvalidInput("Invalid task status");
    mutation.status = input["status"];
  }
  if (Object.hasOwn(input, "archived")) {
    if (typeof input["archived"] !== "boolean") throw new InvalidInput("archived must be a boolean");
    mutation.archived = input["archived"];
  }
  if (mutation.id === undefined && mutation.title === undefined) throw new InvalidInput("New tasks require a title");
  if (mutation.id !== undefined && Object.keys(mutation).every((key) => key === "id" || key === "revision")) throw new InvalidInput("Supply at least one changed attribute");
  return mutation;
}

/** One authoritative connection. SQLite locking owns the atomic revision check, even across connections. */
export class TodoStore {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly now: () => string = () => new Date().toISOString(), private readonly id: () => string = randomUUID) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout = 1000");
      const version = this.db.prepare("PRAGMA user_version").get()?.["user_version"];
      if (version !== 0 && version !== 1 && version !== 2) throw new Error("Unsupported to-do database version; use a matching package");
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0),
          title TEXT NOT NULL, context TEXT NOT NULL, project TEXT,
          status TEXT NOT NULL CHECK (status IN ('Open', 'Doing', 'On hold', 'Done')),
          archived INTEGER NOT NULL CHECK (archived IN (0, 1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 2;
        COMMIT;`);
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  private task(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row === undefined ? undefined : rowTask(row);
  }
  read(input: unknown): TaskResult {
    try {
      const value = object(input, ["id"]);
      const task = this.task(boundedString(value["id"], "id", 128, true));
      return task === undefined ? { ok: false, error: { code: "missing", message: "Task not found" } } : { ok: true, task };
    } catch (error) { if (error instanceof InvalidInput) return invalid(error.message); throw error; }
  }
  list(input: unknown): ListResult {
    try {
      const filter = parseFilter(input);
      const text = filter.text?.toLowerCase() ?? "";
      const tasks = this.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC, id").all().map(rowTask).filter((task) =>
        (filter.status === undefined || task.status === filter.status)
        && (filter.project === undefined || (task.project?.id ?? null) === filter.project)
        && (filter.archived === "all" || task.archived === (filter.archived ?? false))
        && `${task.title}\n${task.context}`.toLowerCase().includes(text));
      return { ok: true, tasks };
    } catch (error) { if (error instanceof InvalidInput) return invalid(error.message); throw error; }
  }
  mutate(input: unknown): TaskResult {
    let mutation: Mutation;
    try { mutation = parseMutation(input); }
    catch (error) { if (error instanceof InvalidInput) return invalid(error.message); throw error; }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = mutation.id === undefined ? undefined : this.task(mutation.id);
      if (mutation.id !== undefined && previous === undefined) {
        this.db.exec("ROLLBACK");
        return { ok: false, error: { code: "missing", message: "Task not found; updates never create missing IDs" } };
      }
      if (previous !== undefined && mutation.revision !== previous.revision) {
        this.db.exec("ROLLBACK");
        return { ok: false, error: { code: "conflict", message: "Task changed since this edit. Read or refresh it before editing again; no changes were saved." } };
      }
      const time = this.now();
      const task: Task = {
        id: previous?.id ?? this.id(), revision: (previous?.revision ?? 0) + 1,
        title: mutation.title ?? previous?.title ?? "", context: mutation.context ?? previous?.context ?? "",
        project: Object.hasOwn(mutation, "project") ? mutation.project ?? null : previous?.project ?? null,
        status: mutation.status ?? previous?.status ?? "Open",
        archived: mutation.archived ?? previous?.archived ?? false,
        createdAt: previous?.createdAt ?? time, updatedAt: time,
      };
      const project = task.project === null ? null : JSON.stringify(task.project);
      if (previous === undefined) {
        this.db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(task.id, task.revision, task.title, task.context, project, task.status, Number(task.archived), task.createdAt, task.updatedAt);
      } else {
        this.db.prepare("UPDATE tasks SET revision = ?, title = ?, context = ?, project = ?, status = ?, archived = ?, updated_at = ? WHERE id = ? AND revision = ?")
          .run(task.revision, task.title, task.context, project, task.status, Number(task.archived), time, task.id, previous.revision);
      }
      this.db.exec("COMMIT");
      return { ok: true, task };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
function rowTask(row: Record<string, unknown>): Task {
  const project: unknown = typeof row["project"] === "string" ? JSON.parse(row["project"]) : row["project"];
  const task = {
    id: row["id"], revision: row["revision"], title: row["title"], context: row["context"],
    project,
    status: row["status"], archived: row["archived"] === 1, createdAt: row["created_at"], updatedAt: row["updated_at"],
  };
  if (!isTask(task)) throw new Error("Invalid stored task; the database is not supported by this package");
  return task;
}
