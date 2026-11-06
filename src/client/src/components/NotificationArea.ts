import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { localization, LocalizationController } from "../localization/browser";
import type { NotificationGroup, NotificationItem } from "../notificationArea";
import {
  notificationAnnouncementLabel, notificationDismissLabel, notificationInboxOverflowLabel,
  notificationMessageTruncationLabel, notificationSeverityLabel, notificationTrayHeading,
} from "../sessionNotifications";
import { sessionNotificationMessages as messages } from "../sessionNotificationMessages";
import { uiButtonStyles, uiToolbarStyles } from "./ui/controlStyles";
import { sessionNotificationTrayStyles } from "./sessionNotificationTrayStyles";
import { renderSessionWarningIcon } from "./shared";
import bannerDefinitions from "./errorBanner.messages";

const actionMessages = localization.registerMessages("core.banners", bannerDefinitions);

function renderNotificationMessage(message: string, truncated: boolean) {
  const parts = [];
  let offset = 0;
  // Require a text boundary so embedded schemes such as javascript:https://… stay text.
  for (const match of message.matchAll(/(^|[\s([<'"`])https?:\/\/[^\s<>"'`\p{Cc}]+/giu)) {
    const start = match.index + (match[1] ?? "").length;
    const end = match.index + match[0].length;
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

interface PendingFocus {
  contextKey: string;
  actionKey: string;
  removedId?: string;
  buttonSelector?: string;
  adjacentIds: string[];
}

/** One presentation for local and server-owned events. Actions stay with each owner. */
@customElement("notification-area")
export class NotificationArea extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @property() contextKey = "";
  @property({ attribute: false }) groups: readonly NotificationGroup[] = [];
  @property({ attribute: false }) onActionError: (error: unknown) => void = (error) => { console.error("Notification action failed", error); };
  @state() private collapsedContexts: ReadonlySet<string> = new Set();
  @state() private pendingActions: ReadonlySet<string> = new Set();
  @state() private retainedEmptyContext: string | undefined;
  // Keep occurrence identities across optimistic removals, refresh gaps and navigation.
  // These are page-local acknowledgements, not a second notification history.
  private readonly seenIds = new Set<string>();
  private announcements: Pick<NotificationItem, "id" | "severity">[] = [];
  private revealErrorId: string | undefined;
  private pendingFocus: PendingFocus | undefined;

  private get items(): readonly NotificationItem[] { return this.groups.flatMap((group) => group.items); }
  private get discardedCount(): number { return this.groups.reduce((total, group) => total + (group.discardedCount ?? 0), 0); }
  private get collapsed(): boolean { return this.collapsedContexts.has(this.contextKey); }
  private get clearing(): boolean { return this.pendingActions.has(`clear:${this.contextKey}`); }
  private get hasContent(): boolean {
    return this.items.length + this.discardedCount > 0 || this.groups.some((group) => group.pending === true)
      || this.clearing || this.retainedEmptyContext === this.contextKey;
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("contextKey")) {
      this.pendingFocus = undefined;
      this.retainedEmptyContext = undefined;
      this.announcements = [];
    }
    if (changed.has("groups") || changed.has("contextKey")) {
      const arrivals = this.items.filter((item) => !this.seenIds.has(item.id));
      for (const item of arrivals) this.seenIds.add(item.id);
      this.announcements = [...this.announcements, ...arrivals.map(({ id, severity }) => ({ id, severity }))].slice(-100);
      const error = arrivals.find((item) => item.severity === "error");
      if (error !== undefined && this.collapsed) {
        this.setCollapsed(false);
        this.revealErrorId = error.id;
      }
    }
    this.toggleAttribute("empty", !this.hasContent);
    this.toggleAttribute("collapsed", this.hasContent && this.collapsed);
  }

  protected override updated(): void {
    if (this.revealErrorId !== undefined) {
      const row = this.row(this.revealErrorId);
      const list = this.renderRoot.querySelector<HTMLElement>(".notification-list");
      // Scroll only this area's list, never the conversation or document, and do not focus.
      if (row !== undefined && list !== null) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top;
      this.revealErrorId = undefined;
    }
    this.recoverFocus();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.ownerDocument.addEventListener("focusin", this.handleDocumentFocusIn, true);
  }

  override disconnectedCallback(): void {
    this.ownerDocument.removeEventListener("focusin", this.handleDocumentFocusIn, true);
    this.pendingFocus = undefined;
    this.retainedEmptyContext = undefined;
    super.disconnectedCallback();
  }

  private setCollapsed(collapsed: boolean): void {
    const next = new Set(this.collapsedContexts);
    if (collapsed) next.add(this.contextKey);
    else next.delete(this.contextKey);
    this.collapsedContexts = next;
  }

  override render() {
    const items = this.items;
    const counts = { error: 0, warning: 0, info: 0 };
    for (const item of items) counts[item.severity] += 1;
    const toggleLabel = messages.t(this.collapsed ? "expand" : "collapse");
    return html`
      ${!this.hasContent ? null : html`
        <section class=${`notification-tray${this.collapsed ? " collapsed" : ""}`} role="region" aria-labelledby="notifications-heading" @focusout=${this.handleFocusOut}>
          <header class="notification-header" data-notification-focus="header" tabindex="-1">
            <div class="notification-labels" id="notifications-heading">
              <strong class="notification-heading">${notificationTrayHeading({ retainedCount: items.length, discardedCount: this.discardedCount })}</strong>
              <div class="notification-summary">
                ${(["error", "warning", "info"] as const).filter((severity) => counts[severity] > 0).map((severity) => html`
                  <span class=${`notification-count ${severity}`} role="img" aria-label=${messages.t("severityCount", { severity, count: counts[severity] })} title=${messages.t("severityCount", { severity, count: counts[severity] })}>
                    ${renderSessionWarningIcon(severity, "notification-icon")}
                    <span class="notification-count-value" aria-hidden="true">${localization.number(counts[severity])}</span>
                  </span>
                `)}
              </div>
            </div>
            <div class="ui-toolbar ui-toolbar--borderless notification-header-actions"><div class="ui-toolbar-group">
              <button type="button" class="ui-button notification-clear" aria-label=${messages.t("clearAll")} title=${messages.t("clearAll")}
                ?disabled=${this.clearing || !this.groups.some((group) => group.clear !== undefined && group.pending !== true && (group.items.length > 0 || (group.discardedCount ?? 0) > 0))}
                @click=${() => { this.clear(); }}>${messages.t("clear")}</button>
              <button type="button" class="ui-button ui-button--icon notification-toggle" aria-label=${toggleLabel} title=${toggleLabel}
                aria-expanded=${String(!this.collapsed)} aria-controls="notification-list" @click=${() => { this.setCollapsed(!this.collapsed); }}>
                <svg class=${`notification-icon notification-disclosure-icon${this.collapsed ? "" : " expanded"}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 18 6-6-6-6"></path></svg>
              </button>
            </div></div>
          </header>
          <div class="notification-list" id="notification-list" ?hidden=${this.collapsed}>
            ${this.discardedCount === 0 ? null : html`<p class="notification-overflow">${notificationInboxOverflowLabel(this.discardedCount)}</p>`}
            ${repeat(items, (item) => item.id, (item) => this.renderItem(item))}
          </div>
        </section>
      `}
      ${this.renderLiveRegion("polite", this.announcements.filter((item) => item.severity !== "error"))}
      ${this.renderLiveRegion("assertive", this.announcements.filter((item) => item.severity === "error"))}
    `;
  }

  private renderItem(item: NotificationItem) {
    const pending = item.pending === true || this.pendingActions.has(item.id) || this.clearing
      || this.groups.some((group) => group.pending === true && group.items.some((candidate) => candidate.id === item.id));
    const sourceKeys = { browser: "sourceBrowser", server: "sourceServer", session: "sourceSession" } as const;
    const truncatedLabel = notificationMessageTruncationLabel({ truncated: item.truncated === true });
    return html`
      <article class=${`notification-row ${item.severity}`} data-notification-id=${item.id} tabindex="-1">
        <div class="notification-metadata">
          <strong class="notification-severity">${notificationSeverityLabel(item.severity)}</strong>
          <span aria-hidden="true">·</span><span class="notification-source">${messages.t(sourceKeys[item.source])}</span>
          ${item.scopeLabel === undefined ? null : html`<span aria-hidden="true">·</span><span dir="auto">${item.scopeLabel}</span>`}
          ${item.receivedAt === undefined ? null : html`<span aria-hidden="true">·</span><time datetime=${item.receivedAt}>${localization.time(new Date(item.receivedAt), { timeStyle: "short" })}</time>`}
        </div>
        <p class="notification-message" dir="auto">${renderNotificationMessage(item.message, item.truncated === true)}</p>
        ${truncatedLabel === undefined ? null : html`<p class="notification-truncated">${truncatedLabel}</p>`}
        ${item.retry === undefined ? null : html`<div><button type="button" class="ui-button ui-button--compact notification-retry" ?disabled=${pending}
          @click=${() => { this.retry(item); }}>${actionMessages.t("retry")}</button></div>`}
        ${item.dismiss === undefined ? null : html`<button type="button" class="ui-button ui-button--compact ui-button--icon notification-row-dismiss"
          aria-label=${notificationDismissLabel(item)} title=${messages.t("dismissTitle")} ?disabled=${pending}
          @click=${() => { this.dismiss(item); }}>
          <svg class="notification-icon notification-close-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12"></path><path d="M18 6 6 18"></path></svg>
        </button>`}
      </article>`;
  }

  private renderLiveRegion(mode: "polite" | "assertive", items: readonly Pick<NotificationItem, "id" | "severity">[]) {
    return html`<div class="visually-hidden notification-live" aria-live=${mode} aria-atomic="false">${repeat(items, (item) => item.id, (item) => html`<span data-announcement-id=${item.id}>${notificationAnnouncementLabel(item)}</span>`)}</div>`;
  }

  private dismiss(item: NotificationItem): void {
    if (item.dismiss === undefined || this.pendingActions.has(item.id)) return;
    this.prepareItemFocus(item, ".notification-row-dismiss");
    void this.perform(item.id, item.dismiss);
  }

  private retry(item: NotificationItem): void {
    if (item.retry === undefined || this.pendingActions.has(item.id)) return;
    this.prepareItemFocus(item, ".notification-retry");
    void this.perform(item.id, item.retry);
  }

  private prepareItemFocus(item: NotificationItem, buttonSelector: string): void {
    const items = this.items;
    const index = items.findIndex((candidate) => candidate.id === item.id);
    this.prepareFocus({
      contextKey: this.contextKey, actionKey: item.id, removedId: item.id, buttonSelector,
      adjacentIds: [...items.slice(index + 1), ...items.slice(0, index).reverse()].map((candidate) => candidate.id),
    });
  }

  private clear(): void {
    if (this.clearing) return;
    const actions = this.groups.filter((group) => group.pending !== true && (group.items.length > 0 || (group.discardedCount ?? 0) > 0))
      .flatMap((group) => group.clear === undefined ? [] : [group.clear]);
    this.prepareFocus({ contextKey: this.contextKey, actionKey: `clear:${this.contextKey}`, adjacentIds: [] });
    // Start every captured owner action even if another throws; later arrivals are not captured.
    void this.perform(`clear:${this.contextKey}`, async () => {
      const results = await Promise.allSettled(actions.map(async (action) => { await action(); }));
      for (const result of results) if (result.status === "rejected") this.onActionError(result.reason);
    });
  }

  private async perform(key: string, action: () => void | Promise<void>): Promise<void> {
    const context = this.contextKey;
    this.pendingActions = new Set([...this.pendingActions, key]);
    try { await action(); }
    catch (error) { this.onActionError(error); }
    finally {
      const next = new Set(this.pendingActions);
      next.delete(key);
      this.pendingActions = next;
      await this.updateComplete;
      if (this.pendingFocus?.contextKey === context && this.pendingFocus.actionKey === key) {
        this.recoverFocus(true);
        this.pendingFocus = undefined;
      }
    }
  }

  private prepareFocus(pending: PendingFocus): void {
    if (this.shadowRoot?.activeElement === null) return;
    this.pendingFocus = pending;
    this.retainedEmptyContext = this.contextKey;
  }

  private readonly handleDocumentFocusIn = (event: FocusEvent): void => {
    // Disabling a focused action can blur it before the user moves elsewhere,
    // so the area's own focusout alone cannot detect that later focus choice.
    if (event.target === this.ownerDocument.body || event.target === this.ownerDocument.documentElement) return;
    this.pendingFocus = undefined;
    if (!event.composedPath().includes(this)) this.retainedEmptyContext = undefined;
  };

  private readonly handleFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && this.renderRoot.contains(next)) return;
    // A removed focused row has no next target. Wait for updated() to recover it.
    if (next === null && this.pendingFocus !== undefined) return;
    this.pendingFocus = undefined;
    this.retainedEmptyContext = undefined;
  };

  private row(id: string): HTMLElement | undefined {
    return Array.from(this.renderRoot.querySelectorAll<HTMLElement>("[data-notification-id]"))
      .find((element) => element.dataset["notificationId"] === id);
  }

  private recoverFocus(force = false): void {
    const pending = this.pendingFocus;
    if (pending?.contextKey !== this.contextKey) return;
    if (!force && pending.removedId !== undefined && this.items.some((item) => item.id === pending.removedId)) return;
    this.pendingFocus = undefined;
    if (pending.removedId !== undefined && this.items.some((item) => item.id === pending.removedId)) {
      const row = this.row(pending.removedId);
      const button = pending.buttonSelector === undefined ? undefined : row?.querySelector<HTMLElement>(pending.buttonSelector);
      (button ?? row)?.focus();
      return;
    }
    const adjacent = pending.adjacentIds.map((id) => this.row(id)).find((element) => element !== undefined);
    (adjacent ?? this.renderRoot.querySelector<HTMLElement>("[data-notification-focus='header']"))?.focus();
  }

  static override styles = [uiButtonStyles, uiToolbarStyles, sessionNotificationTrayStyles];
}

declare global {
  interface HTMLElementTagNameMap { "notification-area": NotificationArea; }
}
