import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_RUNS_PER_TASK, ScheduledTaskRunStore } from "./scheduledTaskRunStore.js";

describe("ScheduledTaskRunStore", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-web-scheduled-task-run-store-test-"));
    filePath = join(tempDir, "scheduled-task-runs.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("starts a run in the running state", async () => {
    const store = new ScheduledTaskRunStore(filePath);
    const run = await store.start({ taskId: "task-1", triggeredBy: "schedule", startedAt: "2026-01-01T00:00:00.000Z", cwd: "/repo" });
    expect(run.status).toBe("running");
    expect(run.cwd).toBe("/repo");
    expect(await store.latestForTask("task-1")).toEqual(run);
  });

  it("patches a run to a terminal status", async () => {
    const store = new ScheduledTaskRunStore(filePath);
    const run = await store.start({ taskId: "task-1", triggeredBy: "manual", startedAt: "2026-01-01T00:00:00.000Z" });
    const patched = await store.patch(run.id, { status: "success", finishedAt: "2026-01-01T00:01:00.000Z", sessionId: "session-1" });
    expect(patched.status).toBe("success");
    expect(patched.sessionId).toBe("session-1");
  });

  it("lists runs for a task newest-first and ignores other tasks", async () => {
    const store = new ScheduledTaskRunStore(filePath);
    await store.start({ taskId: "task-1", triggeredBy: "schedule", startedAt: "2026-01-01T00:00:00.000Z" });
    await store.start({ taskId: "task-2", triggeredBy: "schedule", startedAt: "2026-01-01T00:00:30.000Z" });
    await store.start({ taskId: "task-1", triggeredBy: "schedule", startedAt: "2026-01-01T00:01:00.000Z" });
    const runs = await store.listForTask("task-1");
    expect(runs).toHaveLength(2);
    expect(runs[0]?.startedAt).toBe("2026-01-01T00:01:00.000Z");
    expect(runs[1]?.startedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("trims old runs beyond the per-task cap", async () => {
    const store = new ScheduledTaskRunStore(filePath);
    for (let i = 0; i < MAX_RUNS_PER_TASK + 5; i += 1) {
      await store.start({ taskId: "task-1", triggeredBy: "schedule", startedAt: new Date(2026, 0, 1, 0, i).toISOString() });
    }
    expect(await store.listForTask("task-1")).toHaveLength(MAX_RUNS_PER_TASK);
  });

  it("removes all runs for a task", async () => {
    const store = new ScheduledTaskRunStore(filePath);
    await store.start({ taskId: "task-1", triggeredBy: "schedule", startedAt: "2026-01-01T00:00:00.000Z" });
    await store.start({ taskId: "task-2", triggeredBy: "schedule", startedAt: "2026-01-01T00:00:00.000Z" });
    await store.removeForTask("task-1");
    expect(await store.listForTask("task-1")).toEqual([]);
    expect(await store.listForTask("task-2")).toHaveLength(1);
  });
});
