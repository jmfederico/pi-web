import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionNotificationBadgeModel } from "../sessionNotifications";

@customElement("notification-badge")
export class NotificationBadge extends LitElement {
  @property({ attribute: false }) model?: SessionNotificationBadgeModel;

  override render() {
    const model = this.model;
    if (model === undefined) return null;
    return html`
      <span class=${`badge ${model.severity}`} role="img" aria-label=${model.accessibleLabel} title=${model.accessibleLabel}>
        <span class="icon" aria-hidden="true">${model.icon}</span>
        <span class="count" aria-hidden="true">${model.text}</span>
      </span>
    `;
  }

  static override styles = css`
    :host { flex: 0 0 auto; display: inline-flex; max-width: 100%; vertical-align: middle; }
    .badge { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 3px; min-width: 24px; max-width: 100%; min-height: 20px; border: 1px solid var(--pi-accent-border); border-radius: 999px; background: var(--pi-selection-bg); color: var(--pi-accent); padding: 1px 6px; font: 650 11px/1.2 system-ui, sans-serif; text-transform: none; white-space: nowrap; }
    .badge.warning { border-color: var(--pi-warning-border); background: var(--pi-warning-surface); color: var(--pi-warning); }
    .badge.error { border-color: var(--pi-danger); background: color-mix(in srgb, var(--pi-danger) 12%, var(--pi-surface)); color: var(--pi-danger); }
    .icon { font-size: 11px; line-height: 1; }
    .count { overflow: hidden; text-overflow: ellipsis; }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "notification-badge": NotificationBadge;
  }
}
