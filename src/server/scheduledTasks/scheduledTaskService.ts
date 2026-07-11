import type { ScheduledTask, ScheduledTaskCreateRequest, ScheduledTaskRun, ScheduledTaskUpdateRequest } from "../../shared/apiTypes.js";
import type { Project, Workspace } from "../types.js";
import { ScheduledTaskRunStore } from "../storage/scheduledTaskRunStore.js";
import { ScheduledTaskStore } from "../storage/scheduledTaskStore.js";
import { assertValidSchedule, nextCronFireAt } from "./scheduledTaskCron.js";

export interface ScheduledTaskTarget {
  cwd: string;
  project: Project;
  workspace: Workspace;
}

/** Narrow slices of {@link ProjectService}/{@link WorkspaceService} — kept structural so tests can supply fakes without constructing a whole project registry. */
export interface ScheduledTaskProjectLookup {
  requireProject(id: string): Promise<Project>;
}

export interface ScheduledTaskWorkspaceLookup {
  list(project: Project): Promise<Workspace[]>;
}

export class ScheduledTaskService {
  constructor(
    private readonly store: ScheduledTaskStore,
    private readonly runs: ScheduledTaskRunStore,
    private readonly projects: ScheduledTaskProjectLookup,
    private readonly workspaces: ScheduledTaskWorkspaceLookup,
  ) {}

  async list(): Promise<ScheduledTask[]> {
    return (await this.store.list()).map(withNextRun);
  }

  async get(id: string): Promise<ScheduledTask> {
    return withNextRun(await this.requireTask(id));
  }

  async create(input: ScheduledTaskCreateRequest): Promise<ScheduledTask> {
    const name = input.name.trim();
    if (name === "") throw new Error("Scheduled task name must not be empty");
    const prompt = input.prompt.trim();
    if (prompt === "") throw new Error("Scheduled task prompt must not be empty");
    assertValidSchedule(input.schedule.cron, input.schedule.timezone);
    await this.resolveTarget(input.projectId, input.workspaceId);
    const task = await this.store.add({
      name,
      projectId: input.projectId,
      prompt,
      schedule: input.schedule,
      sessionMode: input.sessionMode ?? "new",
      notifyOnComplete: input.notifyOnComplete ?? false,
      enabled: input.enabled ?? true,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    });
    return withNextRun(task);
  }

  async update(id: string, patch: ScheduledTaskUpdateRequest): Promise<ScheduledTask> {
    const existing = await this.requireTask(id);
    if (patch.schedule !== undefined) assertValidSchedule(patch.schedule.cron, patch.schedule.timezone);
    const nextProjectId = patch.projectId ?? existing.projectId;
    const nextWorkspaceId = patch.clearWorkspaceId === true ? undefined : (patch.workspaceId ?? existing.workspaceId);
    if (patch.projectId !== undefined || patch.workspaceId !== undefined || patch.clearWorkspaceId === true) {
      await this.resolveTarget(nextProjectId, nextWorkspaceId);
    }
    const name = patch.name?.trim();
    if (name !== undefined && name === "") throw new Error("Scheduled task name must not be empty");
    const prompt = patch.prompt?.trim();
    if (prompt !== undefined && prompt === "") throw new Error("Scheduled task prompt must not be empty");
    const updated = await this.store.update(id, {
      ...patch,
      ...(name !== undefined ? { name } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
    });
    return withNextRun(updated);
  }

  async remove(id: string): Promise<void> {
    await this.requireTask(id);
    await this.runs.removeForTask(id);
    await this.store.remove(id);
  }

  async runsForTask(id: string): Promise<ScheduledTaskRun[]> {
    await this.requireTask(id);
    return this.runs.listForTask(id);
  }

  /** Resolves a task's `projectId`/`workspaceId` to a concrete cwd, validating both still exist. */
  async resolveTarget(projectId: string, workspaceId: string | undefined): Promise<ScheduledTaskTarget> {
    const project = await this.projects.requireProject(projectId);
    const workspaces = await this.workspaces.list(project);
    const workspace = workspaceId === undefined ? workspaces.find((candidate) => candidate.isMain) : workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace === undefined) throw new Error("Workspace not found");
    return { cwd: workspace.path, project, workspace };
  }

  private async requireTask(id: string): Promise<ScheduledTask> {
    const task = await this.store.get(id);
    if (task === undefined) throw new Error("Scheduled task not found");
    return task;
  }
}

function withNextRun(task: ScheduledTask): ScheduledTask {
  if (!task.enabled) return task;
  const nextRunAt = nextCronFireAt(task.schedule.cron, task.schedule.timezone);
  return nextRunAt === undefined ? task : { ...task, nextRunAt: nextRunAt.toISOString() };
}
