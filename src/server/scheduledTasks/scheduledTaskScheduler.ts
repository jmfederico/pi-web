import type { FastifyBaseLogger } from "fastify";
import type { ScheduledTask, ScheduledTaskRun, ScheduledTaskRunTrigger } from "../../shared/apiTypes.js";
import type { ScheduledTaskRunStore } from "../storage/scheduledTaskRunStore.js";
import type { ScheduledTaskStore } from "../storage/scheduledTaskStore.js";
import type { PushService } from "../push/pushService.js";
import { nextCronFireAt } from "./scheduledTaskCron.js";
import type { ScheduledTaskService } from "./scheduledTaskService.js";

/**
 * The slice of {@link PiSessionService} the scheduler needs. Kept narrow and
 * structural (rather than importing the concrete class) so tests can supply a
 * fake without constructing a whole session daemon.
 */
export interface ScheduledTaskSessionRunner {
  start(cwd: string): Promise<{ id: string }>;
  prompt(ref: string, text: string): Promise<void>;
  status(ref: string): Promise<{ isStreaming: boolean; isCompacting: boolean; isBashRunning: boolean; pendingMessageCount: number }>;
}

export interface ScheduledTaskSchedulerDeps {
  store: ScheduledTaskStore;
  runs: ScheduledTaskRunStore;
  service: ScheduledTaskService;
  sessions: ScheduledTaskSessionRunner;
  pushNotifier?: Pick<PushService, "isEnabled" | "send">;
  logger?: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  /** Overridable for tests. */
  now?: () => Date;
  /** Overridable for tests, so completion-watching doesn't need real wall-clock delays. */
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxWatchMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_MAX_WATCH_MS = 2 * 60 * 60 * 1000;
/** Minimum time to keep polling before accepting "idle" as "finished" — guards against the rare race where the very first poll lands before the agent loop has flagged itself busy. */
const SETTLE_GRACE_MS = 5_000;

/**
 * Owns one timer per enabled scheduled task, firing a saved prompt into a new
 * (or resumed) session at the task's next cron occurrence. Lives inside
 * sessiond — see the "Scheduled Tasks" implementation plan for why: it's the
 * one process with in-process access to session start/prompt, and the one
 * kept running continuously independent of web/client restarts.
 */
export class ScheduledTaskScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private readonly deps: ScheduledTaskSchedulerDeps) {}

  /** Loads every task from storage and arms its timer. Call once at startup. */
  async start(): Promise<void> {
    for (const task of await this.deps.store.list()) this.reschedule(task);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Re-arms (or clears) a task's timer — call after any create/update/delete. */
  reschedule(task: ScheduledTask): void {
    this.unschedule(task.id);
    if (this.disposed || !task.enabled) return;
    const next = nextCronFireAt(task.schedule.cron, task.schedule.timezone, this.now());
    if (next === undefined) return;
    const delayMs = Math.max(0, next.getTime() - this.now().getTime());
    const timer = setTimeout(() => {
      void this.fire(task.id);
    }, delayMs);
    this.timers.set(task.id, timer);
  }

  unschedule(taskId: string): void {
    const existing = this.timers.get(taskId);
    if (existing !== undefined) clearTimeout(existing);
    this.timers.delete(taskId);
  }

  /** Runs a task immediately, outside its schedule — the UI's "Run now" action. */
  async runNow(taskId: string): Promise<ScheduledTaskRun> {
    const task = await this.deps.store.get(taskId);
    if (task === undefined) throw new Error("Scheduled task not found");
    return this.execute(task, "manual");
  }

  private async fire(taskId: string): Promise<void> {
    const task = await this.deps.store.get(taskId);
    if (task?.enabled !== true) return;
    await this.execute(task, "schedule");
    const fresh = await this.deps.store.get(taskId);
    if (fresh !== undefined) this.reschedule(fresh);
  }

  private async execute(task: ScheduledTask, triggeredBy: ScheduledTaskRunTrigger): Promise<ScheduledTaskRun> {
    const previous = await this.deps.runs.latestForTask(task.id);
    if (previous?.status === "running") {
      const run = await this.deps.runs.start({ taskId: task.id, triggeredBy, startedAt: this.now().toISOString() });
      return this.deps.runs.patch(run.id, { status: "skipped", finishedAt: this.now().toISOString(), note: "Skipped — previous run still in progress" });
    }

    let cwd: string;
    try {
      cwd = (await this.deps.service.resolveTarget(task.projectId, task.workspaceId)).cwd;
    } catch (error) {
      const run = await this.deps.runs.start({ taskId: task.id, triggeredBy, startedAt: this.now().toISOString() });
      await this.deps.store.update(task.id, { enabled: false });
      this.unschedule(task.id);
      this.deps.logger?.warn({ taskId: task.id, error: errorMessage(error) }, "scheduled task target missing — task disabled");
      return this.deps.runs.patch(run.id, {
        status: "failure",
        finishedAt: this.now().toISOString(),
        note: `Project or workspace no longer exists — task disabled (${errorMessage(error)})`,
      });
    }

    const run = await this.deps.runs.start({ taskId: task.id, triggeredBy, startedAt: this.now().toISOString(), cwd });
    try {
      // MVP only implements "new session" mode (see the implementation plan's
      // rollout phases); `task.sessionMode` is otherwise unused until
      // "continue-latest" ships.
      const created = await this.deps.sessions.start(cwd);
      await this.deps.sessions.prompt(created.id, task.prompt);
      const started = await this.deps.runs.patch(run.id, { sessionId: created.id });
      void this.watchCompletion(started, task);
      return started;
    } catch (error) {
      this.deps.logger?.error({ taskId: task.id, runId: run.id, error: errorMessage(error) }, "scheduled task run failed to start");
      return this.deps.runs.patch(run.id, { status: "failure", finishedAt: this.now().toISOString(), note: errorMessage(error) });
    }
  }

  private async watchCompletion(run: ScheduledTaskRun, task: ScheduledTask): Promise<void> {
    const sessionId = run.sessionId;
    if (sessionId === undefined) return;
    const pollIntervalMs = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxWatchMs = this.deps.maxWatchMs ?? DEFAULT_MAX_WATCH_MS;
    const sleep = this.deps.sleep ?? defaultSleep;
    const startedAt = this.now().getTime();
    let observedBusy = false;

    for (;;) {
      if (this.disposed) return;
      await sleep(pollIntervalMs);
      const elapsed = this.now().getTime() - startedAt;
      let status: Awaited<ReturnType<ScheduledTaskSessionRunner["status"]>>;
      try {
        status = await this.deps.sessions.status(sessionId);
      } catch {
        // Session vanished mid-run (archived/deleted) — nothing left to watch; treat as settled.
        await this.deps.runs.patch(run.id, { status: "success", finishedAt: this.now().toISOString() });
        return;
      }
      const busy = status.isStreaming || status.isCompacting || status.isBashRunning || status.pendingMessageCount > 0;
      if (busy) observedBusy = true;
      if (!busy && (observedBusy || elapsed > SETTLE_GRACE_MS)) {
        const finished = await this.deps.runs.patch(run.id, { status: "success", finishedAt: this.now().toISOString() });
        this.notifyIfEnabled(task, finished);
        return;
      }
      if (elapsed > maxWatchMs) {
        await this.deps.runs.patch(run.id, { status: "failure", finishedAt: this.now().toISOString(), note: "Timed out waiting for the run to finish" });
        return;
      }
    }
  }

  private notifyIfEnabled(task: ScheduledTask, run: ScheduledTaskRun): void {
    if (!task.notifyOnComplete || this.deps.pushNotifier?.isEnabled() !== true || run.sessionId === undefined) return;
    void this.deps.pushNotifier.send({
      title: `"${task.name}" finished`,
      body: run.status === "success" ? "Scheduled run finished." : "Scheduled run finished with an error.",
      tag: `scheduled-task:${task.id}`,
      url: "/",
      sessionId: run.sessionId,
      machineId: "local",
      ...(run.cwd === undefined ? {} : { cwd: run.cwd }),
    });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
