import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project, Workspace } from "../types.js";
import { ScheduledTaskRunStore } from "../storage/scheduledTaskRunStore.js";
import { ScheduledTaskStore } from "../storage/scheduledTaskStore.js";
import { ScheduledTaskService, type ScheduledTaskProjectLookup, type ScheduledTaskWorkspaceLookup } from "./scheduledTaskService.js";

const project: Project = { id: "project-1", name: "pi-web", path: "/repo/pi-web", createdAt: "2026-01-01T00:00:00.000Z" };
const mainWorkspace: Workspace = { id: "workspace-main", projectId: project.id, path: "/repo/pi-web", label: "main", isMain: true, isGitRepo: true, isGitWorktree: false };
const worktree: Workspace = { id: "workspace-wt", projectId: project.id, path: "/repo/pi-web-wt", label: "feature", branch: "feature", isMain: false, isGitRepo: true, isGitWorktree: true };

const fakeProjects: ScheduledTaskProjectLookup = {
  requireProject: (id) => (id === project.id ? Promise.resolve(project) : Promise.reject(new Error("Project not found"))),
};

const fakeWorkspaces: ScheduledTaskWorkspaceLookup = {
  list: () => Promise.resolve([mainWorkspace, worktree]),
};

describe("ScheduledTaskService", () => {
  let tempDir: string;
  let service: ScheduledTaskService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-web-scheduled-task-service-test-"));
    const store = new ScheduledTaskStore(join(tempDir, "scheduled-tasks.json"));
    const runs = new ScheduledTaskRunStore(join(tempDir, "scheduled-task-runs.json"));
    service = new ScheduledTaskService(store, runs, fakeProjects, fakeWorkspaces);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createRequest(overrides: Partial<Parameters<ScheduledTaskService["create"]>[0]> = {}) {
    return {
      name: "Nightly audit",
      projectId: project.id,
      prompt: "Check dependencies.",
      schedule: { cron: "0 6 * * *", timezone: "UTC" },
      ...overrides,
    };
  }

  it("creates a task defaulting sessionMode, notifyOnComplete, and enabled", async () => {
    const task = await service.create(createRequest());
    expect(task.sessionMode).toBe("new");
    expect(task.notifyOnComplete).toBe(false);
    expect(task.enabled).toBe(true);
    expect(task.nextRunAt).toBeDefined();
  });

  it("trims name and prompt", async () => {
    const task = await service.create(createRequest({ name: "  Nightly audit  ", prompt: "  Check dependencies.  " }));
    expect(task.name).toBe("Nightly audit");
    expect(task.prompt).toBe("Check dependencies.");
  });

  it("rejects an empty name or prompt", async () => {
    await expect(service.create(createRequest({ name: "   " }))).rejects.toThrow("name must not be empty");
    await expect(service.create(createRequest({ prompt: "   " }))).rejects.toThrow("prompt must not be empty");
  });

  it("rejects an invalid cron expression", async () => {
    await expect(service.create(createRequest({ schedule: { cron: "not a cron", timezone: "UTC" } }))).rejects.toThrow("Invalid cron expression");
  });

  it("rejects a project that does not exist", async () => {
    await expect(service.create(createRequest({ projectId: "missing" }))).rejects.toThrow("Project not found");
  });

  it("rejects a workspaceId that is not one of the project's workspaces", async () => {
    await expect(service.create(createRequest({ workspaceId: "missing" }))).rejects.toThrow("Workspace not found");
  });

  it("accepts a valid worktree workspaceId", async () => {
    const task = await service.create(createRequest({ workspaceId: worktree.id }));
    expect(task.workspaceId).toBe(worktree.id);
  });

  it("resolves the main workspace when workspaceId is omitted", async () => {
    await service.create(createRequest());
    const target = await service.resolveTarget(project.id, undefined);
    expect(target.cwd).toBe(mainWorkspace.path);
    expect(target.workspace.id).toBe(mainWorkspace.id);
  });

  it("does not compute nextRunAt for a disabled task", async () => {
    const task = await service.create(createRequest({ enabled: false }));
    expect(task.nextRunAt).toBeUndefined();
  });

  it("updates a task and re-validates the target when the workspace changes", async () => {
    const task = await service.create(createRequest());
    const updated = await service.update(task.id, { workspaceId: worktree.id });
    expect(updated.workspaceId).toBe(worktree.id);
    await expect(service.update(task.id, { workspaceId: "missing" })).rejects.toThrow("Workspace not found");
  });

  it("removes a task along with its run history", async () => {
    const task = await service.create(createRequest());
    await service.remove(task.id);
    await expect(service.get(task.id)).rejects.toThrow("Scheduled task not found");
  });

  it("rejects operating on an unknown task id", async () => {
    await expect(service.get("missing")).rejects.toThrow("Scheduled task not found");
    await expect(service.update("missing", { name: "x" })).rejects.toThrow("Scheduled task not found");
    await expect(service.remove("missing")).rejects.toThrow("Scheduled task not found");
    await expect(service.runsForTask("missing")).rejects.toThrow("Scheduled task not found");
  });
});
