import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextOccurrence, validateTask, type Execution, type TaskInput } from "./domain.js";
import { DispatchRejected, TaskScheduler } from "./scheduler.js";
import { openSqlite } from "./sqlite.js";
import { TaskStore } from "./store.js";

const NOW = "2026-03-07T14:00:00.000Z";
const LATER = "2026-03-10T14:00:00.000Z";
function input(overrides: Partial<TaskInput> = {}): TaskInput {
  return { name: "Review issues", projectId: "project-1", workspaceId: "workspace-1", prompt: "Review new issues",
    timezone: "America/New_York", schedule: { kind: "once", at: NOW }, contextPaths: ["context/issues.md"], ...overrides };
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected a value");
  return value;
}
const stores: TaskStore[] = [];
const directories: string[] = [];
function memory(): TaskStore {
  const store = TaskStore.open(":memory:");
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("task definitions and SQLite ledger", () => {
  it("persists immutable revisions, execution instructions, explicit corrections and conversation identity across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "scheduled-tasks-"));
    directories.push(directory);
    const path = join(directory, "tasks.sqlite");
    const store = TaskStore.open(path);
    const task = store.create(input(), NOW);
    const execution = required(store.claim(task.id, "scheduled", NOW));
    store.update(task.id, 1, input({ prompt: "Different instructions" }), NOW);
    expect(store.execution(execution.id).task.prompt).toBe("Review new issues");
    // A fast initial turn can report before admission returns its session id.
    store.report(execution.id, "completed", "Classified 5 issues", NOW);
    store.confirmDispatch(execution.id, "session-1");
    store.report(execution.id, "errored", "Correction: one classification was not saved", LATER);
    store.close();

    const reopened = TaskStore.open(path);
    stores.push(reopened);
    reopened.recover(LATER);
    expect(reopened.task(task.id)).toMatchObject({ revision: 2, prompt: "Different instructions", nextDue: null });
    expect(reopened.revisions(task.id).map((revision) => revision.prompt)).toEqual(["Review new issues", "Different instructions"]);
    expect(reopened.execution(execution.id)).toMatchObject({ sessionId: "session-1", status: "errored", reports: [
      { outcome: "completed", summary: "Classified 5 issues" },
      { outcome: "errored", summary: "Correction: one classification was not saved" },
    ] });
  });

  it("deletes only archived tasks at their current revision and removes all owned records", () => {
    const store = memory();
    const task = store.create(input(), NOW);
    const other = store.create(input(), NOW);
    const execution = required(store.claim(task.id, "manual", NOW));
    store.confirmDispatch(execution.id, "preserved-conversation");
    store.report(execution.id, "completed", "Done", NOW);
    store.report(execution.id, "errored", "Correction", NOW);
    const otherExecution = required(store.claim(other.id, "manual", NOW));
    expect(() => { store.delete(task.id, task.revision); }).toThrow("Only archived tasks");
    const archived = store.archive(task.id, task.revision, NOW);
    expect(() => { store.delete(task.id, task.revision); }).toThrow("revision conflict");
    expect(store.revisions(task.id)).toHaveLength(2);
    expect(store.execution(execution.id).reports).toHaveLength(2);
    store.delete(task.id, archived.revision);
    expect(() => store.task(task.id)).toThrow("Task not found");
    expect(store.revisions(task.id)).toEqual([]);
    expect(store.executions(task.id)).toEqual([]);
    expect(() => store.execution(execution.id)).toThrow("Execution not found");
    expect(() => store.report(execution.id, "completed", "Late report", NOW)).toThrow("Execution not found");
    expect(store.listTasks()).toEqual([other]);
    expect(store.executions()).toEqual([otherExecution]);
    expect(() => { store.delete(task.id, archived.revision); }).toThrow("Task not found");
  });

  it("rolls back every deletion if a durable write fails", () => {
    const db = openSqlite(":memory:");
    const store = new TaskStore(db);
    stores.push(store);
    const task = store.create(input(), NOW);
    const execution = required(store.claim(task.id, "manual", NOW));
    const archived = store.archive(task.id, task.revision, NOW);
    db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT, 'delete rejected'); END;");
    expect(() => { store.delete(task.id, archived.revision); }).toThrow("delete rejected");
    expect(store.task(task.id)).toEqual(archived);
    expect(store.revisions(task.id)).toHaveLength(2);
    expect(store.execution(execution.id)).toEqual(execution);
  });

  it("rolls back task creation when saving the revision fails", () => {
    const db = openSqlite(":memory:");
    const store = new TaskStore(db);
    stores.push(store);
    db.exec("CREATE TRIGGER reject_revision BEFORE INSERT ON revisions BEGIN SELECT RAISE(ABORT, 'disk write rejected'); END;");
    expect(() => store.create(input(), NOW)).toThrow("disk write rejected");
    expect(store.listTasks()).toEqual([]);
    db.exec("DROP TRIGGER reject_revision;");
    expect(store.create(input(), NOW).revision).toBe(1);
  });

  it("rejects stale edits and preserves consumed one-offs through editing or pause/resume", () => {
    const store = memory();
    const task = store.create(input(), NOW);
    store.claim(task.id, "scheduled", NOW);
    const edited = store.update(task.id, 1, input({ name: "Renamed" }), LATER);
    expect(edited.nextDue).toBeNull();
    expect(() => store.update(task.id, 1, input(), NOW)).toThrow("revision conflict");
    const paused = store.setPaused(task.id, edited.revision, true, NOW);
    const resumed = store.setPaused(task.id, paused.revision, false, NOW);
    expect(resumed.nextDue).toBeNull();
    const rescheduled = store.update(task.id, resumed.revision, input({ schedule: { kind: "once", at: LATER } }), NOW);
    expect(rescheduled.nextDue).toBe(LATER);
    expect(store.revisions(task.id)).toHaveLength(5);
  });

  it("reserves each scheduled occurrence once across separate database connections", () => {
    const directory = mkdtempSync(join(tmpdir(), "scheduled-tasks-"));
    directories.push(directory);
    const path = join(directory, "tasks.sqlite");
    const first = TaskStore.open(path);
    const second = TaskStore.open(path);
    stores.push(first, second);
    const task = first.create(input(), NOW);
    expect(first.claim(task.id, "scheduled", NOW)?.status).toBe("dispatching");
    expect(second.claim(task.id, "scheduled", NOW)).toBeNull();
    expect(second.executions(task.id)).toHaveLength(1);
  });

  it("skips missed recurrences but dispatches overdue one-offs and never retries interrupted launches", () => {
    const store = memory();
    const once = store.create(input(), NOW);
    const recurring = store.create(input({ schedule: { kind: "cron", expression: "0 9 * * *" } }), NOW);
    const interrupted = store.create(input(), NOW);
    const claimed = required(store.claim(interrupted.id, "scheduled", NOW));
    store.recover(LATER);
    expect(store.task(once.id).nextDue).toBe(NOW);
    expect(store.task(recurring.id).nextDue).toBe("2026-03-11T13:00:00.000Z");
    expect(store.execution(claimed.id)).toMatchObject({ status: "uncertain", sessionId: null });
    expect(store.claim(interrupted.id, "scheduled", LATER)).toBeNull();
    expect(store.claim(once.id, "scheduled", LATER)).not.toBeNull();
  });

  it("pausing/archiving affects only future scheduling; manual dispatch does not consume a schedule", () => {
    const store = memory();
    const task = store.create(input(), NOW);
    const paused = store.setPaused(task.id, 1, true, NOW);
    expect(store.claim(task.id, "scheduled", NOW)).toBeNull();
    const manual = required(store.claim(task.id, "manual", NOW));
    store.confirmDispatch(manual.id, "ongoing-session");
    expect(store.task(task.id).nextDue).toBe(NOW);
    store.archive(task.id, paused.revision, NOW);
    expect(() => store.claim(task.id, "manual", LATER)).toThrow("Archived");
    expect(store.execution(manual.id)).toMatchObject({ status: "dispatched", sessionId: "ongoing-session" });
    expect(store.report(manual.id, "completed", "Done after archive", LATER).status).toBe("completed");
  });
});

