import { afterEach, expect, it, vi } from "vitest";
import { TaskScheduler } from "./scheduler.js";
import { TaskService } from "./service.js";
import { TaskStore } from "./store.js";

const NOW = "2030-01-01T00:00:00.000Z";
const stores: TaskStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

it("accepts overrides through create/update and exposes requested/effective selections and notices in summaries", async () => {
  const store = TaskStore.open(":memory:");
  stores.push(store);
  const scheduler = new TaskScheduler(store, { dispatch: () => Promise.reject(new Error("Unused")) }, () => NOW, vi.fn());
  const service = new TaskService(store, scheduler, () => Promise.resolve(), "UTC", () => NOW, {
    version: 1,
    projects: { list: () => Promise.resolve([]), get: () => Promise.reject(new Error("Unused")) },
    workspaces: { list: () => Promise.resolve([]), get: () => Promise.reject(new Error("Unused")) },
    sessions: { list: () => Promise.resolve([]), get: () => Promise.reject(new Error("Unused")) },
  });
  const definition = { name: "Work", projectId: "project", workspaceId: "workspace", prompt: "Do work",
    schedule: { kind: "once", at: NOW }, model: "provider/requested", thinkingLevel: "max" };
  await expect(service.request("create", definition)).resolves.toMatchObject({ model: "provider/requested", thinkingLevel: "max" });
  const task = store.listTasks()[0];
  if (task === undefined) throw new Error("Missing task");
  const execution = store.claim(task.id, "manual", NOW);
  if (execution === null) throw new Error("Missing execution");
  store.confirmDispatch(execution.id, "session", { model: "provider/default", thinkingLevel: "high",
    notices: ["Default model selected"] });
  await expect(service.request("overview", {})).resolves.toMatchObject({ tasks: [{ model: "provider/requested", thinkingLevel: "max",
    latestExecution: { model: "provider/default", thinkingLevel: "high", notices: ["Default model selected"] } }] });
  await expect(service.request("history", {})).resolves.toMatchObject({ executions: [{ task: { model: "provider/requested" },
    model: "provider/default", notices: ["Default model selected"] }] });
  for (const overrides of [{ model: "" }, { model: null }, { thinkingLevel: "invalid" }, { thinkingLevel: null }]) {
    await expect(service.request("create", { ...definition, ...overrides })).rejects.toThrow();
  }
  const defaults: { model?: string; thinkingLevel?: string } = { ...definition };
  delete defaults.model;
  delete defaults.thinkingLevel;
  await service.request("update", { taskId: task.id, revision: 1, definition: defaults });
  expect(store.task(task.id)).not.toHaveProperty("model");
  expect(store.task(task.id)).not.toHaveProperty("thinkingLevel");
});
