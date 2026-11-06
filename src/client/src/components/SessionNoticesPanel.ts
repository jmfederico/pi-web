import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionStatus } from "../api";
import { localization, LocalizationController } from "../localization/browser";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { sessionNoticesStyles } from "../theme/base/sessionNoticesStyles";
import { baseThemeStyles } from "../theme/base/styles";
import { chatSessionWarningRows, renderSessionWarnings, type ChatSessionWarningRow } from "./chat/SessionWarnings";
import noticesMessages from "./SessionNoticesPanel.messages";

export const sessionNoticesMessages = localization.registerMessages("core.notices", noticesMessages);

export interface SessionNoticeDismissDetail {
  machineId: string;
  sessionId: string;
  dismissId: string;
}

@customElement("session-notices-panel")
export class SessionNoticesPanel extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @property({ attribute: false }) status: SessionStatus | undefined;
  /** Application-scoped conditions remain available without a selected session. */
  @property({ attribute: false }) notices: readonly ChatSessionWarningRow[] = [];
  @property({ type: String }) machineId = "";

  private readonly dismissNotice = (dismissId: string): void => {
    if (this.status === undefined) return;
    this.dispatchEvent(new CustomEvent<SessionNoticeDismissDetail>("session-notice-dismiss", {
      bubbles: true,
      composed: true,
      detail: { machineId: this.machineId, sessionId: this.status.sessionId, dismissId },
    }));
  };

  override render() {
    const rows = [...this.notices, ...chatSessionWarningRows(this.status)];
    return rows.length === 0
      ? html`<p class="empty">${sessionNoticesMessages.t("empty")}</p>`
      : renderSessionWarnings(rows, this.dismissNotice);
  }

  static override styles = [sessionNoticesStyles, baseThemeStyles(`
    :host { display: block; min-width: 0; min-height: 0; height: 100%; overflow-y: auto; color: var(--pi-text); font: 14px var(--pi-font, system-ui, sans-serif); }
    .empty { margin: 0; padding: 16px; color: var(--pi-muted); }
  `)];
}

declare global {
  interface HTMLElementTagNameMap {
    "session-notices-panel": SessionNoticesPanel;
  }
}
