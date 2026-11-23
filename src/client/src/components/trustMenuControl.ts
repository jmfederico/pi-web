import { html, type TemplateResult } from "lit";
import { projectWorkspaceMessages as messages } from "../projectWorkspaceMessages";

export interface TrustMenuState {
  loading?: boolean;
  saving?: boolean;
  trusted?: boolean;
  error?: string;
}

/** Native checkbox shared by project-root and individual workspace menus. */
export function renderTrustMenuControl(options: {
  id: string;
  state: TrustMenuState | undefined;
  label: string;
  busyLabel: string;
  /** IDs of existing menu details that identify the permission scope. */
  describedBy?: string;
  onChange: (trusted: boolean) => void;
}): TemplateResult {
  const { id, state, label, busyLabel, describedBy, onChange } = options;
  const busy = state?.loading === true || state?.saving === true;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  return html`
    <label class="action-menu-checkbox ui-menu-item" data-busy=${busy} for=${id}>
      <span>${busy ? busyLabel : label}</span>
      <input
        id=${id}
        type="checkbox"
        aria-describedby=${[describedBy, helpId, state?.error === undefined ? undefined : errorId].filter(Boolean).join(" ")}
        .checked=${state?.trusted === true}
        ?disabled=${busy || state?.trusted === undefined}
        @change=${(event: Event) => { if (event.target instanceof HTMLInputElement) onChange(event.target.checked); }}
      />
    </label>
    <div class="action-menu-description" id=${helpId}>
      <a href="https://pi.dev/docs/latest/security" target="_blank" rel="noreferrer">${messages.t("learnTrust")}</a>
    </div>
    ${state?.error === undefined ? null : html`<div class="action-menu-description action-menu-error" id=${errorId} role="alert">${state.error}</div>`}
  `;
}
