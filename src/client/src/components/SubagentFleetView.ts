import { LitElement, css, html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { parseSubagentFleet, type FleetNode, type FleetNodeState, type FleetSnapshot } from "../subagentFleet";

@customElement("subagent-fleet-view")
export class SubagentFleetView extends LitElement {
  @property({ attribute: false }) widgets: Record<string, string[]> = {};
  @property({ type: String }) sessionKey?: string;

  private readonly collapsedNodes = new Set<string>();

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("sessionKey")) this.collapsedNodes.clear();
  }

  override render() {
    const result = parseSubagentFleet(this.widgets);
    if (result.status !== "ready") {
      return html`
        <section class="fleet" aria-labelledby="fleet-title">
          <h2 id="fleet-title">Subagent fleet</h2>
          <p class="notice" role="status">${result.status === "unavailable" ? "Fleet status unavailable" : "Fleet status could not be read"}</p>
          <p class="muted">${result.message}</p>
        </section>
      `;
    }
    return this.renderSnapshot(result.snapshot);
  }

  private renderSnapshot(snapshot: FleetSnapshot): TemplateResult {
    const omitted = snapshot.omitted;
    const hasOmissions = omitted.runs > 0 || omitted.children > 0 || omitted.byteLimitExceeded;
    return html`
      <section class="fleet" aria-labelledby="fleet-title">
        <h2 id="fleet-title">Subagent fleet</h2>
        <p class="snapshot-time">Snapshot observation: <time datetime=${new Date(snapshot.generatedAt).toISOString()}>${new Date(snapshot.generatedAt).toISOString()}</time></p>
        <p class="notice">Lifecycle states and elapsed values describe this snapshot only; they do not establish current connectivity or progress.</p>
        <p class="notice">Task, model, and token/cost usage are unavailable in this widget snapshot.</p>
        ${hasOmissions ? html`<p class="muted">Some runs or child rows were omitted by the snapshot limits.</p>` : null}
        ${snapshot.runs.length === 0
          ? html`<p class="muted">No async subagent runs are reported.</p>`
          : html`<ul class="nodes roots">${repeat(snapshot.runs, (node) => node.id, (node) => html`<li>${this.renderNode(node, node.id, snapshot.generatedAt)}</li>`)}</ul>`}
      </section>
    `;
  }

  private renderNode(node: FleetNode, key: string, generatedAt: number): TemplateResult {
    const summary = html`
      <span class="kind">${kindLabel(node.kind)}</span>
      <span class="node-label">${node.label}</span>
      <span class=${`state state-${node.state}`}>${stateLabel(node.state)}</span>
    `;
    const children = node.children.length === 0 ? null : html`
      <ul class="nodes children">${repeat(node.children, (child) => child.id, (child) => html`<li>${this.renderNode(child, `${key}/${child.id}`, generatedAt)}</li>`)}</ul>
    `;
    const content = html`
      ${summaryContent(node, generatedAt)}
      ${children}
    `;

    if (node.children.length === 0) {
      return html`<article class="node leaf"><div class="node-heading">${summary}</div>${content}</article>`;
    }

    return html`
      <details class="node" .open=${!this.collapsedNodes.has(key)} @toggle=${(event: Event) => { this.handleToggle(key, event); }}>
        <summary>${summary}</summary>
        <div class="node-content">${content}</div>
      </details>
    `;
  }

  private handleToggle(key: string, event: Event): void {
    if (!(event.currentTarget instanceof HTMLDetailsElement)) return;
    const isOpen = event.currentTarget.open;
    if (isOpen) this.collapsedNodes.delete(key);
    else this.collapsedNodes.add(key);
    if (this.collapsedNodes.size > 512) {
      const oldest = this.collapsedNodes.values().next().value;
      if (oldest !== undefined) this.collapsedNodes.delete(oldest);
    }
    this.requestUpdate();
  }

  static override styles = css`
    :host { display: block; min-width: 0; color: var(--pi-text); }
    .fleet { min-width: 0; padding: 1rem; border: 1px solid var(--pi-border-muted); border-radius: 0; background: var(--pi-surface); }
    h2 { margin: 0 0 .5rem; color: var(--pi-text-bright); font-size: 1rem; }
    .notice, .muted { margin: .35rem 0; color: var(--pi-text-secondary); font-size: .875rem; }
    .snapshot-time { margin: .35rem 0; color: var(--pi-text-secondary); font-size: .8rem; }
    .nodes { display: grid; gap: .5rem; margin: .75rem 0 0; padding: 0; list-style: none; }
    .children { margin: .5rem 0 0 1rem; padding-left: .75rem; border-left: 1px solid var(--pi-border-muted); }
    .node { min-width: 0; padding: .55rem .65rem; border: 1px solid var(--pi-border-muted); border-radius: 0; background: var(--pi-bg); }
    summary, .node-heading { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem .7rem; min-height: 1.5rem; }
    summary { cursor: pointer; }
    summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 3px; border-radius: 0; }
    .kind { color: var(--pi-text-secondary); font-size: .75rem; text-transform: uppercase; }
    .node-label { min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
    .state { margin-left: auto; color: var(--pi-text-secondary); font-size: .8rem; }
    .state-complete { color: var(--pi-success); }
    .state-failed, .state-rejected { color: var(--pi-danger); }
    .state-paused, .state-partial { color: var(--pi-warning); }
    .state-stopped { color: var(--pi-text-secondary); }
    .node-content { padding-top: .45rem; }
    dl { display: flex; flex-wrap: wrap; gap: .35rem 1rem; margin: 0; color: var(--pi-text-secondary); font-size: .8rem; }
    dl div { display: flex; gap: .3rem; }
    dt { font-weight: 600; }
    dd { margin: 0; overflow-wrap: anywhere; }
    @media (max-width: 38rem) { .children { margin-left: .25rem; padding-left: .5rem; } }
  `;
}