describe("dispatch orchestration", () => {
  it("keeps recurrences independent of unresolved launches and explicit outcomes", async () => {
    const store = memory();
    let now = NOW;
    const task = store.create(input({ schedule: { kind: "cron", expression: "* * * * *" } }), now);
    const resolveLaunches: ((value: { sessionId: string }) => void)[] = [];
    const dispatch = vi.fn(() => new Promise<{ sessionId: string }>((resolve) => resolveLaunches.push(resolve)));
    const scheduler = new TaskScheduler(store, { dispatch }, () => now, vi.fn());
    now = "2026-03-07T14:01:00.000Z";
    scheduler.tick();
    scheduler.tick();
    now = "2026-03-07T14:02:00.000Z";
    scheduler.tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
    scheduler.stop();
    now = "2026-03-07T14:03:00.000Z";
    scheduler.tick();
    await expect(scheduler.dispatchManually(task.id)).rejects.toThrow("stopping");
    resolveLaunches.forEach((resolve, index) => { resolve({ sessionId: `session-${String(index)}` }); });
    await scheduler.drain();
    expect(store.executions(task.id).map((execution) => execution.status)).toEqual(["dispatched", "dispatched"]);
    expect(store.executions(task.id).every((execution) => execution.reports.length === 0)).toBe(true);
  });

  it("rejects deletion during admission even after an early outcome report, then allows it", async () => {
    const store = memory();
    const task = store.create(input(), NOW);
    const other = store.create(input(), NOW);
    let admit: ((value: { sessionId: string }) => void) | undefined;
    const scheduler = new TaskScheduler(store, {
      dispatch: () => new Promise((resolve) => { admit = resolve; }),
    }, () => NOW, vi.fn());
    const dispatch = scheduler.dispatchManually(task.id);
    const execution = required(store.executions(task.id)[0]);
    store.report(execution.id, "completed", "Fast outcome", NOW);
    const archived = store.archive(task.id, task.revision, NOW);
    const otherArchived = store.archive(other.id, other.revision, NOW);
    expect(() => scheduler.deleteTask(task.id, archived.revision)).toThrow("dispatch is in progress");
    expect(scheduler.deleteTask(other.id, otherArchived.revision)).toEqual({ taskId: other.id, deleted: true });
    if (admit === undefined) throw new Error("Missing dispatch");
    admit({ sessionId: "preserved-conversation" });
    await dispatch;
    expect(scheduler.deleteTask(task.id, archived.revision)).toEqual({ taskId: task.id, deleted: true });
    scheduler.tick();
    expect(store.executions()).toEqual([]);
  });

  it("records proven pre-publication failures separately from uncertain launches, without retries", async () => {
    const store = memory();
    const failure = store.create(input(), NOW);
    const uncertain = store.create(input(), NOW);
    const dispatch = vi.fn((execution: Execution): Promise<{ sessionId: string }> => Promise.reject(
      execution.taskId === failure.id ? new DispatchRejected("Workspace no longer registered") : new Error("Connection lost after request"),
    ));
    const scheduler = new TaskScheduler(store, { dispatch }, () => NOW, vi.fn());
    scheduler.tick();
    await scheduler.drain();
    scheduler.tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(store.executions(failure.id)[0]).toMatchObject({ status: "failed", dispatchError: "Workspace no longer registered" });
    expect(store.executions(uncertain.id)[0]).toMatchObject({ status: "uncertain", dispatchError: "Connection lost after request" });
    // An uncertain launch can later be reconciled by explicit outcome, never session-idle inference.
    const execution = required(store.executions(uncertain.id)[0]);
    expect(store.report(execution.id, "completed", "The launch did happen", NOW).status).toBe("completed");
    expect(() => store.report(required(store.executions(failure.id)[0]).id, "completed", "Not started", NOW)).toThrow("rejected dispatch");
  });
});

