import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionActivity, SessionInfo, SessionStatus } from "../api";
import { isCachedNewSessionInfo } from "../cachedNewSessions";
import { shortSessionId } from "../sessionLabels";
import { isArchivableSessionInfo, isTransientNewSessionInfo } from "../sessionPersistence";
import { normalizeSessionPath } from "../sessionPaths";
import { isSessionActive } from "../../../shared/activity";
import { actionMenuPanelStyle } from "./actionMenu";
import { renderActionActivityIndicator, type ActivityIndicatorKind } from "./activityBadge";
import type { KeyboardNavigableSection } from "./navigationFocus";
import { activateSelectableRow, focusSelectedOrFirstSelectableRow, handleSelectableRowKeyboard } from "./selectableRow";
import { listStyles, scrollBoundaryShadow } from "./shared";

/**
 * An orphan row is a session whose recorded parent is not in this listing.
 * Session trees are worktree-scoped, so there is no location to offer: the row
 * only states that the parent is not shown here.
 */
const ORPHAN_PARENT_LABEL = "parent unavailable";
const ORPHAN_PARENT_TITLE = "Parent session is not available in this workspace";

function sessionLabel(session: SessionInfo): string {
  if (session.name !== undefined && session.name !== "") return session.name;
  return session.firstMessage !== "" ? session.firstMessage : shortSessionId(session.id);
}

export interface SessionRow {
  session: SessionInfo;
  depth: number;
  hasMissingParent: boolean;
}

type SessionSelectionScope = "current" | "archived";

