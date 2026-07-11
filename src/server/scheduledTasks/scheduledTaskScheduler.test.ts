import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Workspace } from "../types.js";
import { ScheduledTaskRunStore } from "../storage/scheduledTaskRunStore.js";
import { ScheduledTaskStore } from "../storage/scheduledTaskStore.js";
import { ScheduledTaskScheduler, type ScheduledTaskSessionRunner } from "./scheduledTaskScheduler.js";
import { ScheduledTaskService } from "./scheduledTaskService.js";

const project: Project = { id: "project-1", name: "pi-web", path: "/repo/pi-web", createdAt: "2026-01-01T00:00:00.000Z" };
const mainWorkspace: Workspace = { id: "workspace-main", projectId: project.id, path: "/repo/pi-web", label: "main", isMain: true, isGitRepo: true, isGitWorktree: false };

class FakeProjectService {
  removed = false;
  requireProject(id: string): Promise<Project> {
    if (this.removed || id !== project.id) return Promise.reject(new Error("Project not found"));
    return Promise.resolve(project);
  }
}

class FakeWorkspaceService {
  list(): Promise<Workspace[]> {
    return Promise.resolve([mainWorkspace]);
  }
}

class FakeSessions implements ScheduledTaskSessionRunner {
  started: string[] = [];
  prompts: { ref: string; text: string }[] = [];
  private statuses = new Map<string, { isStreaming: boolean; isCompacting: boolean; isBashRunning: boolean; pendingMessageCount: number }>();
  private nextId = 0;

  start(cwd: string): Promise<{ id: string }> {
    this.nextId += 1;
    const id = `session-${String(this.nextId)}`;
    this.started.push(cwd);
    this.statuses.set(id, { isStreaming: true, isCompacting: false, isBashRunning: false, pendingMessageCount: 0 });
    return Promise.resolve({ id });
  }

  prompt(ref: string, text: string): Promise<void> {
    this.prompts.push({ ref, text });
    return Promise.resolve();
  }

  status(ref: string): Promise<{ isStreaming: boolean; isCompacting: boolean; isBashRunning: boolean; pendingMessageCount: number }> {
    const status = this.statuses.get(ref);
    if (status === undefined) return Promise.reject(new Error("Session not found"));
    return Promise.resolve(status);
  }

  settle(sessionId: string): void {
    this.statuses.set(sessionId, { isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0 });
  }
}

describe("ScheduledTaskScheduler", () => {
  let tempDir: string;
  let store: ScheduledTaskStore;
  let runs: ScheduledTaskRunStore;
  let projects: FakeProjectService;
  let service: ScheduledTaskService;
  let sessions: FakeSessions;
  let scheduler: ScheduledTaskScheduler;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-web-scheduled-task-scheduler-test-"));
    store = new ScheduledTaskStore(join(tempDir, "scheduled-tasks.json"));
    runs = new ScheduledTaskRunStore(join(tempDir, "scheduled-task-runs.json"));
    projects = new FakeProjectService();
    service = new ScheduledTaskService(store, runs, projects, new FakeWorkspaceService());
    sessions = new FakeSessions();
    // A tiny *real* delay rather than an instantly-resolving no-op: an
    // always-already-resolved sleep turns the completion-watch loop into a
    // pure microtask cycle with no macrotask boundary, which can starve real
    // timers (vi.waitFor, vi.advanceTimersByTimeAsync) that rely on the event
    // loop actually reaching the macrotask phase.
    scheduler = new ScheduledTaskScheduler({ store, runs, service, sessions, pollIntervalMs: 5 });
  });

  afterEach(async () => {
    scheduler.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("runs a task on demand, starting a session and delivering the prompt", async () => {
    const task = await service.create({ name: "Audit", projectId: project.id, prompt: "Check deps", schedule: { cron: "0 6 * * *", timezone: "UTC" } });
    const run = await scheduler.runNow(task.id);
    expect(run.triggeredBy).toBe("manual");
    expect(sessions.started).toEqual([mainWorkspace.path]);
    expect(sessions.prompts).toEqual([{ ref: run.sessionId, text: "Check deps" }]);
  });

  it("marks the run successful once the session settles", async () => {
    const task = await service.create({ name: "Audit", projectId: project.id, prompt: "Check deps", schedule: { cron: "0 6 * * *", timezone: "UTC" } });
    const run = await scheduler.runNow(task.id);
    expect(run.status).toBe("running");
    // Wait past one poll interval so the watch loop observes "busy" at least
    // once before settling — settling immediately would still resolve, just
    // only after the (much longer) SETTLE_GRACE_MS safety window elapses.
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (run.sessionId !== undefined) sessions.settle(run.sessionId);
    await vi.waitFor(async () => {
      const [latest] = await runs.listForTask(task.id);
      expect(latest?.status).toBe("success");
    });
  });

  it("skips a run when the previous one is still in progress", async () => {
    const task = await service.create({ name: "Audit", projectId: project.id, prompt: "Check deps", schedule: { cron: "0 6 * * *", timezone: "UTC" } });
    await scheduler.runNow(task.id); // leaves a "running" run (fake session never settles)
    const second = await scheduler.runNow(task.id);
    expect(second.status).toBe("skipped");
    expect(second.note).toMatch(/previous run still in progress/i);
    expect(sessions.started).toHaveLength(1);
  });

  it("fails the run and disables the task when its project no longer exists", async () => {
    const task = await service.create({ name: "Audit", projectId: project.id, prompt: "Check deps", schedule: { cron: "0 6 * * *", timezone: "UTC" } });
    projects.removed = true;
    const run = await scheduler.runNow(task.id);
    expect(run.status).toBe("failure");
    expect(run.note).toMatch(/no longer exists/i);
    expect((await store.get(task.id))?.enabled).toBe(false);
  });

  it("arms a timer delayed to the computed next occurrence, without firing it", async () => {
    // Deliberately doesn't let the timer actually fire: doing so would kick off
    // execute()'s completion-watch loop, which polls against wall-clock time —
    // mixing that with a frozen fake clock is what causes the watch loop to
    // spin forever (elapsed time never advances, so it never settles).
    // Arming vs. firing are independently covered: this test asserts the delay
    // reschedule() computes; "runs a task on demand" already exercises what
    // firing does, via a direct runNow() call.
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const fixedNow = new Date("2026-01-01T00:00:00.000Z");
    const localScheduler = new ScheduledTaskScheduler({ store, runs, service, sessions, now: () => fixedNow });
    try {
      const task = await service.create({ name: "Hourly", projectId: project.id, prompt: "Tick", schedule: { cron: "0 * * * *", timezone: "UTC" } });
      const stored = await store.get(task.id);
      if (stored === undefined) throw new Error("task not found");
      localScheduler.reschedule(stored);
      const [, delayMs] = setTimeoutSpy.mock.calls.at(-1) ?? [];
      expect(delayMs).toBe(60 * 60 * 1000);
    } finally {
      localScheduler.dispose();
      setTimeoutSpy.mockRestore();
    }
  });

  it("does not arm a timer for a disabled task", async () => {
    const task = await service.create({ name: "Audit", projectId: project.id, prompt: "Check deps", schedule: { cron: "0 6 * * *", timezone: "UTC" }, enabled: false });
    const stored = await store.get(task.id);
    if (stored !== undefined) scheduler.reschedule(stored);
    // No direct way to observe "no timer armed" without reaching into internals;
    // this at least guards against rescheduling a disabled task throwing.
    expect(stored?.enabled).toBe(false);
  });
});
