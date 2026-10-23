import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  notificationAnnouncementLabel, notificationDismissLabel, notificationFocusTargetAfterDismiss,
  notificationInboxOverflowLabel, notificationInboxTotalCount, notificationMessageTruncationLabel,
  notificationSeverityLabel, notificationTargetKey, notificationTrayHeading, notificationTrayIsCollapsed,
  setNotificationTrayCollapsed, type NotificationFocusTarget, type SelectedSessionNotificationView, type SessionNotificationTarget,
} from "../sessionNotifications";
import { uiButtonStyles, uiToolbarStyles } from "./ui/controlStyles";
import { sessionNotificationTrayStyles } from "./sessionNotificationTrayStyles";

const timestampFormatter = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

function isNotificationTarget(value: unknown): value is SessionNotificationTarget {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "machineId") === "string"
    && typeof Reflect.get(value, "cwd") === "string"
    && typeof Reflect.get(value, "sessionId") === "string";
}

function renderNotificationMessage(message: string, truncated: boolean) {
  const parts = [];
  let offset = 0;
  // Require a text boundary so embedded schemes such as javascript:https://… stay text.
  for (const match of message.matchAll(/(^|[\s([<'"`])https?:\/\/[^\s<>"'`\p{Cc}]+/giu)) {
    const start = match.index + (match[1] ?? "").length;
    const end = match.index + match[0].length;
    // Even trailing punctuation could be part of a URL cut off by the byte limit.
    if (truncated && end === message.length) continue;
    let url = message.slice(start, end).replace(/[.,!?:;]+$/u, "");
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
      while (url.endsWith(close) && url.split(close).length > url.split(open).length) {
        url = url.slice(0, -1).replace(/[.,!?:;]+$/u, "");
      }
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    } catch {
      // Malformed candidates remain escaped plain text.
      continue;
    }
    parts.push(message.slice(offset, start), html`<a href=${url} target="_blank" rel="noopener noreferrer">${url}</a>`);
    offset = start + url.length;
  }
  parts.push(message.slice(offset));
  return parts;
}

interface PendingNotificationFocus {
  chatKey: string;
  focusTarget: NotificationFocusTarget;
}

@customElement("session-notification-tray")
export class SessionNotificationTray extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property() sessionId = "";
  @property({ attribute: false }) notificationInbox?: SelectedSessionNotificationView;
  @property({ attribute: false }) onDismissNotification?: (notificationId: string) => void;
  @property({ attribute: false }) onDismissAllNotifications?: () => void;
  @state() private collapsedNotificationTargetKeys: ReadonlySet<string> = new Set();
  @state() private retainedEmptyNotificationTrayTargetKey: string | undefined;
  private pendingNotificationFocus: PendingNotificationFocus | undefined;

  protected override willUpdate(changed: Map<string, unknown>): void {
    const previous = changed.get("notificationInbox");
    const current = this.notificationInbox;
    if (changed.has("sessionId") || (changed.has("notificationInbox")
      && (!isNotificationTarget(previous) || current === undefined || notificationTargetKey(previous) !== notificationTargetKey(current)))) {
      this.pendingNotificationFocus = undefined;
      this.retainedEmptyNotificationTrayTargetKey = undefined;
    }
    const visible = this.hasVisibleTray();
    this.toggleAttribute("empty", !visible);
    this.toggleAttribute("collapsed", visible && current !== undefined && notificationTrayIsCollapsed(this.collapsedNotificationTargetKeys, current));
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("notificationInbox") && this.pendingNotificationFocus !== undefined) this.focusPendingNotificationTarget();
  }

  override disconnectedCallback(): void {
    this.pendingNotificationFocus = undefined;
    this.retainedEmptyNotificationTrayTargetKey = undefined;
    super.disconnectedCallback();
  }

  private hasVisibleTray(): boolean {
    const inbox = this.notificationInbox;
    return inbox?.sessionId === this.sessionId
      && (notificationInboxTotalCount(inbox) > 0 || inbox.pendingDismissedIds.size > 0 || inbox.dismissAllPending
        || this.retainedEmptyNotificationTrayTargetKey === notificationTargetKey(inbox));
  }

  override render() {
    return html`${this.renderTray()}${this.renderLiveRegions()}`;
  }

  private renderTray() {
    const inbox = this.notificationInbox;
    if (inbox === undefined || !this.hasVisibleTray()) return null;
    const collapsed = notificationTrayIsCollapsed(this.collapsedNotificationTargetKeys, inbox);
    const toggleLabel = collapsed ? "Expand notifications" : "Collapse notifications";
    return html`
      <section class=${`notification-tray${collapsed ? " collapsed" : ""}`} role="region" aria-labelledby="session-notifications-heading" @focusout=${(event: FocusEvent) => { this.releaseEmptyNotificationTray(event); }}>
        <header class="notification-header" data-notification-focus="header" tabindex="-1">
          <strong class="notification-heading" id="session-notifications-heading">${notificationTrayHeading(inbox)}</strong>
          <div class="ui-toolbar notification-header-actions">
            <div class="ui-toolbar-group">
              <button type="button" class="ui-button notification-clear" aria-label="Clear all notifications" title="Clear all notifications"
                ?disabled=${inbox.dismissAllPending || notificationInboxTotalCount(inbox) === 0 || this.onDismissAllNotifications === undefined}
                @click=${() => { this.dismissAllNotifications(); }}>Clear</button>
              <button type="button" class="ui-button ui-button--icon notification-toggle" aria-label=${toggleLabel} title=${toggleLabel}
                aria-expanded=${String(!collapsed)} aria-controls="session-notification-list"
                @click=${() => { this.collapsedNotificationTargetKeys = setNotificationTrayCollapsed(this.collapsedNotificationTargetKeys, inbox, !collapsed); }}>
                <svg class=${`notification-icon notification-disclosure-icon${collapsed ? "" : " expanded"}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 18 6-6-6-6"></path></svg>
              </button>
            </div>
          </div>
        </header>
        <div class="notification-list" id="session-notification-list" ?hidden=${collapsed}>
          ${inbox.discardedCount === 0 ? null : html`<p class="notification-overflow">${notificationInboxOverflowLabel(inbox.discardedCount)}</p>`}
          ${inbox.notifications.map((notification) => html`
            <article class=${`notification-row ${notification.severity}`} data-notification-id=${notification.id} tabindex="-1">
              <div class="notification-metadata">
                <strong class="notification-severity">${notificationSeverityLabel(notification.severity)}</strong>
                <span aria-hidden="true">·</span>
                <time datetime=${notification.receivedAt}>${timestampFormatter.format(new Date(notification.receivedAt))}</time>
              </div>
              <p class="notification-message" dir="auto">${renderNotificationMessage(notification.message, notification.truncated)}</p>
              ${notificationMessageTruncationLabel(notification) === undefined ? null : html`<p class="notification-truncated">${notificationMessageTruncationLabel(notification)}</p>`}
              <button type="button" class="ui-button ui-button--compact ui-button--icon notification-row-dismiss"
                aria-label=${notificationDismissLabel(notification)} title="Dismiss notification"
                ?disabled=${inbox.pendingDismissedIds.has(notification.id) || inbox.dismissAllPending || this.onDismissNotification === undefined}
                @click=${() => { this.dismissNotification(notification.id); }}>
                <svg class="notification-icon notification-close-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12"></path><path d="M18 6 6 18"></path></svg>
              </button>
            </article>
          `)}
        </div>
      </section>`;
  }

  private renderLiveRegions() {
    const announcements = this.notificationInbox?.sessionId === this.sessionId ? this.notificationInbox.announcements : [];
    const polite = announcements.filter((announcement) => announcement.severity !== "error");
    const assertive = announcements.filter((announcement) => announcement.severity === "error");
    return html`
      <div class="visually-hidden notification-live" aria-live="polite" aria-atomic="false">${repeat(polite, (announcement) => announcement.id, (announcement) => html`<span data-announcement-id=${announcement.id}>${notificationAnnouncementLabel(announcement)}</span>`)}</div>
      <div class="visually-hidden notification-live" aria-live="assertive" aria-atomic="false">${repeat(assertive, (announcement) => announcement.id, (announcement) => html`<span data-announcement-id=${announcement.id}>${notificationAnnouncementLabel(announcement)}</span>`)}</div>`;
  }

  private dismissNotification(notificationId: string): void {
    const inbox = this.notificationInbox;
    if (inbox === undefined || this.onDismissNotification === undefined) return;
    const focusTarget = notificationFocusTargetAfterDismiss(inbox.notifications, notificationId);
    const chatKey = notificationTargetKey(inbox);
    this.pendingNotificationFocus = { chatKey, focusTarget };
    if (focusTarget.kind === "header") this.retainedEmptyNotificationTrayTargetKey = chatKey;
    this.onDismissNotification(notificationId);
  }

  private dismissAllNotifications(): void {
    const inbox = this.notificationInbox;
    if (inbox === undefined || this.onDismissAllNotifications === undefined) return;
    const chatKey = notificationTargetKey(inbox);
    this.pendingNotificationFocus = { chatKey, focusTarget: { kind: "header" } };
    this.retainedEmptyNotificationTrayTargetKey = chatKey;
    this.onDismissAllNotifications();
  }

  private releaseEmptyNotificationTray(event: FocusEvent): void {
    const tray = event.currentTarget;
    const next = event.relatedTarget;
    if (tray instanceof HTMLElement && next instanceof Node && tray.contains(next)) return;
    // Removing the activated row can emit focusout before updated() moves focus.
    if (this.pendingNotificationFocus !== undefined) return;
    const inbox = this.notificationInbox;
    if (inbox !== undefined && this.retainedEmptyNotificationTrayTargetKey === notificationTargetKey(inbox)
      && notificationInboxTotalCount(inbox) === 0) this.retainedEmptyNotificationTrayTargetKey = undefined;
  }

  private focusPendingNotificationTarget(): void {
    const pending = this.pendingNotificationFocus;
    this.pendingNotificationFocus = undefined;
    const inbox = this.notificationInbox;
    if (pending === undefined || inbox === undefined || notificationTargetKey(inbox) !== pending.chatKey) return;
    if (pending.focusTarget.kind === "notification") {
      const notificationId = pending.focusTarget.notificationId;
      const row = Array.from(this.renderRoot.querySelectorAll<HTMLElement>("[data-notification-id]"))
        .find((candidate) => candidate.dataset["notificationId"] === notificationId);
      if (row !== undefined) { row.focus(); return; }
    }
    if (notificationInboxTotalCount(inbox) === 0) this.retainedEmptyNotificationTrayTargetKey = pending.chatKey;
    this.renderRoot.querySelector<HTMLElement>("[data-notification-focus='header']")?.focus();
  }

  static override styles = [uiButtonStyles, uiToolbarStyles, sessionNotificationTrayStyles];
}
