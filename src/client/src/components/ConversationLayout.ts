import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionActivity, SessionStatus } from "../api";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { conversationLayoutStyles } from "../theme/base/conversationLayoutStyles";

/** Activity belongs to the conversation boundary, not the transcript scroller. */
export function conversationActivityText(status: SessionStatus | undefined, activity: SessionActivity | undefined, sending: boolean): string | undefined {
  if (sending) return "Sending your message…";
  const state = status === undefined ? activity?.label
    : status.isCompacting ? "compacting"
    : status.isBashRunning ? "bash"
    : status.isStreaming ? "running"
    : status.pendingMessageCount > 0 ? "queued" : "idle";
  if (state === undefined || (state === "idle" && activity?.phase !== "active")) return undefined;
  if (activity === undefined || (state !== "idle" && activity.phase === "idle")) return state;
  return activity.detail !== undefined && activity.detail !== "" ? `${activity.label}: ${activity.detail}` : activity.label;
}

/** Owns the transcript/composer boundary; children own their content and actions. */
@customElement("conversation-layout")
export class ConversationLayout extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) status: SessionStatus | undefined;
  @property({ attribute: false }) activity: SessionActivity | undefined;
  @property({ type: Boolean }) sending = false;
  @property({ type: Boolean }) visualEffects = true;

  override render() {
    const activity = conversationActivityText(this.status, this.activity, this.sending);
    return html`
      <div class="transcript"><slot></slot></div>
      <div class="composer-boundary">
        <slot name="composer"></slot>
        <div class=${this.visualEffects ? "activity-region" : "activity-region plain"} aria-live="polite">${activity === undefined ? nothing : html`
          <div class="activity-dock"><span class="dot"></span><span class="activity-text">${activity}</span></div>
        `}</div>
      </div>
      <slot name="status"></slot>
    `;
  }

  static override styles = conversationLayoutStyles;
}
