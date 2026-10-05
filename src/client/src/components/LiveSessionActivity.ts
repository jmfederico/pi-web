import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionRef } from "../../../shared/apiTypes";
import type { ActivityRead, ActivityTask, SessionActivitySnapshot, SystemMemory } from "../../../shared/sessionActivity";
import { ballastCurrentStatus } from "../ballastStatus";
import "./ExtensionStatusStrip";

export type ActivityLoader = (session: SessionRef, machineId: string, options: { signal: AbortSignal }) => Promise<SessionActivitySnapshot>;

@customElement("live-session-activity")
export class LiveSessionActivity extends LitElement {
  @property() machineId = "local";
  @property() machineLabel = "Local machine";
  @property() sessionId = "";
  @property() cwd = "";
  @property({ attribute: false }) statuses: Record<string, string> = {};
  @property({ attribute: false }) pressureHint?: string;
  @property({ attribute: false }) loadActivity?: ActivityLoader;
  @state() private snapshot: SessionActivitySnapshot | undefined;
  @state() private notice = "Loading live activity…";
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private requestTimer?: ReturnType<typeof setTimeout>;
  private request: AbortController | undefined;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.restart);
    this.requestUpdate("loadActivity", undefined);
  }

  override disconnectedCallback() {
    this.stopSampling();
    document.removeEventListener("visibilitychange", this.restart);
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("machineId") || changed.has("sessionId") || changed.has("cwd") || changed.has("loadActivity")) this.restart();
  }

  private stopSampling() {
    this.generation += 1;
    clearTimeout(this.timer);
    clearTimeout(this.requestTimer);
    this.request?.abort();
    this.request = undefined;
  }

  private readonly restart = () => {
    this.stopSampling();
    this.snapshot = undefined;
    this.notice = "Loading live activity…";
    if (this.isConnected && document.visibilityState !== "hidden" && this.loadActivity !== undefined && this.sessionId !== "") {
      void this.sample(this.generation);
    }
  };

  private async sample(generation: number): Promise<void> {
    const load = this.loadActivity;
    if (load === undefined) return;
    const request = new AbortController();
    this.request = request;
    const timeout = setTimeout(() => { request.abort(); }, 5_000);
    this.requestTimer = timeout;
    const session = { id: this.sessionId, cwd: this.cwd };
    const machineId = this.machineId;
    try {
      const snapshot = await load(session, machineId, { signal: request.signal });
      if (generation !== this.generation || !this.isConnected || this.machineId !== machineId || this.sessionId !== session.id || this.cwd !== session.cwd || this.loadActivity !== load) return;
      request.signal.throwIfAborted();
      if (snapshot.sessionId !== session.id || snapshot.cwd !== session.cwd) throw new Error("Activity belongs to another session");
      this.snapshot = snapshot;
    } catch {
      if (generation === this.generation) {
        this.snapshot = undefined;
        this.notice = "Live activity unavailable. Retrying…";
      }
    } finally {
      clearTimeout(timeout);
      if (generation === this.generation && this.isConnected) {
        this.request = undefined;
        this.timer = setTimeout(() => { void this.sample(generation); }, 5_000);
      }
    }
  }

  override render() {
    const data = this.snapshot;
    return html`<section class="activity" aria-label="Session activity" tabindex="0"><table>
      <caption>Session activity · ${this.machineLabel}<small>Selected session · RAM is machine-wide${data === undefined ? "" : ` · sampled ${new Date(data.sampledAt).toLocaleTimeString()}`}</small></caption>
      <tbody>
        <tr><th scope="row">Extensions</th><td><extension-status-strip .statuses=${this.statuses}></extension-status-strip></td></tr>
        ${data === undefined ? html`<tr><td colspan="2" role="status">${this.notice}</td></tr>` : this.renderSnapshot(data)}
      </tbody>
    </table></section>`;
  }

  private renderSnapshot(data: SessionActivitySnapshot) {
    const goal = data.goal.state === "ready" ? data.goal.value : undefined;
    const pressure = ballastCurrentStatus(this.pressureHint);
    return html`
      <tr><th scope="row">Goal</th><td>${data.goal.state === "unavailable" ? data.goal.reason : goal === null ? "No focused goal" : html`<strong>${goal?.status}</strong> · ${goal?.objective}`}</td></tr>
      <tr><th scope="row">Tasks</th><td><details><summary>
        Goal: ${goal === undefined ? "unavailable" : goal === null ? "none focused" : taskSummary(goal.tasks)} ·
        Todos: ${data.todos.state === "ready" ? taskSummary(data.todos.value) : "unavailable"}
      </summary>
        ${goal === undefined || goal === null ? null : html`<h3>Goal tasks</h3>${this.renderTasks(goal.tasks)}`}
        <h3>Session todos</h3>${data.todos.state === "ready" ? this.renderTasks(data.todos.value) : data.todos.reason}
      </details></td></tr>
      <tr><th scope="row">Fleet</th><td><details><summary>
        Extension agents: ${data.fleet.state === "ready" ? `${String(data.fleet.value.totalActive)} active` : "unavailable"} ·
        Pi Web children: ${data.children.state === "ready" ? `${String(data.children.value.filter((child) => child.status === "working").length)} working / ${String(data.children.value.length)} tracked` : "unavailable"}
      </summary>
        <h3>Extension agents</h3>
        ${data.fleet.state === "unavailable" ? data.fleet.reason : html`
          ${data.fleet.value.omitted === 0 ? null : html`<p>${String(data.fleet.value.omitted)} additional active entries omitted by the provider.</p>`}
          <ul>${data.fleet.value.entries.map((entry) => html`<li><strong>${entry.agent}</strong> ${entry.model}${entry.goal === "" ? null : html` — ${entry.goal}`}</li>`)}</ul>`}
        <h3>Pi Web child sessions</h3>
        ${data.children.state === "unavailable" ? data.children.reason : html`<ul>${data.children.value.map((child) => html`<li>${child.sessionId} · ${child.status} · ${child.cwd}</li>`)}</ul>`}
      </details></td></tr>
      <tr><th scope="row">Memory</th><td>${this.renderMemory(data.memory)}${pressure === undefined ? null : html`<p class=${`pressure ${pressure.level ?? "unclassified"}`} role=${pressure.level === "warn" || pressure.level === "critical" ? "alert" : "status"}>Ballast hint: ${pressure.text}</p>`}</td></tr>
    `;
  }

  private renderTasks(tasks: readonly ActivityTask[]) {
    if (tasks.length === 0) return html`<p>No tasks.</p>`;
    return html`<ul>${tasks.map((task) => html`<li>${"↳ ".repeat(task.depth)}#${task.id} ${task.title} · <strong>${task.status.replaceAll("_", " ")}</strong></li>`)}</ul>`;
  }

  private renderMemory(source: ActivityRead<SystemMemory>) {
    if (source.state === "unavailable") return html`<span role="status">${source.reason}</span>`;
    const memory = source.value;
    const used = memory.totalBytes - memory.availableBytes;
    const ratio = used / memory.totalBytes;
    const label = `${gib(used)} / ${gib(memory.totalBytes)} GiB used (${(ratio * 100).toFixed(1)}%) · ${gib(memory.availableBytes)} GiB ${memory.availability}`;
    return html`<div class=${`memory ${ratio >= .9 ? "high" : ratio >= .7 ? "medium" : "low"}`}>
      <meter min="0" max=${memory.totalBytes} value=${used} low=${memory.totalBytes * .7} high=${memory.totalBytes * .9} optimum="0" aria-label="System RAM used" aria-valuetext=${label}>${label}</meter>
      <span>${label}</span><small>Not a pressure measurement. Green &lt;70%, amber 70–90%, red ≥90%.</small>
    </div>`;
  }

  static override styles = css`
    :host { display: block; min-width: 0; color: var(--pi-text); }
    .activity { max-height: min(35vh, 22rem); overflow: auto; border-bottom: 1px solid var(--pi-border); background: var(--pi-chrome-bg, var(--pi-surface)); }
    table { width: 100%; table-layout: fixed; border-collapse: collapse; font: 12px/1.45 var(--pi-ui-font, system-ui, sans-serif); font-variant-numeric: tabular-nums; }
    caption { position: sticky; top: 0; z-index: 1; padding: 6px 12px; background: var(--pi-chrome-bg, var(--pi-surface)); text-align: left; font-weight: 600; }
    caption small { display: inline; margin-inline-start: 10px; }
    small { display: block; color: var(--pi-muted); font-weight: 400; font-size: 11px; }
    th, td { padding: 4px 12px; border-top: 1px solid var(--pi-border-muted); vertical-align: top; overflow-wrap: anywhere; }
    th { width: 4.5rem; text-align: left; color: var(--pi-muted); font-weight: 500; }
    summary { cursor: pointer; }
    summary:focus-visible, .activity:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    h3 { font-size: 12px; margin: 8px 0 4px; } p { margin: 4px 0; } ul { margin: 4px 0; padding-left: 18px; }
    .memory { --memory-color: var(--pi-success); display: grid; grid-template-columns: 72px minmax(0, 1fr); align-items: center; gap: 2px 8px; } .memory.medium { --memory-color: var(--pi-warning); } .memory.high { --memory-color: var(--pi-danger); }
    .memory small { grid-column: 1 / -1; }
    meter { display: block; width: 100%; height: 8px; margin: 0; }
    meter::-webkit-meter-bar { background: var(--pi-border-muted); border: 0; border-radius: 4px; }
    meter::-webkit-meter-optimum-value, meter::-webkit-meter-suboptimum-value, meter::-webkit-meter-even-less-good-value { background: var(--memory-color); }
    meter::-moz-meter-bar { background: var(--memory-color); }
    .pressure { color: var(--pi-warning); }
    .pressure.critical { color: var(--pi-danger); }
  `;
}

function taskSummary(tasks: readonly ActivityTask[]): string {
  if (tasks.length === 0) return "none";
  const completed = tasks.filter((task) => task.status === "completed").length;
  const active = tasks.filter((task) => task.status === "in_progress").length;
  const skipped = tasks.filter((task) => task.status === "skipped").length;
  return `${String(completed)} of ${String(tasks.length)} complete · ${String(active)} active${skipped === 0 ? "" : ` · ${String(skipped)} skipped`}`;
}

function gib(bytes: number): string { return (bytes / 1_073_741_824).toFixed(1); }
