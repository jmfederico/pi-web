import { html } from "lit";
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
    message: warning.message,
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
          <button type="button" class="session-warnings-collapse ui-button ui-button--compact" title="Minimise warnings" aria-label="Minimise warnings" @click=${onToggle}>
            <svg class="session-warnings-collapse-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m18 15-6-6-6 6"></path></svg>
            <span>Minimise</span>
          </button>
        </div>
      `}
      ${rows.map((row) => html`
        <div class=${row.severityClass}>
          <div class="session-warning-head">
            ${renderSessionWarningIcon(row.severity, "session-warning-icon")}
            ${row.source === undefined ? null : html`<span class="session-warning-source">${row.source}</span>`}
          </div>
          <div class="session-warning-body">
            <p class="session-warning-message">${row.message}</p>
            ${row.path === undefined ? null : html`<p class="session-warning-path">${row.path}</p>`}
          </div>
          ${row.dismissId === undefined ? null : html`
            <button type="button" class="session-warning-dismiss ui-button ui-button--icon ui-button--compact" title="Don't show this warning again" aria-label="Dismiss warning" @click=${() => { if (row.dismissId !== undefined) onDismiss?.(row.dismissId); }}>×</button>
          `}
        </div>
      `)}
    </aside>
  `;
}
