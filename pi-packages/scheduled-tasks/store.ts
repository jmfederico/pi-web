import { randomUUID } from "node:crypto";
import { nextOccurrence, text, validateTask, type Execution, type Task, type TaskInput } from "./domain.js";
import { openSqlite, type SqliteDatabase } from "./sqlite.js";

/** The daemon activation owns one store. Every multi-record mutation is a local SQLite transaction. */
export class TaskStore {
  constructor(private readonly db: SqliteDatabase, private readonly id: () => string = randomUUID) {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
    if (version !== 0 && version !== 1) throw new Error("Unsupported scheduled tasks database version");
    if (version === 0) this.transaction(() => {
      db.exec(`
        CREATE TABLE tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE revisions (
          task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL, body TEXT NOT NULL,
          PRIMARY KEY (task_id, revision)
        );
        CREATE TABLE executions (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
          occurrence TEXT UNIQUE, body TEXT NOT NULL
        );
        CREATE INDEX executions_task ON executions(task_id);
        PRAGMA user_version = 1;
      `);
    });
  }

  static open(path: string): TaskStore {
    const db = openSqlite(path);
    try { return new TaskStore(db); } catch (error) { db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  listTasks(): Task[] {
    return this.db.prepare("SELECT body FROM tasks ORDER BY id").all().map((row) => decode<Task>(row));
  }

  task(id: string): Task {
    const row = this.db.prepare("SELECT body FROM tasks WHERE id = ?").get(id);
    if (row === undefined || row === null) throw new Error("Task not found");
    return decode<Task>(row);
  }

  revisions(taskId: string): Task[] {
    return this.db.prepare("SELECT body FROM revisions WHERE task_id = ? ORDER BY revision").all(taskId).map((row) => decode<Task>(row));
  }

  create(input: TaskInput, now: string): Task {
    const definition = validateTask(input, now);
    const task: Task = { ...definition, id: this.id(), revision: 1, paused: false, archived: false,
      nextDue: nextOccurrence(definition, now), createdAt: now, updatedAt: now };
    return this.transaction(() => {
      this.db.prepare("INSERT INTO tasks (id, body) VALUES (?, ?)").run(task.id, JSON.stringify(task));
      this.saveRevision(task);
      return task;
    });
  }

  update(id: string, revision: number, input: TaskInput, now: string): Task {
    const definition = validateTask(input, now);
    return this.change(id, revision, now, (task) => {
      const scheduleChanged = JSON.stringify(definition.schedule) !== JSON.stringify(task.schedule) || definition.timezone !== task.timezone;
      return { ...task, ...definition, nextDue: scheduleChanged ? nextOccurrence(definition, now) : task.nextDue };
    });
  }

  setPaused(id: string, revision: number, paused: boolean, now: string): Task {
    return this.change(id, revision, now, (task) => ({ ...task, paused,
      nextDue: !paused && task.schedule.kind === "cron" ? nextOccurrence(task, now) : task.nextDue }));
  }

  archive(id: string, revision: number, now: string): Task {
    return this.change(id, revision, now, (task) => ({ ...task, archived: true, nextDue: null }));
  }

  private change(id: string, revision: number, now: string, change: (task: Task) => Task): Task {
    return this.transaction(() => {
      const old = this.task(id);
      if (old.revision !== revision) throw new Error("Task revision conflict; inspect the current task before editing");
      if (old.archived) throw new Error("Archived tasks cannot be modified");
      const task = { ...change(old), revision: old.revision + 1, updatedAt: now };
      this.saveTask(task);
      this.saveRevision(task);
      return task;
    });
  }

  executions(taskId?: string): Execution[] {
    const rows = taskId === undefined
      ? this.db.prepare("SELECT body FROM executions ORDER BY rowid DESC").all()
      : this.db.prepare("SELECT body FROM executions WHERE task_id = ? ORDER BY rowid DESC").all(taskId);
    return rows.map((row) => decode<Execution>(row));
  }

  execution(id: string): Execution {
    const row = this.db.prepare("SELECT body FROM executions WHERE id = ?").get(id);
    if (row === undefined || row === null) throw new Error("Execution not found");
    return decode<Execution>(row);
  }

  /** Called once before starting scheduling. Never retries an interrupted launch. */
  recover(now: string): void {
    this.transaction(() => {
      for (const execution of this.executions()) {
        if (execution.status === "dispatching") {
          this.saveExecution({ ...execution, status: "uncertain", dispatchError: "Daemon stopped before dispatch confirmation; not automatically retried" });
        }
      }
      // Recurrences missed while stopped are skipped; overdue one-offs retain their due time.
      for (const task of this.listTasks()) {
        if (!task.archived && task.schedule.kind === "cron") this.saveTask({ ...task, nextDue: nextOccurrence(task, now) });
      }
    });
  }

  /** Durable reservation precedes all session side effects. A one-off is consumed even if launch fails. */
  claim(taskId: string, trigger: "scheduled" | "manual", now: string): Execution | null {
    return this.transaction(() => {
      const task = this.task(taskId);
      if (task.archived) throw new Error("Archived tasks cannot be dispatched");
      if (trigger === "scheduled" && (task.paused || task.nextDue === null || task.nextDue > now)) return null;
      const dueAt = trigger === "scheduled" ? task.nextDue : now;
      if (dueAt === null) return null;
      const occurrence = trigger === "scheduled" ? `${task.id}:${dueAt}` : null;
      if (occurrence !== null) {
        const existing = this.db.prepare("SELECT id FROM executions WHERE occurrence = ?").get(occurrence);
        if (existing !== undefined && existing !== null) return null;
      }
      const execution: Execution = { id: this.id(), taskId, task, trigger, dueAt, createdAt: now,
        status: "dispatching", sessionId: null, dispatchError: null, reports: [] };
      this.db.prepare("INSERT INTO executions (id, task_id, occurrence, body) VALUES (?, ?, ?, ?)")
        .run(execution.id, taskId, occurrence, JSON.stringify(execution));
      if (trigger === "scheduled") this.saveTask({ ...task, nextDue: task.schedule.kind === "once" ? null : nextOccurrence(task, now) });
      return execution;
    });
  }

  confirmDispatch(id: string, sessionId: string): Execution {
    text(sessionId, "sessionId", 512);
    return this.mutateExecution(id, (execution) => ({ ...execution, sessionId,
      // An agent may explicitly report before the host's initial admission promise resolves.
      status: execution.reports.length > 0 ? execution.status : "dispatched" }));
  }

  dispatchProblem(id: string, error: string, certainFailure: boolean): Execution {
    return this.mutateExecution(id, (execution) => ({ ...execution, dispatchError: error,
      status: execution.reports.length > 0 ? execution.status : certainFailure ? "failed" : "uncertain" }));
  }

  report(id: string, outcome: string, summary: string, now: string): Execution {
    if (outcome !== "completed" && outcome !== "errored") throw new Error("Unknown outcome");
    text(summary, "summary", 16 * 1024);
    return this.mutateExecution(id, (execution) => {
      if (execution.status === "failed") throw new Error("A rejected dispatch has no execution outcome to report");
      return { ...execution, status: outcome, reports: [...execution.reports, { at: now, outcome, summary }] };
    });
  }

  private mutateExecution(id: string, mutate: (execution: Execution) => Execution): Execution {
    return this.transaction(() => {
      const execution = mutate(this.execution(id));
      this.saveExecution(execution);
      return execution;
    });
  }

  private saveTask(task: Task): void {
    this.db.prepare("UPDATE tasks SET body = ? WHERE id = ?").run(JSON.stringify(task), task.id);
  }
  private saveRevision(task: Task): void {
    this.db.prepare("INSERT INTO revisions (task_id, revision, body) VALUES (?, ?, ?)").run(task.id, task.revision, JSON.stringify(task));
  }
  private saveExecution(execution: Execution): void {
    this.db.prepare("UPDATE executions SET body = ? WHERE id = ?").run(JSON.stringify(execution), execution.id);
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- The store owns the versioned schema and all JSON writes; callers select the table record type.
function decode<T>(row: Record<string, unknown>): T {
  if (typeof row["body"] !== "string") throw new Error("Invalid scheduled tasks database record");
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Only read plugin-owned records written by this schema version, not transport input.
  return JSON.parse(row["body"]) as T;
}
