import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  taskProgressFromMessages,
  type TaskDependency,
  type TaskProgressIssue,
  type TaskProgressObservation,
  type TaskProgressTask,
} from "../taskProgress";
import type { ChatLine } from "./shared";

@customElement("task-progress-view")
export class TaskProgressView extends LitElement {
  @property({ attribute: false }) messages: readonly ChatLine[] = [];
  @property({ attribute: false }) goalStatus?: string;
  @property({ attribute: false }) sessionKey?: string;
  @state() private taskListExpanded = false;

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("sessionKey")) this.taskListExpanded = false;
  }

  override render() {
    const observation = taskProgressFromMessages(this.messages);
    const goalStatus = this.goalStatus?.trim();
    return html`
      <section aria-labelledby="task-progress-heading">
        <h2 id="task-progress-heading">Task progress</h2>
        ${goalStatus !== undefined && goalStatus !== "" ? html`<p class="goal-status">Goal status: ${boundedStatus(goalStatus)}</p>` : null}
        ${observation.state === "unavailable"
          ? this.renderUnavailable(observation.reason)
          : this.renderProgress(observation)}
      </section>
    `;
  }

  private renderUnavailable(reason: TaskProgressIssue) {
    const detail = reason === "no_snapshot" ? "" : ` ${issueLabel(reason)}`;
    return html`<p class="status" role="status" data-state="unavailable">Task progress unavailable.${detail}</p>`;
  }

  private renderProgress(observation: Extract<TaskProgressObservation, { state: "current" | "stale" }>) {
    const progress = observation.progress;
    const summary = progress.total === 0
      ? "No tasks in the latest snapshot (0 of 0 tasks complete)."
      : `${String(progress.completed)} of ${String(progress.total)} tasks complete; ${String(progress.pending)} pending; ${String(progress.blocked)} blocked.`;
    const status = observation.state === "stale"
      ? `Task progress stale. ${issueLabel(observation.reason)} Last known snapshot: ${summary}`
      : summary;
    return html`
      <p class="status" role="status" data-state=${observation.state}>${status}</p>
      ${progress.inProgress.length === 0 ? null : html`
        <ul class="active-tasks" aria-label="In progress tasks">
          ${progress.inProgress.map((task) => html`
            <li>In progress: #${String(task.id)} ${task.subject}${task.activeForm !== undefined && task.activeForm !== "" ? html` — ${task.activeForm}` : null}</li>
          `)}
        </ul>
      `}
      <details ?open=${this.taskListExpanded} @toggle=${(event: Event) => { this.handleTaskListToggle(event); }}>
        <summary>Task list (${String(progress.total)})</summary>
        ${this.taskListExpanded ? html`
          <ul class="task-list">
            ${progress.tasks.map((task) => this.renderTask(task))}
          </ul>
        ` : null}
      </details>
    `;
  }

  private renderTask(task: TaskProgressTask) {
    return html`
      <li class=${`task ${task.status}`}>
        <span class="task-label"><span class="task-id">#${String(task.id)}</span> ${task.subject}</span>
        <span class="task-status">${statusLabel(task.status)}</span>
        ${task.activeForm !== undefined && task.activeForm !== "" && task.status !== "in_progress" ? html`<span class="active-form">${task.activeForm}</span>` : null}
        ${task.dependencies.length === 0 ? null : html`
          <ul class="dependencies" aria-label=${`Dependencies for task ${String(task.id)}`}>
            ${task.dependencies.map((dependency) => this.renderDependency(dependency))}
          </ul>
        `}
      </li>
    `;
  }

  private renderDependency(dependency: TaskDependency) {
    if (dependency.blocksProgress) {
      const label = dependency.subject === undefined || dependency.subject === "" ? "" : `: ${dependency.subject}`;
      const status = dependency.status === undefined ? "unavailable" : statusLabel(dependency.status);
      return html`<li>Blocked by #${String(dependency.id)}${label} (${status})</li>`;
    }
    if (dependency.status === undefined) return html`<li>Depends on #${String(dependency.id)} (unavailable)</li>`;
    const label = dependency.subject === undefined || dependency.subject === "" ? "" : `: ${dependency.subject}`;
    return html`<li>Depends on #${String(dependency.id)}${label} (${statusLabel(dependency.status)})</li>`;
  }

  private handleTaskListToggle(event: Event) {
    if (event.currentTarget instanceof HTMLDetailsElement) this.taskListExpanded = event.currentTarget.open;
  }

  static override styles = css`
    :host { display: block; min-width: 0; color: var(--pi-text); font: 13px var(--pi-ui-font, system-ui, sans-serif); }
    section { display: grid; gap: 6px; padding: 10px; border: 1px solid var(--pi-border); border-radius: 0; background: var(--pi-surface); }
    h2 { margin: 0; color: var(--pi-text); font-size: 14px; }
    p { margin: 0; line-height: 1.4; }
    .goal-status { color: var(--pi-muted); }
    .status { color: var(--pi-text); }
    .status[data-state="stale"], .status[data-state="unavailable"] { color: var(--pi-warning); }
    .active-tasks, .task-list { display: grid; gap: 6px; margin: 0; padding-left: 18px; }
    .active-tasks { color: var(--pi-accent); }
    details { border-top: 1px solid var(--pi-border-muted); padding-top: 6px; }
    summary { color: var(--pi-muted); cursor: pointer; }
    summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .task { display: grid; gap: 3px; min-width: 0; overflow-wrap: anywhere; }
    .task-label { color: var(--pi-text); }
    .task-id, .task-status { color: var(--pi-muted); }
    .completed .task-status { color: var(--pi-success); }
    .in_progress .task-status { color: var(--pi-accent); }
    .pending .task-status { color: var(--pi-warning); }
    .active-form { color: var(--pi-muted); }
    .dependencies { display: grid; gap: 3px; margin: 0; padding-left: 18px; color: var(--pi-muted); }
  `;
}

function statusLabel(status: "pending" | "in_progress" | "completed"): string {
  if (status === "in_progress") return "in progress";
  return status;
}

function boundedStatus(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 499)}…`;
}

function issueLabel(reason: TaskProgressIssue): string {
  if (reason === "todo_result_missing_snapshot") return "The latest todo result had no task snapshot.";
  if (reason === "todo_result_invalid_snapshot") return "The latest todo snapshot is malformed or exceeds display limits.";
  if (reason === "codemode_todo_unobservable") return "A codemode todo call is recorded, but nested task state is not persisted.";
  if (reason === "codemode_metadata_unavailable") return "Codemode task-call metadata is malformed or exceeds display limits.";
  return "No task snapshot is present in the loaded history.";
}
