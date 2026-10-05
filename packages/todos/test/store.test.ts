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

describe("authoritative SQLite tasks", () => {
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
    { title: "ok", status: "Waiting" }, { title: "ok", archived: "true" }, { title: "ok", project: "some-project" },
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
