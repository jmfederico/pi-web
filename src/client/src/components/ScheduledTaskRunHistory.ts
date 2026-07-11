import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { ScheduledTaskRun } from "../api";

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatDuration(run: ScheduledTaskRun): string {
  if (run.finishedAt === undefined) return run.status === "running" ? "running…" : "—";
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${String(minutes)}m ${String(seconds)}s` : `${String(seconds)}s`;
}

/** Run history for one scheduled task — a narrower modal over `ProjectDialog`'s shape, opened from the task's overflow menu. */
@customElement("scheduled-task-run-history")
export class ScheduledTaskRunHistory extends LitElement {
  @property() taskName = "";
  @property({ attribute: false }) runs: ScheduledTaskRun[] = [];
  @property({ attribute: false }) onOpenSession?: (sessionId: string) => void;
  @property({ attribute: false }) onCancel?: () => void;

  override render() {
    return html`
      <div class="backdrop" @click=${(event: MouseEvent) => { if (event.target === event.currentTarget) this.onCancel?.(); }}>
        <section @click=${(event: Event) => { event.stopPropagation(); }}>
          <header>
            <strong>Run history — ${this.taskName}</strong>
            <button @click=${() => { this.onCancel?.(); }} aria-label="Close">×</button>
          </header>
          <div class="runs">
            ${this.runs.length === 0 ? html`<div class="empty">No runs yet.</div>` : this.runs.map((run) => this.renderRun(run))}
          </div>
        </section>
      </div>
    `;
  }

  private renderRun(run: ScheduledTaskRun) {
    const sessionId = run.sessionId;
    return html`
      <div class="run">
        <span class="status ${run.status}"></span>
        <div class="main">
          <div class="when">${formatWhen(run.startedAt)}</div>
          ${run.note !== undefined ? html`<div class="note">${run.status === "skipped" ? "Skipped" : "Failed"} — ${run.note}</div>` : null}
          <div class="trigger">${run.triggeredBy}</div>
        </div>
        <div class="side">
          <span class="duration">${formatDuration(run)}</span>
          ${sessionId !== undefined ? html`<button class="open-link" @click=${() => { this.onOpenSession?.(sessionId); }}>Open session →</button>` : null}
        </div>
      </div>
    `;
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 31; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    .backdrop { display: grid; place-items: start center; width: 100%; height: 100%; padding-top: min(6vh, 56px); box-sizing: border-box; background: var(--pi-overlay); }
    section { width: min(560px, calc(100vw - 40px)); max-height: min(600px, calc(100vh - 40px)); display: flex; flex-direction: column; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-bg); box-shadow: 0 20px 60px var(--pi-shadow-strong); overflow: hidden; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--pi-border); }
    header button { border: 0; background: transparent; color: var(--pi-muted); font-size: 22px; padding: 0 8px; cursor: pointer; }
    .runs { display: grid; gap: 8px; padding: 14px; overflow: auto; min-height: 0; }
    .empty { padding: 20px; text-align: center; color: var(--pi-muted); }
    .run { display: grid; grid-template-columns: 14px minmax(0,1fr) auto; align-items: start; gap: 10px; border: 1px solid var(--pi-border); border-radius: 8px; padding: 9px 11px; }
    .status { margin-top: 4px; width: 8px; height: 8px; border-radius: 50%; }
    .status.success { background: var(--pi-success); }
    .status.failure { background: var(--pi-danger); }
    .status.skipped { background: var(--pi-dim); }
    .status.running { background: var(--pi-accent); }
    .main { min-width: 0; }
    .when { font-variant-numeric: tabular-nums; }
    .note { color: var(--pi-muted); font-size: 12.5px; margin-top: 2px; }
    .trigger { color: var(--pi-dim); font-size: 10.5px; text-transform: uppercase; letter-spacing: .03em; margin-top: 2px; }
    .side { text-align: right; font-size: 12.5px; color: var(--pi-muted); display: grid; gap: 3px; justify-items: end; }
    .duration { font-variant-numeric: tabular-nums; }
    .open-link { border: 0; background: transparent; color: var(--pi-accent); padding: 0; cursor: pointer; font-size: 12.5px; }
    .open-link:hover { text-decoration: underline; }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "scheduled-task-run-history": ScheduledTaskRunHistory;
  }
}
