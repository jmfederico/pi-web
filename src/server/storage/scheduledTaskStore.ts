import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { piWebDataDir } from "../../config.js";
import type { ScheduledTask, ScheduledTaskSchedule, ScheduledTaskSessionMode } from "../../shared/apiTypes.js";

interface ScheduledTaskFile {
  tasks: ScheduledTask[];
}

export interface ScheduledTaskInput {
  name: string;
  projectId: string;
  workspaceId?: string;
  prompt: string;
  schedule: ScheduledTaskSchedule;
  sessionMode: ScheduledTaskSessionMode;
  notifyOnComplete: boolean;
  enabled: boolean;
}

export interface ScheduledTaskPatch {
  name?: string;
  projectId?: string;
  workspaceId?: string;
  /** Set true to clear workspaceId back to "project's main workspace". */
  clearWorkspaceId?: boolean;
  prompt?: string;
  schedule?: ScheduledTaskSchedule;
  sessionMode?: ScheduledTaskSessionMode;
  notifyOnComplete?: boolean;
  enabled?: boolean;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSchedule(value: unknown): ScheduledTaskSchedule {
  if (!isRecord(value)) throw new Error("Invalid scheduled task schedule");
  const cron = value["cron"];
  const timezone = value["timezone"];
  if (typeof cron !== "string" || cron.trim() === "") throw new Error("Invalid scheduled task cron expression");
  if (typeof timezone !== "string" || timezone.trim() === "") throw new Error("Invalid scheduled task timezone");
  return { cron, timezone };
}

function parseSessionMode(value: unknown): ScheduledTaskSessionMode {
  if (value !== "new" && value !== "continue-latest") throw new Error("Invalid scheduled task session mode");
  return value;
}

function parseTask(value: unknown): ScheduledTask {
  if (!isRecord(value)) throw new Error("Invalid scheduled task");
  const id = value["id"];
  const name = value["name"];
  const projectId = value["projectId"];
  const prompt = value["prompt"];
  const notifyOnComplete = value["notifyOnComplete"];
  const enabled = value["enabled"];
  const createdAt = value["createdAt"];
  const updatedAt = value["updatedAt"];
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof projectId !== "string" ||
    typeof prompt !== "string" ||
    typeof notifyOnComplete !== "boolean" ||
    typeof enabled !== "boolean" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    throw new Error("Invalid scheduled task");
  }
  const workspaceId = value["workspaceId"];
  return {
    id,
    name,
    projectId,
    prompt,
    notifyOnComplete,
    enabled,
    createdAt,
    updatedAt,
    schedule: parseSchedule(value["schedule"]),
    sessionMode: parseSessionMode(value["sessionMode"]),
    ...(typeof workspaceId === "string" && workspaceId !== "" ? { workspaceId } : {}),
  };
}

function parseScheduledTaskFile(value: unknown): ScheduledTaskFile {
  if (!isRecord(value) || !Array.isArray(value["tasks"])) throw new Error("Invalid scheduled tasks file");
  return { tasks: value["tasks"].map(parseTask) };
}

export function defaultScheduledTaskStorePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebDataDir(env, cwd), "scheduled-tasks.json");
}

export function scheduledTaskStorePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const configured = env["PI_WEB_SCHEDULED_TASKS_FILE"];
  if (configured === undefined || configured === "") return defaultScheduledTaskStorePath(env, cwd);
  return resolve(cwd, configured);
}

export class ScheduledTaskStore {
  constructor(private readonly filePath = scheduledTaskStorePath()) {}

  async list(): Promise<ScheduledTask[]> {
    return (await this.read()).tasks;
  }

  async get(id: string): Promise<ScheduledTask | undefined> {
    return (await this.list()).find((task) => task.id === id);
  }

  async add(input: ScheduledTaskInput): Promise<ScheduledTask> {
    const data = await this.read();
    const now = new Date().toISOString();
    const task: ScheduledTask = {
      id: randomUUID(),
      name: input.name,
      projectId: input.projectId,
      prompt: input.prompt,
      schedule: input.schedule,
      sessionMode: input.sessionMode,
      notifyOnComplete: input.notifyOnComplete,
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    };
    data.tasks.push(task);
    await this.write(data);
    return task;
  }

  async update(id: string, patch: ScheduledTaskPatch): Promise<ScheduledTask> {
    const data = await this.read();
    const index = data.tasks.findIndex((task) => task.id === id);
    const existing = data.tasks[index];
    if (existing === undefined) throw new Error("Scheduled task not found");
    const merged: ScheduledTask = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
      ...(patch.sessionMode !== undefined ? { sessionMode: patch.sessionMode } : {}),
      ...(patch.notifyOnComplete !== undefined ? { notifyOnComplete: patch.notifyOnComplete } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (patch.clearWorkspaceId === true) delete merged.workspaceId;
    else if (patch.workspaceId !== undefined) merged.workspaceId = patch.workspaceId;
    data.tasks[index] = merged;
    await this.write(data);
    return merged;
  }

  async remove(id: string): Promise<boolean> {
    const data = await this.read();
    const tasks = data.tasks.filter((task) => task.id !== id);
    if (tasks.length === data.tasks.length) return false;
    await this.write({ tasks });
    return true;
  }

  private async read(): Promise<ScheduledTaskFile> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return parseScheduledTaskFile(value);
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) return { tasks: [] };
      throw error;
    }
  }

  private async write(data: ScheduledTaskFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}
