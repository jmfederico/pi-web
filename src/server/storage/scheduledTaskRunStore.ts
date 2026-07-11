import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { piWebDataDir } from "../../config.js";
import type { ScheduledTaskRun, ScheduledTaskRunStatus, ScheduledTaskRunTrigger } from "../../shared/apiTypes.js";

interface ScheduledTaskRunFile {
  runs: ScheduledTaskRun[];
}

/** Oldest runs beyond this count (per task) are trimmed on write — run history is operational signal, not an audit log. */
export const MAX_RUNS_PER_TASK = 50;

export interface ScheduledTaskRunInput {
  taskId: string;
  triggeredBy: ScheduledTaskRunTrigger;
  startedAt: string;
  cwd?: string;
}

export interface ScheduledTaskRunPatch {
  status?: ScheduledTaskRunStatus;
  finishedAt?: string;
  sessionId?: string;
  note?: string;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseStatus(value: unknown): ScheduledTaskRunStatus {
  if (value !== "running" && value !== "success" && value !== "failure" && value !== "skipped") {
    throw new Error("Invalid scheduled task run status");
  }
  return value;
}

function parseTrigger(value: unknown): ScheduledTaskRunTrigger {
  if (value !== "schedule" && value !== "manual") throw new Error("Invalid scheduled task run trigger");
  return value;
}

function parseRun(value: unknown): ScheduledTaskRun {
  if (!isRecord(value)) throw new Error("Invalid scheduled task run");
  const id = value["id"];
  const taskId = value["taskId"];
  const startedAt = value["startedAt"];
  if (typeof id !== "string" || typeof taskId !== "string" || typeof startedAt !== "string") throw new Error("Invalid scheduled task run");
  const finishedAt = value["finishedAt"];
  const sessionId = value["sessionId"];
  const cwd = value["cwd"];
  const note = value["note"];
  return {
    id,
    taskId,
    startedAt,
    status: parseStatus(value["status"]),
    triggeredBy: parseTrigger(value["triggeredBy"]),
    ...(typeof finishedAt === "string" ? { finishedAt } : {}),
    ...(typeof sessionId === "string" ? { sessionId } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
    ...(typeof note === "string" ? { note } : {}),
  };
}

function parseScheduledTaskRunFile(value: unknown): ScheduledTaskRunFile {
  if (!isRecord(value) || !Array.isArray(value["runs"])) throw new Error("Invalid scheduled task runs file");
  return { runs: value["runs"].map(parseRun) };
}

export function defaultScheduledTaskRunStorePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebDataDir(env, cwd), "scheduled-task-runs.json");
}

export function scheduledTaskRunStorePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const configured = env["PI_WEB_SCHEDULED_TASK_RUNS_FILE"];
  if (configured === undefined || configured === "") return defaultScheduledTaskRunStorePath(env, cwd);
  return resolve(cwd, configured);
}

export class ScheduledTaskRunStore {
  constructor(private readonly filePath = scheduledTaskRunStorePath()) {}

  async listForTask(taskId: string): Promise<ScheduledTaskRun[]> {
    const runs = (await this.read()).runs.filter((run) => run.taskId === taskId);
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async latestForTask(taskId: string): Promise<ScheduledTaskRun | undefined> {
    return (await this.listForTask(taskId))[0];
  }

  async start(input: ScheduledTaskRunInput): Promise<ScheduledTaskRun> {
    const data = await this.read();
    const run: ScheduledTaskRun = {
      id: randomUUID(),
      taskId: input.taskId,
      triggeredBy: input.triggeredBy,
      startedAt: input.startedAt,
      status: "running",
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    };
    data.runs.push(run);
    await this.write(this.trimmed(data, input.taskId));
    return run;
  }

  async patch(id: string, patch: ScheduledTaskRunPatch): Promise<ScheduledTaskRun> {
    const data = await this.read();
    const index = data.runs.findIndex((run) => run.id === id);
    const existing = data.runs[index];
    if (existing === undefined) throw new Error("Scheduled task run not found");
    const merged: ScheduledTaskRun = {
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
      ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
    };
    data.runs[index] = merged;
    await this.write(data);
    return merged;
  }

  async removeForTask(taskId: string): Promise<void> {
    const data = await this.read();
    await this.write({ runs: data.runs.filter((run) => run.taskId !== taskId) });
  }

  private trimmed(data: ScheduledTaskRunFile, taskId: string): ScheduledTaskRunFile {
    const forTask = data.runs.filter((run) => run.taskId === taskId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (forTask.length <= MAX_RUNS_PER_TASK) return data;
    const keepIds = new Set(forTask.slice(0, MAX_RUNS_PER_TASK).map((run) => run.id));
    return { runs: data.runs.filter((run) => run.taskId !== taskId || keepIds.has(run.id)) };
  }

  private async read(): Promise<ScheduledTaskRunFile> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return parseScheduledTaskRunFile(value);
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) return { runs: [] };
      throw error;
    }
  }

  private async write(data: ScheduledTaskRunFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}