describe("schedule/input boundaries", () => {
  it("stores explicit timezones and delegates DST-aware recurrence calculation to cron-parser", () => {
    const task = input({ schedule: { kind: "cron", expression: "0 9 * * *" } });
    expect(nextOccurrence(task, NOW)).toBe("2026-03-08T13:00:00.000Z");
    expect(() => validateTask(input({ timezone: "" }), NOW)).toThrow();
    expect(() => validateTask(input({ timezone: "Not/AZone" }), NOW)).toThrow();
    expect(() => validateTask(input({ schedule: { kind: "once", at: "2026-03-07T09:00:00" } }), NOW)).toThrow("explicit UTC offset");
    expect(() => validateTask(input({ schedule: { kind: "cron", expression: "H * * * *" } }), NOW)).toThrow("deterministic five-field");
    expect(validateTask(input({ schedule: { kind: "cron", expression: "0 9 * * THU" } }), NOW).schedule.kind).toBe("cron");
  });

  it("bounds instructions and context, and strips transport properties rather than trusting them as stored identity", () => {
    expect(() => validateTask(input({ prompt: "x".repeat(49 * 1024) }), NOW)).toThrow("prompt");
    expect(() => validateTask(input({ contextPaths: ["../outside.md"] }), NOW)).toThrow("workspace-relative");
    const extra = { ...input(), id: "injected", paused: true };
    expect(validateTask(extra, NOW)).not.toHaveProperty("id");
    const store = memory();
    const task = store.create(input(), NOW);
    const updated = store.update(task.id, 1, extra, NOW);
    expect(updated).toMatchObject({ id: task.id, paused: false });
  });
});
