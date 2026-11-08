import { html } from "lit";
import type { SessionWarning } from "../../api";
import type { AppState } from "../../appState";
import { sessionNoticesMessages } from "../../components/SessionNoticesPanel";
import type { ChatSessionWarningRow } from "../../components/chat/SessionWarnings";
import type { ApplicationPanelContribution } from "../types";

export const EMPTY_SESSION_NOTICES: readonly SessionWarning[] = Object.freeze([]);
const previewWarning: SessionWarning = {
  severity: "warning", message: "Layout preview warning. No session error occurred.", source: "preview",
};
const previewNotices = new WeakMap<readonly SessionWarning[], readonly SessionWarning[]>();

/** Only the selected session's matching status can supply persistent notices. */
export function sessionNotices(state: AppState): readonly SessionWarning[] {
  if (state.selectedSession === undefined || state.status?.sessionId !== state.selectedSession.id) return EMPTY_SESSION_NOTICES;
  const warnings = state.status.warnings ?? EMPTY_SESSION_NOTICES;
  // Temporary, opt-in layout preview. Never modifies session state or backend warnings.
  if (!import.meta.env.DEV || typeof window === "undefined"
    || new URLSearchParams(window.location.search).get("previewWarning") !== "1") return warnings;
  let preview = previewNotices.get(warnings);
  if (preview === undefined) {
    preview = [...warnings, previewWarning];
    previewNotices.set(warnings, preview);
  }
  return preview;
}

export function createCoreNoticesPanel(getApplicationNotices: () => readonly ChatSessionWarningRow[] = () => []): ApplicationPanelContribution {
  return {
    id: "notices",
    order: 0,
    get title() { return sessionNoticesMessages.t("title"); },
    visible: (context) => getApplicationNotices().length + sessionNotices(context.state).length > 0,
    badge: (context) => getApplicationNotices().length + sessionNotices(context.state).length || undefined,
    render: (context) => {
      const warnings = sessionNotices(context.state);
      const status = context.state.status;
      const matchedStatus = status?.sessionId === context.state.selectedSession?.id ? status : undefined;
      const displayedStatus = matchedStatus === undefined || warnings === (matchedStatus.warnings ?? EMPTY_SESSION_NOTICES)
        ? matchedStatus : { ...matchedStatus, warnings: [...warnings] };
      return html`<session-notices-panel .notices=${getApplicationNotices()} .status=${displayedStatus} .machineId=${context.machine.id}></session-notices-panel>`;
    },
  };
}
