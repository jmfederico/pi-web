import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScheduledTaskStore, scheduledTaskStorePath } from "./scheduledTaskStore.js";

describe("scheduledTaskStorePath", () => {
  it("uses PI_WEB_DATA_DIR by default", () => {
    expect(scheduledTaskStorePath({ PI_WEB_DATA_DIR: "demo-data" }, "/tmp/pi-web")).toBe(resolve("/tmp/pi-web", "demo-data", "scheduled-tasks.json"));
  });

  it("uses PI_WEB_SCHEDULED_TASKS_FILE when configured", () => {
    expect(scheduledTaskStorePath({ PI_WEB_SCHEDULED_TASKS_FILE: "demo/tasks.json" }, "/tmp/pi-web")).toBe(resolve("/tmp/pi-web", "demo/tasks.json"));
  });
});

describe("ScheduledTaskStore", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-web-scheduled-task-store-test-"));
    filePath = join(tempDir, "scheduled-tasks.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function input(overrides: Partial<Parameters<ScheduledTaskStore["add"]>[0]> = {}) {
    return {
      name: "Nightly audit",
      projectId: "project-1",
      prompt: "Check for outdated dependencies.",
      schedule: { cron: "0 6 * * *", timezone: "UTC" },
      sessionMode: "new" as const,
      notifyOnComplete: false,
      enabled: true,
      ...overrides,
    };
  }

  it("returns an empty list when no file exists yet", async () => {
    const store = new ScheduledTaskStore(filePath);
    expect(await store.list()).toEqual([]);
  });

  it("adds a task with a generated id and timestamps", async () => {
    const store = new ScheduledTaskStore(filePath);
    const task = await store.add(input());
    expect(task.id).not.toBe("");
    expect(task.createdAt).toBe(task.updatedAt);
    expect(task.workspaceId).toBeUndefined();
    expect(await store.get(task.id)).toEqual(task);
  });

  it("persists an explicit workspaceId", async () => {
    const store = new ScheduledTaskStore(filePath);
    const task = await store.add(input({ workspaceId: "workspace-1" }));
    expect((await store.get(task.id))?.workspaceId).toBe("workspace-1");
  });

  it("updates fields and bumps updatedAt", async () => {
    const store = new ScheduledTaskStore(filePath);
    const task = await store.add(input());
    const updated = await store.update(task.id, { name: "Renamed", enabled: false });
    expect(updated.name).toBe("Renamed");
    expect(updated.enabled).toBe(false);
    expect(updated.prompt).toBe(task.prompt);
  });

  it("clears workspaceId when clearWorkspaceId is set", async () => {
    const store = new ScheduledTaskStore(filePath);
    const task = await store.add(input({ workspaceId: "workspace-1" }));
    const updated = await store.update(task.id, { clearWorkspaceId: true });
    expect(updated.workspaceId).toBeUndefined();
  });

  it("rejects updating an unknown task", async () => {
    const store = new ScheduledTaskStore(filePath);
    await expect(store.update("missing", { name: "x" })).rejects.toThrow("Scheduled task not found");
  });

  it("removes a task", async () => {
    const store = new ScheduledTaskStore(filePath);
    const task = await store.add(input());
    expect(await store.remove(task.id)).toBe(true);
    expect(await store.get(task.id)).toBeUndefined();
    expect(await store.remove(task.id)).toBe(false);
  });
});