function summaryContent(node: FleetNode, generatedAt: number): TemplateResult {
  const elapsed = elapsedLabel(node, generatedAt);
  const lastActivity = node.activity?.lastActivityAt === undefined ? "Unavailable" : new Date(node.activity.lastActivityAt).toISOString();
  const currentTool = node.activity?.currentTool;
  return html`
    <dl>
      <div><dt>Elapsed at snapshot</dt><dd>${elapsed}</dd></div>
      <div><dt>Last activity at</dt><dd>${lastActivity}</dd></div>
      ${currentTool !== undefined && currentTool !== "" ? html`<div><dt>Current tool</dt><dd>${currentTool}</dd></div>` : null}
      ${node.activity?.toolCount !== undefined ? html`<div><dt>Tools reported</dt><dd>${String(node.activity.toolCount)}</dd></div>` : null}
      ${node.activity?.turnCount !== undefined ? html`<div><dt>Turns reported</dt><dd>${String(node.activity.turnCount)}</dd></div>` : null}
      ${node.hostStep?.stale === true ? html`<div><dt>Freshness</dt><dd>Stale result</dd></div>` : null}
      ${node.hostStep?.verdict !== undefined ? html`<div><dt>Host verdict</dt><dd>${node.hostStep.verdict}</dd></div>` : null}
      ${node.hostStep?.reasonCode !== undefined ? html`<div><dt>Reason</dt><dd>${node.hostStep.reasonCode}</dd></div>` : null}
    </dl>
  `;
}

function elapsedLabel(node: FleetNode, generatedAt: number): string {
  if (node.startedAt === undefined) return "Unavailable";
  const terminal = isTerminal(node.state);
  const end = terminal ? node.endedAt : generatedAt;
  if (end === undefined) return "Unavailable";
  if (end < node.startedAt) return "Unavailable";
  const totalSeconds = Math.floor((end - node.startedAt) / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  if (minutes > 0) return `${String(minutes)}m ${String(seconds)}s`;
  return `${String(seconds)}s`;
}

function isTerminal(state: FleetNodeState): boolean {
  return state === "complete" || state === "failed" || state === "partial" || state === "paused" || state === "stopped" || state === "rejected";
}

function kindLabel(kind: FleetNode["kind"]): string {
  if (kind === "workflow") return "Workflow";
  if (kind === "step") return "Step";
  if (kind === "host-step") return "Host step";
  return "Subagent";
}

function stateLabel(state: FleetNodeState): string {
  if (state === "complete") return "Succeeded";
  if (state === "failed") return "Failed";
  if (state === "partial") return "Partial";
  if (state === "paused") return "Paused";
  if (state === "stopped") return "Stopped";
  if (state === "rejected") return "Launch rejected";
  if (state === "queued") return "Queued · not yet running";
  return "Running";
}