@customElement("session-list")
export class SessionList extends LitElement implements KeyboardNavigableSection {
  @property({ attribute: false }) sessions: SessionInfo[] = [];
  @property({ attribute: false }) statuses: Record<string, SessionStatus> = {};
  @property({ attribute: false }) activities: Record<string, SessionActivity> = {};
  @property({ attribute: false }) sending: Record<string, true> = {};
  @property({ attribute: false }) unreadSessionIds: ReadonlySet<string> = new Set();
  @property({ attribute: false }) selected?: SessionInfo;
  @property({ type: Number }) startingCount = 0;
  @property({ type: Boolean }) canStart = false;
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ attribute: false }) onSelect?: (session: SessionInfo) => void;
  @property({ attribute: false }) onStart?: () => void;
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @property({ attribute: false }) onArchivedCollapsed?: () => void;
  @property({ attribute: false }) onFocusPreviousSection?: () => void | Promise<void>;
  @property({ attribute: false }) onFocusNextSection?: () => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;
  @property({ attribute: false }) onArchive?: (session: SessionInfo) => void;
  @property({ attribute: false }) onArchiveWithDescendants?: (session: SessionInfo) => void;
  @property({ attribute: false }) onArchiveMany?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onRestore?: (session: SessionInfo) => void;
  @property({ attribute: false }) onDelete?: (session: SessionInfo) => void;
  @property({ attribute: false }) onDeleteArchived?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onDeleteArchivedMany?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onDetachParent?: (session: SessionInfo) => void;
  @property({ attribute: false }) onMarkRead?: (session: SessionInfo) => void;
  @property({ attribute: false }) onMarkReadMany?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onReload?: (session: SessionInfo) => void;
  @property({ attribute: false }) onCleanup?: () => void;

  @state() private openMenuSessionId: string | undefined;
  @state() private menuStyle = "";
  @state() private archivedExpanded = false;
  @state() private selectionScopes: ReadonlySet<SessionSelectionScope> = new Set();
  @state() private selectedSessionIds: ReadonlySet<string> = new Set();

  private readonly onDocumentClick = (event: MouseEvent) => {
    if (event.composedPath().includes(this)) return;
    this.openMenuSessionId = undefined;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onDocumentClick);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.onDocumentClick);
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("sessions")) {
      if (this.openMenuSessionId !== undefined && !this.sessions.some((session) => session.id === this.openMenuSessionId)) this.openMenuSessionId = undefined;
      if (!this.sessions.some((session) => session.archived === true)) this.archivedExpanded = false;
      this.pruneSelectedSessionIds();
    }
    if (changed.has("collapsed") && this.collapsed) this.openMenuSessionId = undefined;
    const previousSelected = changed.get("selected");
    if (changed.has("selected") && this.selected?.archived === true && (previousSelected?.id !== this.selected.id || previousSelected.archived !== true) && !this.archivedExpanded) {
      this.archivedExpanded = true;
      void this.updateComplete.then(() => { this.scrollSelectedIntoView(); });
      return;
    }
    if (this.shouldRevealSelectedRow(changed)) this.scrollSelectedIntoView();
  }

  /**
   * Positive reveal triggers only: live data refreshes replace `sessions` and
   * `selected` with same-id objects (status churn, renames, archive flips) and
   * must never re-scroll. Reveal the selected row only when the selection
   * moves to a different row (first render with a selection included), when a
   * restore moves it from the archived section back to the current section
   * (same id, archived flag cleared), or when the section expands.
   */
  private shouldRevealSelectedRow(changed: PropertyValues<this>): boolean {
    if (this.collapsed) return false;
    if (changed.has("collapsed")) return true;
    if (!changed.has("selected")) return false;
    const previousSelected = changed.get("selected");
    if (previousSelected?.id !== this.selected?.id) return true;
    return previousSelected?.archived === true && this.selected?.archived !== true;
  }

  async focusSelectedOrFirst(): Promise<boolean> {
    await this.updateComplete;
    return focusSelectedOrFirstSelectableRow(this.renderRoot, { fallbackSelector: ".section-toggle, h2 button:not([disabled])" });
  }

  override render() {
    const currentRows = sessionRowsForCurrentTree(this.sessions);
    const currentRowIds = new Set(currentRows.map((row) => row.session.id));
    const currentSelectableSessions = currentRows.map((row) => row.session).filter((session) => sessionSelectionScope(session) === "current");
    const archivedRows = sessionRows(this.sessions.filter((session) => session.archived === true && !currentRowIds.has(session.id)));
    const descendantCounts = unarchivedDescendantCounts(this.sessions);
    const unreadCount = unreadSessionCount(currentSelectableSessions, this.unreadSessionIds);
    return html`
      <section>
        ${this.renderHeading(currentRows.length + archivedRows.length, currentSelectableSessions, unreadCount)}
        ${this.collapsed ? null : html`
          <div class="list-body">
            ${this.renderCurrentSelectionToolbar(currentSelectableSessions)}
            ${this.startingCount > 0 ? this.renderStartingSession() : null}
            ${currentRows.map((row) => this.renderSession(row, descendantCounts.get(row.session.id) ?? 0, "current"))}
            ${archivedRows.length > 0 ? html`
              ${this.renderArchivedHeading(archivedRows.map((row) => row.session))}
              ${this.archivedExpanded ? html`
                ${this.renderArchivedSelectionToolbar(archivedRows.map((row) => row.session))}
                ${archivedRows.map((row) => this.renderSession(row, descendantCounts.get(row.session.id) ?? 0, "archived"))}
              ` : null}
            ` : null}
          </div>
        `}
      </section>
    `;
  }

  private renderHeading(sessionCount: number, currentSessions: SessionInfo[], unreadCount: number) {
    if (!this.collapsible) {
      return html`
        <h2>
          <span class="plain-heading">Sessions</span>
          ${this.renderCurrentSelectionButton(currentSessions)}
          ${this.renderUnreadCount(unreadCount)}
          ${this.renderCleanupButton()}
          ${this.renderStartButton()}
        </h2>
      `;
    }
    const selectedSummary = this.selected === undefined ? "No session selected" : sessionLabel(this.selected);
    const selectedTitle = this.selected?.path ?? selectedSummary;
    return html`
      <h2>
        <button class="section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} Sessions</span>${this.collapsed ? html`<small class="section-selected" dir="auto" title=${selectedTitle}>${selectedSummary}</small>` : null}</span></button>
        ${this.renderCurrentSelectionButton(currentSessions)}
        ${this.renderUnreadCount(unreadCount)}
        <small class="section-count">${sessionCount}</small>
        ${this.renderCleanupButton()}
        ${this.renderStartButton()}
      </h2>
    `;
  }

  private renderUnreadCount(unreadCount: number) {
    if (unreadCount === 0) return null;
    const label = `${String(unreadCount)} unread`;
    return html`<small class="section-unread-count" title=${label}>${label}</small>`;
  }

  private renderCurrentSelectionButton(currentSessions: SessionInfo[]) {
    if (this.collapsed || currentSessions.length === 0) return null;
    const active = this.selectionScopes.has("current");
    return html`<button class="bulk-select-entry ${active ? "selected" : ""}" title=${active ? "Close current session selection" : "Select current sessions"} aria-label=${active ? "Close current session selection" : "Select current sessions"} aria-expanded=${String(active)} aria-pressed=${String(active)} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleSelection("current", currentSessions); }}>☑</button>`;
  }

  private renderCleanupButton() {
    return html`<button class="cleanup-entry" title="Preview session cleanup" @click=${(event: MouseEvent) => { event.stopPropagation(); this.onCleanup?.(); }}>Clean up</button>`;
  }

  private renderStartButton() {
    const title = this.startingCount > 0 ? "Start another session" : "Start a new session";
    return html`<button class="start-session-button" title=${title} aria-label=${title} ?disabled=${!this.canStart} @click=${(event: MouseEvent) => { event.stopPropagation(); this.onStart?.(); }}>+</button>`;
  }

  private renderStartingSession() {
    const plural = this.startingCount !== 1;
    return html`
      <div class="pending-session-row starting-session" role="status" aria-live="polite">
        <div class="action-main">
          <span class="action-name"><span class="activity-indicator sending" aria-hidden="true"></span>${plural ? `Starting ${String(this.startingCount)} sessions…` : "Starting session…"}</span>
          <small>Waiting for ${plural ? "new sessions" : "the new session"} to be created</small>
        </div>
      </div>
    `;
  }

  private renderArchivedHeading(archivedSessions: SessionInfo[]) {
    const active = this.selectionScopes.has("archived");
    return html`
      <h2 class="subheading">
        <button class="section-toggle" aria-expanded=${String(this.archivedExpanded)} @click=${() => { this.toggleArchived(); }}><span>${this.archivedExpanded ? "▾" : "▸"} Archived</span></button>
        ${this.archivedExpanded ? html`<button class="bulk-select-entry ${active ? "selected" : ""}" title=${active ? "Close archived session selection" : "Select archived sessions"} aria-label=${active ? "Close archived session selection" : "Select archived sessions"} aria-expanded=${String(active)} aria-pressed=${String(active)} @click=${() => { this.toggleSelection("archived", archivedSessions); }}>☑</button>` : null}
        <small class="section-count">${archivedSessions.length}</small>
      </h2>
    `;
  }

  private renderCurrentSelectionToolbar(visibleSessions: SessionInfo[]) {
    if (visibleSessions.length === 0 || !this.selectionScopes.has("current")) return null;

    const selectedSessions = this.selectedSessions("current");
    const archivableSessions = selectedSessions.filter((session) => isArchivableSessionInfo(session, this.statuses[session.id]));
    const unreadSelectedSessions = selectedSessions.filter((session) => this.unreadSessionIds.has(session.id));
    return html`
      <div class="selection-toolbar">
        <div class="bulk-row selecting">
          ${this.renderSelectionControls("current", visibleSessions)}
          <div class="bulk-actions">
            <button ?disabled=${archivableSessions.length === 0} @click=${() => { this.archiveSelectedCurrent(); }}>Archive</button>
            <button ?disabled=${unreadSelectedSessions.length === 0} @click=${() => { this.markSelectedCurrentRead(); }}>Mark read</button>
          </div>
        </div>
      </div>
    `;
  }

  private renderArchivedSelectionToolbar(visibleSessions: SessionInfo[]) {
    if (visibleSessions.length === 0 || !this.selectionScopes.has("archived")) return null;

    const selectedSessions = this.selectedSessions("archived");
    return html`
      <div class="selection-toolbar">
        <div class="bulk-row selecting">
          ${this.renderSelectionControls("archived", visibleSessions)}
          <div class="bulk-actions">
            <button class="danger" title="Permanently delete selected archived sessions" ?disabled=${selectedSessions.length === 0} @click=${() => { this.confirmDeleteSelectedArchived(); }}>Delete</button>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Shared selection toggle for both scopes. The toggle is binary: an empty
   * selection offers to select every visible session, and any existing
   * selection offers to clear the whole scope. The selected count stays inside
   * the clear action so it cannot become a separate wrapping flex item.
   * Selection mode itself is exited from the same ☑ heading button that opened
   * it, so the toolbar carries no separate Done or Clear buttons.
   */
  private renderSelectionControls(scope: SessionSelectionScope, visibleSessions: SessionInfo[]) {
    const selectedCount = this.selectedSessions(scope).length;
    return selectedCount === 0
      ? html`<button @click=${() => { this.selectVisibleSessions(visibleSessions); }}>Select visible</button>`
      : html`<button @click=${() => { this.clearSelection(scope); }}>Clear selected (${selectedCount})</button>`;
  }

  private renderSession(row: SessionRow, descendantCount: number, scope: SessionSelectionScope) {
    const { session } = row;
    const cappedDepth = Math.min(row.depth, 2);
    const canBulkSelect = sessionSelectionScope(session) === scope;
    const selectionActive = this.selectionScopes.has(scope);
    const showsCheckbox = selectionActive && canBulkSelect;
    const bulkSelected = showsCheckbox && this.selectedSessionIds.has(session.id);
    const status = this.statuses[session.id];
    const activity = this.activities[session.id];
    const indicatorKind = sessionRowActivityKind(session, status, activity, this.sending[session.id] === true);
    const unread = sessionRowUnread(session, this.unreadSessionIds);
    const canArchive = isArchivableSessionInfo(session, status);
    const canDeleteTransient = isTransientNewSessionInfo(session, status);
    return html`
      <div
        class="action-row ${this.selected?.id === session.id ? "selected" : ""} ${bulkSelected ? "bulk-selected" : ""} ${session.archived === true ? "archived" : ""} ${selectionActive ? "selecting" : ""} ${unread ? "unread" : ""}"
        style=${`--depth:${String(cappedDepth)}`}
        tabindex="0"
        title=${session.path}
        @click=${(event: MouseEvent) => { activateSelectableRow(event, () => { this.activateSessionRow(session, scope); }); }}
        @keydown=${(event: KeyboardEvent) => { this.handleSessionKeydown(event, session, scope); }}
      >
        <div class="action-main ${selectionActive ? "selecting" : ""}">
          ${showsCheckbox ? html`<input class="session-checkbox" type="checkbox" aria-label=${`Select ${sessionLabel(session)}`} .checked=${bulkSelected} @click=${(event: MouseEvent) => { event.stopPropagation(); }} @change=${() => { this.toggleSelected(session.id); }}>` : null}
          <span class="action-name-line"><span class="action-name" dir="auto">${this.renderRowMarker(row)}${sessionLabel(session)}</span>${this.renderRowBadges(row)}</span><small>${this.renderSessionMetaPrefix(session, status, activity)}${String(session.messageCount)} messages</small>
          ${this.renderActivity(indicatorKind, unread)}
        </div>
        <div class="action-menu">
          <button class="action-menu-toggle" title="Session actions" @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(session.id, event.currentTarget); }}>⋯</button>
          ${this.openMenuSessionId === session.id ? html`
            <div class="action-menu-panel" style=${this.menuStyle}>
              ${session.archived === true
                ? html`
                  <button title="Restore session" @click=${() => { this.openMenuSessionId = undefined; this.onRestore?.(session); }}>Restore</button>
                  <button class="danger" title="Permanently delete archived session" @click=${() => { this.openMenuSessionId = undefined; this.confirmDeleteArchived(session); }}>Delete archived session</button>
                `
                : canDeleteTransient
                  ? html`<button title="Delete transient new session" @click=${() => { this.openMenuSessionId = undefined; this.onDelete?.(session); }}>Delete</button>`
                  : html`
                    ${this.unreadSessionIds.has(session.id) ? html`<button title="Mark session as read" @click=${() => { this.openMenuSessionId = undefined; this.onMarkRead?.(session); }}>Mark as read</button>` : null}
                    ${canArchive ? html`
                      <button title="Archive session" @click=${() => { this.openMenuSessionId = undefined; this.onArchive?.(session); }}>Archive</button>
                      ${descendantCount > 0 ? html`<button title="Archive this session and its descendants" @click=${() => { this.openMenuSessionId = undefined; this.confirmArchiveWithDescendants(session, descendantCount); }}>Archive with descendants (${descendantCount})</button>` : null}
                    ` : null}
                    ${session.parentSessionPath !== undefined ? html`<button title="Detach from parent" @click=${() => { this.openMenuSessionId = undefined; this.onDetachParent?.(session); }}>Detach from parent</button>` : null}
                    ${canArchive ? html`<button title=${isSessionActive(this.statuses[session.id], this.activities[session.id]) ? "Stop current session activity before reloading from disk" : "Reload session from disk without refreshing Pi runtime resources"} ?disabled=${isSessionActive(this.statuses[session.id], this.activities[session.id])} @click=${() => { this.openMenuSessionId = undefined; this.onReload?.(session); }}>Reload from disk</button>` : null}
                  `}
            </div>
          ` : null}
        </div>
      </div>
    `;
  }

  /**
   * Leading marker stating that the row is a child of another session. Orphan
   * children (a recorded parent that is not in this list) render at depth 0 and
   * would otherwise look like roots, so they keep the same child glyph, dimmed
   * to signal that the parent itself is not shown here.
   */
  private renderRowMarker(row: SessionRow) {
    if (row.hasMissingParent) {
      return html`<span class="tree-marker orphan-marker" title=${ORPHAN_PARENT_TITLE} aria-label=${ORPHAN_PARENT_LABEL}>↳</span>`;
    }
    return row.depth > 0 ? html`<span class="tree-marker">↳</span>` : null;
  }

  /**
   * Badges live outside `.action-name` so the clamped, ellipsizing title cannot
   * hide them.
   */
  private renderRowBadges(row: SessionRow) {
    if (row.depth <= 2) return null;
    return html`<span class="row-badges"><span class="badge">depth ${row.depth}</span></span>`;
  }

  private handleSessionKeydown(event: KeyboardEvent, session: SessionInfo, scope: SessionSelectionScope): void {
    handleSelectableRowKeyboard(event, {
      activate: () => { this.activateSessionRow(session, scope); },
      previousSection: this.onFocusPreviousSection === undefined ? undefined : () => { void this.onFocusPreviousSection?.(); },
      nextSection: this.onFocusNextSection === undefined ? undefined : () => { void this.onFocusNextSection?.(); },
      cancel: this.onCancelKeyboardNavigation === undefined ? undefined : () => { void this.onCancelKeyboardNavigation?.(); },
    });
  }

  private activateSessionRow(session: SessionInfo, scope: SessionSelectionScope): void {
    if (this.selectionScopes.has(scope) && sessionSelectionScope(session) === scope) {
      this.toggleSelected(session.id);
      return;
    }
    this.onSelect?.(session);
  }

  private confirmArchiveWithDescendants(session: SessionInfo, descendantCount: number): void {
    const noun = descendantCount === 1 ? "descendant session" : "descendant sessions";
    if (confirm(`Archive “${sessionLabel(session)}” and ${String(descendantCount)} ${noun}?`)) this.onArchiveWithDescendants?.(session);
  }

  private confirmDeleteArchived(session: SessionInfo): void {
    if (confirm(`Permanently delete archived session “${sessionLabel(session)}”? This cannot be undone.`)) void this.onDeleteArchived?.(session);
  }

  private confirmDeleteSelectedArchived(): void {
    const archived = this.selectedSessions("archived");
    if (archived.length === 0) return;
    const noun = archived.length === 1 ? "archived session" : "archived sessions";
    if (!confirm(`Permanently delete ${String(archived.length)} selected ${noun}? This cannot be undone.`)) return;
    this.selectedSessionIds = removeSessionIds(this.selectedSessionIds, archived.map((session) => session.id));
    void this.onDeleteArchivedMany?.(archived);
  }

  private markSelectedCurrentRead(): void {
    const unreadSelected = this.selectedSessions("current").filter((session) => this.unreadSessionIds.has(session.id));
    if (unreadSelected.length === 0) return;
    void this.onMarkReadMany?.(unreadSelected);
  }

  private archiveSelectedCurrent(): void {
    const sessions = this.selectedSessions("current").filter((session) => isArchivableSessionInfo(session, this.statuses[session.id]));
    this.selectedSessionIds = removeSessionIds(this.selectedSessionIds, sessions.map((session) => session.id));
    void this.onArchiveMany?.(sessions);
  }

  private toggleSelection(scope: SessionSelectionScope, visibleSessions: SessionInfo[]): void {
    if (this.selectionScopes.has(scope)) {
      this.closeSelection(scope);
      return;
    }
    this.startSelection(scope, visibleSessions);
  }

  private startSelection(scope: SessionSelectionScope, visibleSessions: SessionInfo[]): void {
    this.selectionScopes = new Set([...this.selectionScopes, scope]);
    const onlyVisibleSession = visibleSessions.length === 1 ? visibleSessions[0] : undefined;
    if (onlyVisibleSession !== undefined) this.selectedSessionIds = new Set([...this.selectedSessionIds, onlyVisibleSession.id]);
  }

  private closeSelection(scope: SessionSelectionScope): void {
    this.selectionScopes = new Set([...this.selectionScopes].filter((candidate) => candidate !== scope));
    this.clearSelection(scope);
  }

  private clearSelection(scope: SessionSelectionScope): void {
    const sessionIds = this.sessions.filter((session) => sessionSelectionScope(session) === scope).map((session) => session.id);
    this.selectedSessionIds = removeSessionIds(this.selectedSessionIds, sessionIds);
  }

  private toggleSelected(sessionId: string): void {
    const next = new Set(this.selectedSessionIds);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    this.selectedSessionIds = next;
  }

  private selectVisibleSessions(sessions: SessionInfo[]): void {
    this.selectedSessionIds = new Set([...this.selectedSessionIds, ...sessions.map((session) => session.id)]);
  }

  private selectedSessions(scope: SessionSelectionScope): SessionInfo[] {
    return this.sessions.filter((session) => this.selectedSessionIds.has(session.id) && sessionSelectionScope(session) === scope);
  }

  private pruneSelectedSessionIds(): void {
    const existing = new Set(this.sessions.map((session) => session.id));
    const next = new Set([...this.selectedSessionIds].filter((sessionId) => existing.has(sessionId)));
    if (next.size !== this.selectedSessionIds.size) this.selectedSessionIds = next;
    if (this.selectionScopes.has("archived") && !this.sessions.some((session) => session.archived === true)) this.closeSelection("archived");
    if (this.selectionScopes.has("current") && !this.sessions.some((session) => session.archived !== true)) this.closeSelection("current");
  }

  private toggleMenu(sessionId: string, target: EventTarget | null) {
    if (this.openMenuSessionId === sessionId) {
      this.openMenuSessionId = undefined;
      return;
    }
    this.menuStyle = actionMenuPanelStyle(target, { constrainTo: "viewport" });
    this.openMenuSessionId = sessionId;
  }

  private toggleArchived() {
    this.archivedExpanded = !this.archivedExpanded;
    if (!this.archivedExpanded) {
      this.openMenuSessionId = undefined;
      if (this.selectionScopes.has("archived")) this.closeSelection("archived");
      this.onArchivedCollapsed?.();
    }
  }

  private scrollSelectedIntoView(): void {
    this.renderRoot.querySelector<HTMLElement>(".action-row.selected")?.scrollIntoView({ block: "nearest" });
  }

  private renderSessionMetaPrefix(session: SessionInfo, status: SessionStatus | undefined, activity: SessionActivity | undefined) {
    if (isTransientNewSessionInfo(session, status)) {
      if (activity?.phase === "active") return "creating · ";
      if (activity?.phase === "error") return "error · ";
      return "new · ";
    }
    if (session.archived === true) return "read-only · ";
    return "";
  }

  private renderActivity(kind: ActivityIndicatorKind | undefined, unread: boolean) {
    const label = kind === "sending" ? "Sending message" : "Session active";
    return renderActionActivityIndicator(kind, label, unread ? "Unread session activity" : undefined);
  }

  static override styles = [listStyles, css`
    h2 { min-height: 30px; }
    h2 > .section-count { flex: 0 0 auto; display: inline; color: var(--pi-muted); font-size: inherit; }
    h2 > .section-unread-count { flex: 0 0 auto; display: inline; color: var(--pi-accent); font-size: inherit; text-transform: none; }
    .bulk-select-entry { box-sizing: border-box; flex: 0 0 auto; display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 0; font-size: 13px; line-height: 1; text-transform: none; }
    .start-session-button { box-sizing: border-box; flex: 0 0 auto; display: inline-grid; place-items: center; min-width: 30px; height: 30px; padding: 0 9px; }
    .cleanup-entry { flex: 0 0 auto; padding: 5px 7px; font-size: 12px; text-transform: none; }
    .bulk-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 0 6px; }
    .bulk-row button { padding: 5px 7px; font-size: 12px; white-space: nowrap; }
    .bulk-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; margin-left: auto; }
    .action-name, .section-selected { text-align: start; unicode-bidi: plaintext; }
    .action-row.unread .action-name { color: var(--pi-text-bright); font-weight: 650; }
    .plain-heading { min-width: 0; }
    .action-name-line { min-width: 0; display: flex; align-items: flex-start; gap: 6px; }
    .action-name-line .action-name { flex: 1 1 auto; min-width: 0; }
    /* Badges must not sit inside the line-clamped title, or a long name hides them entirely. */
    .row-badges { flex: 0 0 auto; display: flex; align-items: flex-start; gap: 4px; }
    .row-badges .badge { margin-left: 0; white-space: nowrap; }
    /* Same glyph as a normal child marker, dimmed: the row is a child whose parent is not displayed here. */
    .orphan-marker { color: var(--pi-dim); opacity: .65; }
    .selection-toolbar { position: sticky; top: 0; z-index: 4; }
    .selection-toolbar::before { content: ""; position: absolute; top: 0; right: 0; left: 0; z-index: 0; height: 8px; background: var(--pi-bg); pointer-events: none; }
    .selection-toolbar .bulk-row.selecting { position: relative; z-index: 1; margin-bottom: 0; padding: 6px; border: 1px solid var(--pi-border-muted); border-radius: 8px; background: var(--pi-surface); box-shadow: ${scrollBoundaryShadow}; }
    button.danger, .action-menu-panel button.danger { color: var(--pi-danger); }
    button.danger:hover, .action-menu-panel button.danger:hover { background: color-mix(in srgb, var(--pi-danger) 14%, transparent); }
    .action-row.bulk-selected .action-main { border-color: var(--pi-accent); box-shadow: inset 3px 0 0 var(--pi-accent); }
    .pending-session-row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); margin: 6px 0; cursor: default; }
    .pending-session-row.starting-session .action-main { border-radius: 8px; border-style: dashed; color: var(--pi-muted); }
    .pending-session-row.starting-session .action-name { display: flex; align-items: center; gap: 6px; max-height: none; -webkit-line-clamp: 1; }
    .pending-session-row.starting-session .activity-indicator { flex: 0 0 auto; margin: 0; }
    .action-main.selecting { padding-left: calc(32px + var(--depth, 0) * 16px); }
    .session-checkbox { position: absolute; top: 9px; left: calc(8px + var(--depth, 0) * 16px); z-index: 2; margin: 0; }
  `];
}

export function unreadSessionCount(
  sessions: readonly SessionInfo[],
  unreadSessionIds: ReadonlySet<string>,
): number {
  return sessions.filter((session) => sessionRowUnread(session, unreadSessionIds)).length;
}

function sessionSelectionScope(session: SessionInfo): SessionSelectionScope {
  return session.archived === true ? "archived" : "current";
}

function removeSessionIds(sessionIds: ReadonlySet<string>, removedIds: readonly string[]): ReadonlySet<string> {
  const removed = new Set(removedIds);
  return new Set([...sessionIds].filter((sessionId) => !removed.has(sessionId)));
}

function unarchivedDescendantCounts(sessions: SessionInfo[]): Map<string, number> {
  const childrenByParentPath = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    if (session.parentSessionPath === undefined) continue;
    const parentKey = normalizeSessionPath(session.parentSessionPath);
    const children = childrenByParentPath.get(parentKey) ?? [];
    children.push(session);
    childrenByParentPath.set(parentKey, children);
  }

  const countFor = (session: SessionInfo, seenPaths: Set<string>): number => {
    const sessionKey = normalizeSessionPath(session.path);
    if (seenPaths.has(sessionKey)) return 0;
    const nextSeenPaths = new Set(seenPaths);
    nextSeenPaths.add(sessionKey);
    let count = 0;
    for (const child of childrenByParentPath.get(sessionKey) ?? []) {
      if (nextSeenPaths.has(normalizeSessionPath(child.path))) continue;
      if (child.archived !== true) count += 1;
      count += countFor(child, nextSeenPaths);
    }
    return count;
  };

  return new Map(sessions.map((session) => [session.id, countFor(session, new Set())]));
}

/**
 * Resolve the activity indicator kind for a session row, or undefined when the
 * row should show no work dot. Pure so it can be unit-tested without rendering.
 *
 * "sending" (client-side upload in flight) is reported with its own kind, and
 * takes precedence over server activity, so it can be colored distinctly to
 * signal that it is not yet propagated to workspace/machine activity. Unread
 * is not a kind: it is an attention flag resolved by `sessionRowUnread` and
 * rendered as a ring around this dot (or a filled dot when this is undefined).
 */
export function sessionRowActivityKind(
  session: SessionInfo,
  status: SessionStatus | undefined,
  activity: SessionActivity | undefined,
  sending: boolean,
): ActivityIndicatorKind | undefined {
  if (isCachedNewSessionInfo(session) || session.archived === true) return undefined;
  if (sending) return "sending";
  if (isSessionActive(status, activity)) return "session";
  return undefined;
}

/**
 * Whether a session row carries the unread attention flag. Cached-new and
 * archived sessions can never be unread: they have no server-side unread
 * completions to acknowledge.
 */
export function sessionRowUnread(session: SessionInfo, unreadSessionIds: ReadonlySet<string>): boolean {
  if (isCachedNewSessionInfo(session) || session.archived === true) return false;
  return unreadSessionIds.has(session.id);
}

/**
 * Index sessions by their normalized path. Parent links can arrive from a
 * different server producer than the listing itself (a `session.created`
 * broadcast carries the live runtime's file path), so keys are normalized to
 * keep tree building from silently missing a link.
 */
function sessionsByNormalizedPath(sessions: readonly SessionInfo[]): Map<string, SessionInfo> {
  return new Map(sessions.map((session) => [normalizeSessionPath(session.path), session]));
}

export function sessionRowsForCurrentTree(sessions: SessionInfo[]): SessionRow[] {
  const byPath = sessionsByNormalizedPath(sessions);
  const visible = new Set<string>();
  for (const session of sessions) {
    if (session.archived === true) continue;
    visible.add(session.id);
    let parentKey = session.parentSessionPath === undefined ? undefined : normalizeSessionPath(session.parentSessionPath);
    const seenPaths = new Set<string>([normalizeSessionPath(session.path)]);
    while (parentKey !== undefined && !seenPaths.has(parentKey)) {
      seenPaths.add(parentKey);
      const parent = byPath.get(parentKey);
      if (parent === undefined) break;
      visible.add(parent.id);
      parentKey = parent.parentSessionPath === undefined ? undefined : normalizeSessionPath(parent.parentSessionPath);
    }
  }
  return sessionRows(sessions.filter((session) => visible.has(session.id)));
}

function sessionRows(sessions: SessionInfo[]): SessionRow[] {
  const byPath = sessionsByNormalizedPath(sessions);
  const childrenByPath = new Map<string, SessionInfo[]>();
  const roots: SessionInfo[] = [];
  for (const session of sessions) {
    const parentPath = session.parentSessionPath;
    const parent = parentPath === undefined ? undefined : byPath.get(normalizeSessionPath(parentPath));
    if (parent === undefined) {
      roots.push(session);
      continue;
    }
    const parentKey = normalizeSessionPath(parent.path);
    const children = childrenByPath.get(parentKey) ?? [];
    children.push(session);
    childrenByPath.set(parentKey, children);
  }

  const rows: SessionRow[] = [];
  const visit = (session: SessionInfo, depth: number, stack: Set<string>) => {
    const sessionKey = normalizeSessionPath(session.path);
    if (stack.has(sessionKey)) return;
    const parentPath = session.parentSessionPath;
    rows.push({ session, depth, hasMissingParent: parentPath !== undefined && !byPath.has(normalizeSessionPath(parentPath)) });
    const nextStack = new Set(stack);
    nextStack.add(sessionKey);
    for (const child of childrenByPath.get(sessionKey) ?? []) visit(child, depth + 1, nextStack);
  };
  for (const root of roots) visit(root, 0, new Set());
  return rows;
}
