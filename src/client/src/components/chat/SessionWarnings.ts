import { html } from "lit";
import { chatChromeMessages as messages } from "../../chatChromeMessages";
import type { SessionStatus, SessionWarningSeverity } from "../../api";
import { renderSessionWarningIcon } from "../shared";

export interface ChatSessionWarningRow {
  severity: SessionWarningSeverity;
  severityClass: string;
  message: string;
  source?: string;
  path?: string;
  dismissId?: string;
}

export function chatSessionWarningRows(status: SessionStatus | undefined): ChatSessionWarningRow[] {
  return (status?.warnings ?? []).map((warning) => ({
    severity: warning.severity,
    severityClass: `session-warning ${warning.severity}`,
    message: warning.presentation?.kind === "anthropicSubscriptionAuth"
      ? messages.t("anthropicSubscriptionAuth", { usageUrl: "https://claude.ai/settings/usage" })
      : warning.message,
    ...(warning.source === undefined ? {} : { source: warning.source }),
    ...(warning.path === undefined ? {} : { path: warning.path }),
    ...(warning.dismiss === undefined ? {} : { dismissId: warning.dismiss.id }),
  }));
}

export function renderSessionWarnings(rows: readonly ChatSessionWarningRow[], onToggle: (() => void) | undefined, onDismiss: ((id: string) => void) | undefined) {
  return html`
    <aside class="session-warnings" role="alert" aria-live="polite">
      ${onToggle === undefined ? null : html`
        <div class="session-warnings-controls">
          <button type="button" class="session-warnings-collapse ui-button ui-button--compact" title=${messages.t("minimiseWarnings")} aria-label=${messages.t("minimiseWarnings")} @click=${onToggle}>
            <svg class="session-warnings-collapse-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m18 15-6-6-6 6"></path></svg>
            <span>${messages.t("minimise")}</span>
          </button>
        </div>
      `}
      ${rows.map((row) => html`
        <div class=${row.severityClass}>
          <div class="session-warning-head">
            ${renderSessionWarningIcon(row.severity, "session-warning-icon")}
            ${row.source === undefined ? null : html`<span class="session-warning-source" dir="auto">${row.source}</span>`}
          </div>
          <div class="session-warning-body">
            <p class="session-warning-message" dir="auto">${row.message}</p>
            ${row.path === undefined ? null : html`<p class="session-warning-path" dir="ltr">${row.path}</p>`}
          </div>
          ${row.dismissId === undefined ? null : html`
            <button type="button" class="session-warning-dismiss ui-button ui-button--icon ui-button--compact" title=${messages.t("dismissWarningTitle")} aria-label=${messages.t("dismissWarning")} @click=${() => { if (row.dismissId !== undefined) onDismiss?.(row.dismissId); }}>×</button>
          `}
        </div>
      `)}
    </aside>
  `;
}
