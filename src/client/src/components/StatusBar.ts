import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionStatus } from "../api";
import { formatCost, formatTokenCount } from "../utils/format";
import { renderSessionWarningIcon, statusBarStyles } from "./shared";

export interface StatusBarWarningControlContent {
  countText: string;
  accessibleLabel: string;
}

export function statusBarWarningControlContent(count: number, expanded: boolean): StatusBarWarningControlContent | undefined {
  if (!Number.isInteger(count) || count <= 0) return undefined;
  const warningText = `${String(count)} ${count === 1 ? "warning" : "warnings"}`;
  return {
    countText: String(count),
    accessibleLabel: expanded ? `Minimise ${warningText}` : `Show ${warningText} in the warning area`,
  };
}

@customElement("status-bar")
export class StatusBar extends LitElement {
  @property({ attribute: false }) status?: SessionStatus;
  @property({ type: Number }) warningCount = 0;
  @property({ type: Boolean }) warningsExpanded = false;
  @property({ attribute: false }) onToggleWarnings?: () => void;

  private readonly handleToggleWarnings = (): void => {
    this.onToggleWarnings?.();
  };

  override render() {
    const status = this.status;
    if (status === undefined) return html`<div class="bar muted">No session status yet</div>`;
    const contextText = formatContextUsage(status.contextUsage);
    const tokens = status.tokens;
    const cacheRead = formatCacheTokenCount(tokens.cacheRead);
    const cacheWrite = formatCacheTokenCount(tokens.cacheWrite);
    const cost = formatCost(status.cost);
    const warningControl = statusBarWarningControlContent(this.warningCount, this.warningsExpanded);
    return html`
      <div class="bar">
        ${warningControl === undefined || this.onToggleWarnings === undefined ? null : html`
          <button
            type="button"
            class="warning-toggle"
            title=${warningControl.accessibleLabel}
            aria-label=${warningControl.accessibleLabel}
            aria-expanded=${String(this.warningsExpanded)}
            @click=${this.handleToggleWarnings}
          >
            ${renderSessionWarningIcon("warning", "warning-toggle-icon")}
            <span>${warningControl.countText}</span>
          </button>
        `}
        <span>↑${formatTokenCount(tokens.input)}</span>
        <span>↓${formatTokenCount(tokens.output)}</span>
        <span class="context">${contextText}</span>
        <span
          title="Provider-reported cumulative cache-read tokens; not added to input/output totals, and no hit rate is inferred."
          aria-description="Provider-reported cumulative cache-read count; separate from input/output totals. No hit rate is inferred."
        >cache read ${cacheRead}</span>
        <span
          title="Provider-reported cumulative cache-write tokens; not added to input/output totals, and no hit rate is inferred."
          aria-description="Provider-reported cumulative cache-write count; separate from input/output totals. No hit rate is inferred."
        >cache write ${cacheWrite}</span>
        <span
          title="Session-reported cost; may include reported tool/subagent usage and is not a complete fleet total."
          aria-description="Session-reported cost; may include reported tool/subagent usage and is not a complete fleet total."
        >session ${cost}</span>
        ${status.pendingMessageCount > 0 ? html`<span>${String(status.pendingMessageCount)} queued</span>` : null}
      </div>
    `;
  }

  static override styles = statusBarStyles;
}

function formatCacheTokenCount(count: number): string {
  return Number.isFinite(count) && count >= 0 ? formatTokenCount(count) : "unknown";
}

function formatContextUsage(context: SessionStatus["contextUsage"]): string {
  if (!context || !Number.isFinite(context.contextWindow) || context.contextWindow <= 0) return "context unknown";
  if (context.percent == null) return `context ${formatTokenCount(context.contextWindow)}`;
  if (!Number.isFinite(context.percent) || context.percent < 0) return "context unknown";
  return `context ${context.percent.toFixed(1)}%/${formatTokenCount(context.contextWindow)}`;
}
