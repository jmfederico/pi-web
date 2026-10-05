import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type { AppState } from "../appState";
import type { ChatLine } from "./shared";
import { taskProgressFromMessages } from "../taskProgress";
import { parseSubagentFleet } from "../subagentFleet";
import { ballastCurrentStatus } from "../ballastStatus";
import type { ActivityLoader } from "./LiveSessionActivity";
import "./LiveSessionActivity";
import "./ExtensionStatusStrip";
import "./SubagentFleetView";
import "./BallastStatusView";
import "./TaskProgressView";

@customElement("session-observability")
export class SessionObservability extends LitElement {
  @property() machineId = "local";
  @property() machineLabel = "Local machine";
  @property() sessionId = "";
  @property() cwd = "";
  @property({ attribute: false }) extensionUi: AppState["selectedExtensionUi"];
  @property({ attribute: false }) messages: readonly ChatLine[] = [];
  @property({ attribute: false }) loadActivity?: ActivityLoader;

  override render() {
    const source = this.extensionUi;
    const snapshot = source?.machineId === this.machineId && source.sessionId === this.sessionId && source.cwd === this.cwd
      ? source.snapshot : undefined;
    const statuses = snapshot?.statuses ?? {};
    const otherStatuses = Object.fromEntries(Object.entries(statuses).filter(([key]) => key !== "ballast" && key !== "goal"));
    const sessionKey = JSON.stringify([this.machineId, this.sessionId, this.cwd]);
    if (this.loadActivity !== undefined) return keyed(sessionKey, html`<live-session-activity
      .machineId=${this.machineId} .machineLabel=${this.machineLabel} .sessionId=${this.sessionId} .cwd=${this.cwd}
      .statuses=${otherStatuses} .pressureHint=${statuses["ballast"]} .loadActivity=${this.loadActivity}
    ></live-session-activity>`);
    const tasks = taskProgressFromMessages(this.messages);
    const taskSummary = tasks.state === "unavailable" ? "Unavailable · no observable task snapshot"
      : `${tasks.state === "stale" ? "Stale · " : ""}${String(tasks.progress.completed)} of ${String(tasks.progress.total)} complete · ${String(tasks.progress.inProgress.length)} active · ${String(tasks.progress.pending)} pending · ${String(tasks.progress.blocked)} blocked`;
    const fleet = parseSubagentFleet(snapshot?.widgets ?? {});
    const fleetSummary = fleet.status === "ready" ? `${String(fleet.snapshot.runs.length)} runs reported · snapshot, not live progress`
      : fleet.status === "unavailable" ? "Unavailable · no fleet snapshot" : "Unreadable fleet snapshot";
    const memory = ballastCurrentStatus(statuses["ballast"]);
    return keyed(sessionKey, html`
      <section class="activity" aria-label="Session activity" tabindex="0">
        <table>
          <caption>Session activity · ${this.machineLabel}<span>Read-only snapshots and loaded history · expand a row for details</span></caption>
          <tbody>
            <tr><th scope="row">Extensions</th><td>
              ${snapshot === undefined ? html`<p role="status">Extension snapshot unavailable: connecting, disconnected, or unsupported.</p>` : null}
              <extension-status-strip .statuses=${otherStatuses}></extension-status-strip>
            </td></tr>
            <tr data-activity="tasks"><th scope="row">Tasks</th><td><details>
              <summary>${taskSummary}</summary>
              <task-progress-view .messages=${this.messages} .goalStatus=${statuses["goal"]} .sessionKey=${sessionKey}></task-progress-view>
            </details></td></tr>
            <tr data-activity="fleet"><th scope="row">Fleet</th><td><details>
              <summary>${fleetSummary}</summary>
              <subagent-fleet-view .widgets=${snapshot?.widgets ?? {}} .sessionKey=${sessionKey}></subagent-fleet-view>
            </details></td></tr>
            <tr data-activity="memory"><th scope="row">Memory</th><td><details>
              <summary><span role=${memory?.level === "warn" || memory?.level === "critical" ? "alert" : "status"}>${memory === undefined ? "Unknown · no current pressure alert" : `${memory.text} · status hint, not a live sample`}</span></summary>
              <ballast-status-view .statusText=${statuses["ballast"]} .messages=${this.messages} .machineLabel=${this.machineLabel}></ballast-status-view>
            </details></td></tr>
          </tbody>
        </table>
      </section>
    `);
  }

  static override styles = css`
    :host { display: block; flex: 0 0 auto; min-width: 0; color: var(--pi-text); }
    .activity { max-height: min(35vh, 22rem); overflow: auto; border-bottom: 1px solid var(--pi-border); }
    table { width: 100%; table-layout: fixed; border-collapse: collapse; font: 13px/1.45 var(--pi-ui-font, system-ui, sans-serif); font-variant-numeric: tabular-nums; }
    caption { position: sticky; top: 0; z-index: 1; padding: 5px 10px; background: var(--pi-bg); text-align: left; font-weight: 600; }
    caption span { display: block; color: var(--pi-muted); font-weight: 400; font-size: 11px; }
    tr { background: var(--pi-bg); }
    tr:nth-child(even) { background: var(--pi-surface); }
    th, td { padding: 4px 10px; border-top: 1px solid var(--pi-border-muted); vertical-align: top; overflow-wrap: anywhere; }
    th { width: 5rem; text-align: left; color: var(--pi-muted); font-weight: 500; }
    summary { cursor: pointer; }
    summary:focus-visible, .activity:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    [role="alert"] { color: var(--pi-warning); }
    details[open] > summary { margin-bottom: 8px; }
    p { margin: 0; color: var(--pi-muted); }
  `;
}
