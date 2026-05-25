import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Machine, SessionStatus, Workspace } from "../api";
import type { WorkspaceLabelItem } from "../plugins/types";
import { formatCost, formatTokenCount } from "../utils/format";
import { statusBarStyles } from "./shared";
import { renderWorkspaceLabel } from "./workspaceLabel";

@customElement("status-bar")
export class StatusBar extends LitElement {
  @property({ attribute: false }) status?: SessionStatus;
  @property({ attribute: false }) machine?: Machine;
  @property({ attribute: false }) workspace?: Workspace;
  @property({ attribute: false }) workspaceLabelItems: WorkspaceLabelItem[] = [];

  override render() {
    const status = this.status;
    if (status === undefined) return html`<div class="bar muted">No session status yet</div>`;
    const context = status.contextUsage;
    const contextText = context
      ? context.percent == null
        ? `context ${formatTokenCount(context.contextWindow)}`
        : `${context.percent.toFixed(1)}%/${formatTokenCount(context.contextWindow)}`
      : "context unknown";
    const tokens = status.tokens;
    return html`
      <div class="bar">
        <span>${this.machine?.name ?? "Local"}</span>
        <span>${renderWorkspaceLabel(this.workspace?.label ?? "workspace", this.workspaceLabelItems, this.workspace?.path)}</span>
        <span>↑${formatTokenCount(tokens.input)}</span>
        <span>↓${formatTokenCount(tokens.output)}</span>
        <span>${contextText}</span>
        <span>${formatCost(status.cost)}</span>
        ${status.pendingMessageCount > 0 ? html`<span>${String(status.pendingMessageCount)} queued</span>` : null}
      </div>
    `;
  }

  static override styles = statusBarStyles;
}
