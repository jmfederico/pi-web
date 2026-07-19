import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionStatus } from "../api";
import { formatCost, formatTokenCount } from "../utils/format";
import { renderSessionWarningIcon, statusBarStyles } from "./shared";

export interface StatusBarWarningControlContent {
  countText: string;
  accessibleLabel: string;
}

export function statusBarWarningControlContent(count: number): StatusBarWarningControlContent | undefined {
  if (!Number.isInteger(count) || count <= 0) return undefined;
  const warningText = `${String(count)} ${count === 1 ? "warning" : "warnings"}`;
  return {
    countText: String(count),
    accessibleLabel: `Show ${warningText} in the warning area`,
  };
}

@customElement("status-bar")
export class StatusBar extends LitElement {
  @property({ attribute: false }) status?: SessionStatus;
  @property({ type: Number }) collapsedWarningCount = 0;
  @property({ attribute: false }) onRestoreWarnings?: () => void;

  private readonly handleRestoreWarnings = (): void => {
    this.onRestoreWarnings?.();
  };

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
    const warningControl = statusBarWarningControlContent(this.collapsedWarningCount);
    return html`
      <div class="bar">
        ${warningControl === undefined || this.onRestoreWarnings === undefined ? null : html`
          <button
            type="button"
            class="warning-restore"
            title=${warningControl.accessibleLabel}
            aria-label=${warningControl.accessibleLabel}
            @click=${this.handleRestoreWarnings}
          >
            ${renderSessionWarningIcon("warning", "warning-restore-icon")}
            <span>${warningControl.countText}</span>
          </button>
        `}
        <span>↑${formatTokenCount(tokens.input)}</span>
        <span>↓${formatTokenCount(tokens.output)}</span>
        <span class="context">${contextText}</span>
        <span>${formatCost(status.cost)}</span>
        ${status.pendingMessageCount > 0 ? html`<span>${String(status.pendingMessageCount)} queued</span>` : null}
      </div>
    `;
  }

  static override styles = statusBarStyles;
}
