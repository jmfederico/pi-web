import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TodoStore } from "../src/store.js";
import { resultTask, resultTasks } from "../src/browser/protocol.js";

const connections: TodoStore[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const store of connections) store.close();
  connections.length = 0;
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
});
function open(path = ":memory:", id?: () => string): TodoStore {
  const store = new TodoStore(path, () => "2026-10-04T20:00:00.000Z", id);
  connections.push(store); return store;
}

const project = { id: `git:${"a".repeat(64)}`, label: "Repo", kind: "git" } as const;

describe("authoritative SQLite tasks", () => {
  it("upgrades a v1 unassigned database without changing saved tasks and persists project edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "todos-v1-")); roots.push(root);
    const path = join(root, "todos.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, title TEXT NOT NULL, context TEXT NOT NULL,
      project TEXT, status TEXT NOT NULL, archived INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO tasks VALUES ('saved', 7, 'Saved task', 'Keep context', NULL, 'On hold', 1, 'created', 'updated');
      PRAGMA user_version = 1;`);
    legacy.close();
    const store = open(path);
    const saved = resultTask(store.read({ id: "saved" }));
    expect(saved).toMatchObject({ revision: 7, title: "Saved task", project: null, status: "On hold", archived: true, createdAt: "created", updatedAt: "updated" });
    const assigned = resultTask(store.mutate({ id: saved.id, revision: 7, project }));
    expect(assigned).toMatchObject({ revision: 8, project, title: saved.title, context: saved.context, archived: true });
    expect(resultTasks(store.list({ project: project.id, archived: "all", status: "On hold", text: "CONTEXT" }))).toEqual([assigned]);
    expect(resultTasks(store.list({ project: null, archived: "all" }))).toEqual([]);
    expect(store.mutate({ id: saved.id, revision: 7, project: null })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const changed = resultTask(store.mutate({ id: saved.id, revision: 8, archived: false }));
    expect(changed.project).toEqual(project); // Omitted project is not unassignment.
    const reopened = open(path);
    expect(resultTask(reopened.read({ id: saved.id }))).toEqual(changed);
    expect(resultTask(reopened.mutate({ id: saved.id, revision: 9, project: null })).project).toBeNull();
    expect(resultTasks(store.list({ project: null }))).toHaveLength(1);
    const check = new DatabaseSync(path); expect(check.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2); check.close();
  });
  it("combines global, project and unassigned buckets without matching different local-machine IDs", () => {
    const store = open();
    const a = { id: `local:12345678-1234-1234-1234-123456789012:${"a".repeat(64)}`, label: "plain", kind: "local" } as const;
    const b = { ...a, id: a.id.replace("12345678", "87654321") };
    const unassigned = resultTask(store.mutate({ title: "Shared unassigned" }));
    const first = resultTask(store.mutate({ title: "Local a", project: a }));
    const second = resultTask(store.mutate({ title: "Local b", project: b }));
    expect(resultTasks(store.list({}))).toHaveLength(3);
    expect(resultTasks(store.list({ project: a.id }))).toEqual([first]);
    expect(resultTasks(store.list({ project: b.id }))).toEqual([second]);
    expect(resultTasks(store.list({ project: null }))).toEqual([unassigned]);
    expect(resultTasks(store.list({ project: project.id }))).toEqual([]);
  });
  it("persists, partially updates, filters, archives and restores without deleting", async () => {
    const root = await mkdtemp(join(tmpdir(), "todos-store-")); roots.push(root);
    const path = join(root, "todos.sqlite");
    const store = open(path);
    const first = resultTask(store.mutate({ title: "Ship SQLite", context: "Release the personal tools" }));
    expect(first).toMatchObject({ revision: 1, project: null, archived: false, status: "Open" });
    const doing = resultTask(store.mutate({ id: first.id, revision: 1, status: "Doing" }));
    expect(doing).toMatchObject({ id: first.id, revision: 2, title: first.title, context: first.context, createdAt: first.createdAt });
    const second = resultTask(store.mutate({ title: "Write docs", status: "On hold" }));
    expect(resultTasks(store.list({ text: "PERSONAL", status: "Doing", project: null }))).toEqual([doing]);
    expect(resultTasks(store.list({ status: "On hold" }))).toEqual([second]);
    expect(resultTasks(store.list({ text: "no match" }))).toEqual([]);
    const archived = resultTask(store.mutate({ id: doing.id, revision: 2, status: "Done", archived: true }));
    expect(resultTasks(store.list({}))).toEqual([second]);
    expect(resultTasks(store.list({ archived: true }))).toEqual([archived]);
    expect(resultTasks(store.list({ archived: "all" }))).toHaveLength(2);
    expect(resultTask(store.read({ id: first.id }))).toEqual(archived);
    const restored = resultTask(store.mutate({ id: first.id, revision: 3, archived: false, context: "" }));
    expect(restored).toMatchObject({ revision: 4, status: "Done", context: "", archived: false });
    store.close(); connections.splice(connections.indexOf(store), 1);
    expect(resultTask(open(path).read({ id: restored.id }))).toEqual(restored);
  });
  it("atomically rejects a stale revision across independent SQLite connections and never upserts a missing ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "todos-revision-")); roots.push(root);
    const a = open(join(root, "todos.sqlite")); const b = open(join(root, "todos.sqlite"));
    const first = resultTask(a.mutate({ title: "One authority" }));
    const edited = resultTask(b.mutate({ id: first.id, revision: first.revision, title: "Newer title" }));
    expect(a.mutate({ id: first.id, revision: first.revision, context: "stale" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(resultTask(a.read({ id: first.id }))).toEqual(edited);
    expect(a.mutate({ id: "missing", revision: 1, title: "Must not create" })).toMatchObject({ ok: false, error: { code: "missing" } });
    expect(resultTasks(b.list({}))).toEqual([edited]);
  });
  it("rolls back a failed write and remains usable", () => {
    let key = "same";
    const store = open(":memory:", () => key);
    const task = resultTask(store.mutate({ title: "original" }));
    expect(() => store.mutate({ title: "duplicate" })).toThrow();
    key = "other";
    expect(resultTask(store.mutate({ title: "after failure" })).id).toBe("other");
    expect(resultTask(store.read({ id: task.id }))).toEqual(task);
  });
  it.each([
    null, {}, { title: " " }, { title: "x".repeat(201) }, { title: "ok", context: "x".repeat(2001) },
    { title: "ok", status: "Waiting" }, { title: "ok", archived: "true" }, { title: "ok", project: "some-project" }, { title: "ok", project: { ...project, kind: "local" } }, { title: "ok", project: { ...project, label: "" } },
    { title: "ok", priority: 1 }, { title: "ok", revision: 1 }, { id: "x", title: "ok" },
    { id: "x", revision: 0, title: "ok" }, { id: "x", revision: 1 }, { id: "", revision: 1, title: "ok" },
  ])("rejects invalid mutations without writing: %j", (input) => {
    const store = open();
    expect(store.mutate(input)).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(resultTasks(store.list({ archived: "all" }))).toEqual([]);
  });
  it.each([{ status: "Waiting" }, { archived: 1 }, { text: false }, { project: "local" }, { extra: true }])("rejects invalid filters: %j", (filter) => {
    expect(open().list(filter)).toMatchObject({ ok: false, error: { code: "invalid" } });
  });
});
