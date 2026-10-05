import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ballastCurrentStatus, latestBallastToolEvidence } from "../ballastStatus";
import type { ChatLine } from "./shared";

const MAX_MACHINE_LABEL_LENGTH = 120;

@customElement("ballast-status-view")
export class BallastStatusView extends LitElement {
  @property({ attribute: false }) statusText: string | undefined;
  @property({ attribute: false }) messages: readonly ChatLine[] = [];
  @property({ attribute: false }) machineLabel = "";

  override render() {
    const currentStatus = ballastCurrentStatus(this.statusText);
    const evidence = latestBallastToolEvidence(this.messages);
    const machineLabel = displayMachineLabel(this.machineLabel);
    const currentLevel = currentStatus?.level;
    const liveAlert = currentLevel === "warn" || currentLevel === "critical";
    const currentClass = currentLevel === "critical" ? "critical" : currentLevel === "warn" ? "warning" : currentLevel === "watch" ? "watch" : "unclassified";

    return html`
      <section class="panel" aria-label=${`Ballast status for ${machineLabel}`}>
        <header>
          <div>
            <h2>Memory pressure</h2>
            <p class="machine">${machineLabel}</p>
          </div>
        </header>

        ${currentStatus === undefined ? html`
          <p class="unavailable" role="status">
            No current Ballast pressure alert is available. This does not confirm that memory is healthy.
          </p>
        ` : html`
          <section class=${`current-status ${currentClass}`} role=${liveAlert ? "alert" : "status"} aria-label="Current Ballast status hint">
            <p class="eyebrow">Current extension status hint · not a live sample</p>
            ${currentLevel === undefined ? null : html`<strong class="level">${currentLevel.toUpperCase()}</strong>`}
            <p class="status-text">${currentStatus.text}</p>
          </section>
        `}

        ${evidence === undefined ? html`
          <p class="unavailable">No Ballast tool evidence is available in the loaded history.</p>
        ` : html`
          <section class="evidence" aria-label="Last-reported Ballast tool evidence">
            <p class="eyebrow">Last-reported evidence · ${evidence.toolName}</p>
            <p class="historical">Historical tool output; it is not a current memory reading.</p>
            ${evidence.isError ? html`<p class="result-error">The Ballast tool reported an error.</p>` : null}
            ${evidence.fields.length === 0 ? null : html`
              <dl>
                ${evidence.fields.map((field) => html`<div><dt>${field.label}</dt><dd>${field.value}</dd></div>`)}
              </dl>
            `}
            ${evidence.text === "" ? null : html`<pre>${evidence.text}</pre>`}
          </section>
        `}

        <p class="limitation">Full headroom, PSI, and guard metrics need a supported exporter and are not available here.</p>
      </section>
    `;
  }

  static override styles = css`
    :host { display: block; min-width: 0; color: var(--pi-text); font: 13px var(--pi-ui-font, system-ui, sans-serif); }
    .panel { display: grid; gap: 12px; min-width: 0; padding: 12px; }
    header { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
    h2 { margin: 0; color: var(--pi-text); font-size: 15px; }
    p { margin: 0; line-height: 1.45; }
    .machine, .eyebrow, .historical, .limitation { color: var(--pi-muted); }
    .machine { margin-top: 3px; }
    .unavailable { border: 1px dashed var(--pi-border-muted); border-radius: 0; padding: 10px; color: var(--pi-muted); }
    .current-status, .evidence { min-width: 0; border: 1px solid var(--pi-border); border-radius: 0; background: var(--pi-surface); padding: 10px; }
    .current-status { display: grid; gap: 5px; }
    .current-status.watch { border-color: var(--pi-warning-border); }
    .current-status.warning { border-color: var(--pi-warning-border); background: var(--pi-warning-surface); color: var(--pi-warning); }
    .current-status.critical { border-color: var(--pi-danger); background: color-mix(in srgb, var(--pi-danger) 10%, var(--pi-bg)); color: var(--pi-danger); }
    .current-status.unclassified { color: var(--pi-text); }
    .current-status .eyebrow { color: var(--pi-muted); }
    .level { justify-self: start; border: 1px solid currentColor; border-radius: 0; padding: 1px 7px; font-size: 11px; letter-spacing: .04em; }
    .status-text { white-space: pre-wrap; overflow-wrap: anywhere; }
    .evidence { display: grid; gap: 7px; }
    .historical { font-size: 12px; }
    .result-error { color: var(--pi-danger); }
    dl { display: grid; gap: 5px; margin: 0; }
    dl > div { display: grid; grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr); gap: 8px; }
    dt { color: var(--pi-muted); }
    dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
    pre { box-sizing: border-box; max-height: 240px; min-width: 0; max-width: 100%; margin: 0; overflow: auto; border: 1px solid var(--pi-border-muted); border-radius: 0; background: var(--pi-bg); padding: 8px; color: var(--pi-text); white-space: pre-wrap; overflow-wrap: anywhere; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .limitation { font-size: 12px; }
  `;
}

function displayMachineLabel(value: string): string {
  const label = value.trim();
  if (label === "") return "Unknown machine";
  return label.length <= MAX_MACHINE_LABEL_LENGTH ? label : `${label.slice(0, MAX_MACHINE_LABEL_LENGTH)}…`;
}
