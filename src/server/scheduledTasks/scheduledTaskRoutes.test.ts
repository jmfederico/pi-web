import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScheduledTask, ScheduledTaskRun } from "../../shared/apiTypes.js";
import type { Project, Workspace } from "../types.js";
import { ScheduledTaskRunStore } from "../storage/scheduledTaskRunStore.js";
import { ScheduledTaskStore } from "../storage/scheduledTaskStore.js";
import { registerScheduledTaskRoutes } from "./scheduledTaskRoutes.js";
import { ScheduledTaskScheduler, type ScheduledTaskSessionRunner } from "./scheduledTaskScheduler.js";
import { ScheduledTaskService } from "./scheduledTaskService.js";

const project: Project = { id: "project-1", name: "pi-web", path: "/repo/pi-web", createdAt: "2026-01-01T00:00:00.000Z" };
const mainWorkspace: Workspace = { id: "workspace-main", projectId: project.id, path: "/repo/pi-web", label: "main", isMain: true, isGitRepo: true, isGitWorktree: false };

class FakeProjectService {
  requireProject(id: string): Promise<Project> {
    if (id !== project.id) return Promise.reject(new Error("Project not found"));
    return Promise.resolve(project);
  }
}

class FakeWorkspaceService {
  list(): Promise<Workspace[]> {
    return Promise.resolve([mainWorkspace]);
  }
}

class FakeSessions implements ScheduledTaskSessionRunner {
  start(): Promise<{ id: string }> {
    return Promise.resolve({ id: "session-1" });
  }
  prompt(): Promise<void> {
    return Promise.resolve();
  }
  status(): Promise<{ isStreaming: boolean; isCompacting: boolean; isBashRunning: boolean; pendingMessageCount: number }> {
    return Promise.resolve({ isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0 });
  }
}

let app: FastifyInstance;
let tempDir: string;
let scheduler: ScheduledTaskScheduler;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-scheduled-task-routes-test-"));
  const store = new ScheduledTaskStore(join(tempDir, "scheduled-tasks.json"));
  const runs = new ScheduledTaskRunStore(join(tempDir, "scheduled-task-runs.json"));
  const service = new ScheduledTaskService(store, runs, new FakeProjectService(), new FakeWorkspaceService());
  scheduler = new ScheduledTaskScheduler({ store, runs, service, sessions: new FakeSessions(), pollIntervalMs: 5 });
  app = Fastify({ logger: false });
  registerScheduledTaskRoutes(app, service, scheduler);
});

afterEach(async () => {
  scheduler.dispose();
  await app.close();
  await rm(tempDir, { recursive: true, force: true });
});

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Nightly audit",
    projectId: project.id,
    prompt: "Check dependencies.",
    schedule: { cron: "0 6 * * *", timezone: "UTC" },
    ...overrides,
  };
}

describe("scheduled task routes", () => {
  it("creates and lists a task", async () => {
    const createResponse = await app.inject({ method: "POST", url: "/scheduled-tasks", payload: createBody() });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json<ScheduledTask>();
    expect(created.name).toBe("Nightly audit");

    const listResponse = await app.inject({ method: "GET", url: "/scheduled-tasks" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<ScheduledTask[]>()).toHaveLength(1);
  });

  it("rejects creating a task with a missing field", async () => {
    const response = await app.inject({ method: "POST", url: "/scheduled-tasks", payload: { name: "x" } });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toMatch(/projectId/);
  });

  it("rejects creating a task targeting an unknown project", async () => {
    const response = await app.inject({ method: "POST", url: "/scheduled-tasks", payload: createBody({ projectId: "missing" }) });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe("Project not found");
  });

  it("gets, updates, and deletes a task", async () => {
    const created = (await app.inject({ method: "POST", url: "/scheduled-tasks", payload: createBody() })).json<ScheduledTask>();

    const getResponse = await app.inject({ method: "GET", url: `/scheduled-tasks/${created.id}` });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json<ScheduledTask>().id).toBe(created.id);

    const patchResponse = await app.inject({ method: "PATCH", url: `/scheduled-tasks/${created.id}`, payload: { enabled: false } });
    expect(patchResponse.statusCode).toBe(200);
    expect(patchResponse.json<ScheduledTask>().enabled).toBe(false);

    const deleteResponse = await app.inject({ method: "DELETE", url: `/scheduled-tasks/${created.id}` });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ deleted: true });

    const missingResponse = await app.inject({ method: "GET", url: `/scheduled-tasks/${created.id}` });
    expect(missingResponse.statusCode).toBe(404);
  });

  it("404s operations on an unknown task id", async () => {
    expect((await app.inject({ method: "GET", url: "/scheduled-tasks/missing" })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: "/scheduled-tasks/missing", payload: { enabled: false } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/scheduled-tasks/missing" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/scheduled-tasks/missing/run" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/scheduled-tasks/missing/runs" })).statusCode).toBe(404);
  });

  it("runs a task on demand and lists its run history", async () => {
    const created = (await app.inject({ method: "POST", url: "/scheduled-tasks", payload: createBody() })).json<ScheduledTask>();

    const runResponse = await app.inject({ method: "POST", url: `/scheduled-tasks/${created.id}/run` });
    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json<ScheduledTaskRun>().triggeredBy).toBe("manual");

    const runsResponse = await app.inject({ method: "GET", url: `/scheduled-tasks/${created.id}/runs` });
    expect(runsResponse.statusCode).toBe(200);
    expect(runsResponse.json<ScheduledTaskRun[]>()).toHaveLength(1);
  });
});
