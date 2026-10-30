import type { Execution, TaskInput } from "./domain.js";
import type { TaskStore } from "./store.js";

export type DispatchSettings = Pick<TaskInput, "model" | "thinkingLevel">;
export interface DispatchedSession extends DispatchSettings { sessionId: string }

export interface TaskDispatcher {
  /** Return only after the host confirms conversation publication and initial prompt admission. */
  dispatch(execution: Execution, settings: DispatchSettings): Promise<DispatchedSession>;
}

/** Use only for a failure known to occur before initial prompt admission. */
export class DispatchRejected extends Error {}

/** Package orchestration only: the activation owns the timer, store and stop/drain lifecycle. */
export class TaskScheduler {
  private stopped = false;
  private readonly pending = new Map<Promise<Execution>, string>();

  constructor(
    private readonly store: TaskStore,
    private readonly dispatcher: TaskDispatcher,
    private readonly now: () => string,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Claim all due tasks without awaiting other conversations, initial turns, or outcome reports. */
  tick(): void {
    if (this.stopped) return;
    const now = this.now();
    for (const task of this.store.listTasks()) {
      if (task.archived || task.paused || task.nextDue === null || task.nextDue > now) continue;
      const execution = this.store.claim(task.id, "scheduled", now);
      if (execution !== null) void this.launch(execution).catch(this.onError);
    }
  }

  async dispatchManually(taskId: string): Promise<Execution> {
    if (this.stopped) throw new Error("Scheduled tasks is stopping; no future dispatches are accepted");
    const execution = this.store.claim(taskId, "manual", this.now());
    if (execution === null) throw new Error("Could not reserve manual dispatch");
    return this.launch(execution);
  }

  deleteTask(taskId: string, revision: number): { taskId: string; deleted: true } {
    if ([...this.pending.values()].includes(taskId)) {
      throw new Error("Task dispatch is in progress; wait for dispatch to settle before deleting");
    }
    this.store.delete(taskId, revision);
    return { taskId, deleted: true };
  }

  /** Does not cancel or otherwise control conversations already published. Drain before closing SQLite. */
  stop(): void { this.stopped = true; }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending.keys()]); }

  private launch(execution: Execution): Promise<Execution> {
    const pending = this.dispatch(execution);
    this.pending.set(pending, execution.taskId);
    // Register both branches so cleanup does not create an unhandled rejected promise.
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending;
  }

  private async dispatch(execution: Execution): Promise<Execution> {
    const settings: DispatchSettings = {
      ...(execution.task.model === undefined ? {} : { model: execution.task.model }),
      ...(execution.task.thinkingLevel === undefined ? {} : { thinkingLevel: execution.task.thinkingLevel }),
    };
    let session: DispatchedSession;
    for (;;) {
      try {
        session = await this.dispatcher.dispatch(execution, { ...settings });
        break;
      } catch (error) {
        // Only these host codes guarantee that no initial prompt was submitted.
        // Each override can be removed once; all other admission failures remain ambiguous.
        const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
        if (code === "PI_SESSION_MODEL_UNAVAILABLE" && settings.model !== undefined) {
          this.store.recordNotices(execution.id, [`Requested model ${JSON.stringify(settings.model)} was unavailable; using the session default model.`]);
          delete settings.model;
          continue;
        }
        if (code === "PI_SESSION_THINKING_UNAVAILABLE" && settings.thinkingLevel !== undefined) {
          this.store.recordNotices(execution.id, [`Requested thinking level ${JSON.stringify(settings.thinkingLevel)} was unavailable; using the session default thinking level.`]);
          delete settings.thinkingLevel;
          continue;
        }
        const certainFailure = error instanceof DispatchRejected || code === "PI_SESSION_MODEL_UNAVAILABLE" || code === "PI_SESSION_THINKING_UNAVAILABLE";
        return this.store.dispatchProblem(execution.id, error instanceof Error ? error.message : String(error), certainFailure);
      }
    }
    // A failed confirmation write must surface as a storage error, not be mislabeled a rejected launch.
    return this.store.confirmDispatch(execution.id, session.sessionId, session);
  }
}
