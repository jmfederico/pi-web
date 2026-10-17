import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { SessionActivity, SessionInfo, SessionStatus } from "../api";
import { isCachedNewSessionInfo } from "../cachedNewSessions";
import { shortSessionId } from "../sessionLabels";
import type { SessionLabelItem } from "../plugins/types";
import { renderSessionLabelItems } from "./sessionLabel";
import { isArchivableSessionInfo, isTransientNewSessionInfo } from "../sessionPersistence";
import { normalizeSessionPath } from "../sessionPaths";
import { isSessionActive } from "../../../shared/activity";
import { CORE_STATUS_FLAGS, type StatusFlags } from "../../../shared/machineStatus";
import { ActionMenuPositionController } from "./actionMenu";
import { renderActionActivityIndicator, type ActivityIndicatorKind } from "./activityBadge";
import type { KeyboardNavigableSection } from "./navigationFocus";
import { activateSelectableRow, focusSelectedOrFirstSelectableRow, handleSelectableRowKeyboard } from "./selectableRow";
import { listStyles, scrollBoundaryShadow } from "./shared";
import { sidebarListStyles } from "./sidebarListStyles";

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
interface AgentAttention {
  kind: ActivityIndicatorKind | undefined;
  unread: boolean;
}

@customElement("session-list")
export class SessionList extends LitElement implements KeyboardNavigableSection {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) sessions: SessionInfo[] = [];
  @property({ attribute: false }) pinnedRootIds: string[] = [];
  @property({ attribute: false }) onPin?: (session: SessionInfo) => void;
  @property({ attribute: false }) onUnpin?: (session: SessionInfo) => void;
  @property({ attribute: false }) onMovePin?: (session: SessionInfo, direction: -1 | 1) => void;
  @property({ attribute: false }) statuses: Record<string, SessionStatus> = {};
  @property({ attribute: false }) activities: Record<string, SessionActivity> = {};
  // Undefined is an older daemon; an empty map is an authoritative idle snapshot.
  @property({ attribute: false }) sessionFlags: Readonly<Record<string, StatusFlags>> | undefined;
  @property({ attribute: false }) sending: Record<string, true> = {};
  @property({ attribute: false }) unreadSessionIds: ReadonlySet<string> = new Set();
  @property({ attribute: false }) selected?: SessionInfo;
  @property({ attribute: false }) sessionLabelItems: (session: SessionInfo) => SessionLabelItem[] = () => [];
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
  private readonly menuPosition = new ActionMenuPositionController(this, () => {
    if (this.openMenuSessionId === undefined) return undefined;
    const row = [...this.renderRoot.querySelectorAll<HTMLElement>("[data-session-id]")].find((item) => item.dataset["sessionId"] === this.openMenuSessionId);
    return row?.querySelector<HTMLElement>(".action-menu-toggle") ?? undefined;
  });
  @state() private archivedExpanded = false;
  @state() private selectionScopes: ReadonlySet<SessionSelectionScope> = new Set();
  @state() private selectedSessionIds: ReadonlySet<string> = new Set();
  @state() private expandedAgentParents: ReadonlySet<string> = new Set();

  private agentAttentionCache?: {
    rows: readonly SessionRow[];
    statuses: SessionList["statuses"];
    activities: SessionList["activities"];
    sessionFlags: SessionList["sessionFlags"];
    sending: SessionList["sending"];
    unreadSessionIds: SessionList["unreadSessionIds"];
    attention: ReadonlyMap<string, AgentAttention>;
  };

  private visibleTreeCache?: {
    tree: NonNullable<SessionList["treeCache"]>;
    expanded: ReadonlySet<string>;
    pins: string[];
    pinnedRootIds: string[];
    pinnedRowCount: number;
    currentAgentOffsets: ReadonlyMap<string, number>;
    archivedAgentOffsets: ReadonlyMap<string, number>;
    currentRows: SessionRow[];
    currentSelectableSessions: SessionInfo[];
    archivedRows: SessionRow[];
    archivedSessions: SessionInfo[];
  };

  // Sessions are replaced on refresh; transient UI state must not rebuild the tree.
  private treeCache?: {
    sessions: SessionInfo[];
    currentRows: SessionRow[];
    currentSelectableSessions: SessionInfo[];
    archivedRows: SessionRow[];
    archivedSessions: SessionInfo[];
    currentAgentGroups: AgentSessionGroups;
    archivedAgentGroups: AgentSessionGroups;
    descendantCounts?: Map<string, number>;
  };

  private sessionTree() {
    if (this.treeCache?.sessions !== this.sessions) {
      const currentRows = sessionRowsForCurrentTree(this.sessions);
      const currentRowIds = new Set(currentRows.map((row) => row.session.id));
      const archivedRows = sessionRows(this.sessions
        .filter((session) => session.archived === true && !currentRowIds.has(session.id))
        .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified)));
      this.treeCache = {
        sessions: this.sessions,
        currentRows,
        currentSelectableSessions: currentRows.map((row) => row.session).filter((session) => sessionSelectionScope(session) === "current"),
        archivedRows,
        archivedSessions: archivedRows.map((row) => row.session),
        currentAgentGroups: agentSessionGroups(currentRows),
        archivedAgentGroups: agentSessionGroups(archivedRows),
      };
    }
    return this.treeCache;
  }

  private visibleSessionTree() {
    const tree = this.sessionTree();
    if (this.visibleTreeCache?.tree !== tree || this.visibleTreeCache.expanded !== this.expandedAgentParents || this.visibleTreeCache.pins !== this.pinnedRootIds) {
      const projection = pinnedSessionRows(visibleAgentSessionRows(tree.currentRows, this.expandedAgentParents, tree.currentAgentGroups), this.pinnedRootIds);
      const currentRows = projection.rows;
      const archivedRows = visibleAgentSessionRows(tree.archivedRows, this.expandedAgentParents, tree.archivedAgentGroups);
      this.visibleTreeCache = {
        tree, expanded: this.expandedAgentParents, pins: this.pinnedRootIds,
        pinnedRootIds: projection.pinnedRootIds, pinnedRowCount: projection.pinnedRowCount, currentRows, archivedRows,
        currentAgentOffsets: agentChildOffsets(currentRows, tree.currentAgentGroups),
        archivedAgentOffsets: agentChildOffsets(archivedRows, tree.archivedAgentGroups),
        currentSelectableSessions: currentRows.map((row) => row.session).filter((session) => sessionSelectionScope(session) === "current"),
        archivedSessions: archivedRows.map((row) => row.session),
      };
    }
    return this.visibleTreeCache;
  }

  /** Use the candidate tree, not potentially stale rendered rows after a mutation. */
  automaticSessionCandidates(sessions: SessionInfo[]): SessionInfo[] {
    return sessionNavigationCandidates(sessions, {
      collapsed: this.collapsed,
      expandedAgentParents: this.expandedAgentParents,
      archivedExpanded: this.archivedExpanded,
    });
  }

  private agentGroupAttention(rows: readonly SessionRow[], groups: AgentSessionGroups): ReadonlyMap<string, AgentAttention> {
    const cached = this.agentAttentionCache;
    if (cached?.rows === rows && cached.statuses === this.statuses && cached.activities === this.activities
      && cached.sessionFlags === this.sessionFlags && cached.sending === this.sending && cached.unreadSessionIds === this.unreadSessionIds) return cached.attention;
    const attention = new Map<string, AgentAttention>();
    // Parent-first tree order lets nested agent activity roll up in one reverse pass.
    // User/unknown children are always visible and do not contribute to these chips.
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index];
      if (row === undefined) continue;
      const { session } = row;
      const parentId = groups.parentByAgentId.get(session.id);
      if (parentId === undefined) continue;
      const nested = attention.get(session.id);
      const parent = attention.get(parentId);
      const ownKind = sessionRowActivityKind(session, this.statuses[session.id], this.activities[session.id], this.sending[session.id] === true, this.sessionFlags);
      const kind = ownKind === "sending" || nested?.kind === "sending" || parent?.kind === "sending"
        ? "sending" : ownKind ?? nested?.kind ?? parent?.kind;
      const unread = sessionRowUnread(session, this.unreadSessionIds) || nested?.unread === true || parent?.unread === true;
      if (kind !== undefined || unread) attention.set(parentId, { kind, unread });
    }
    this.agentAttentionCache = {
      rows, statuses: this.statuses, activities: this.activities, sessionFlags: this.sessionFlags, sending: this.sending,
      unreadSessionIds: this.unreadSessionIds, attention,
    };
    return attention;
  }

  private revealSelectedAgentRow(): boolean {
    if (this.selected === undefined) return false;
    const tree = this.sessionTree();
    const groups = tree.currentRows.some((row) => row.session.id === this.selected?.id) ? tree.currentAgentGroups : tree.archivedAgentGroups;
    const expanded = new Set(this.expandedAgentParents);
    const seen = new Set<string>();
    let id: string | undefined = this.selected.id;
    while (id !== undefined && !seen.has(id)) {
      seen.add(id);
      id = groups.parentByAgentId.get(id);
      if (id !== undefined) expanded.add(id);
    }
    if (expanded.size === this.expandedAgentParents.size) return false;
    this.expandedAgentParents = expanded;
    return true;
  }

  private toggleAgentParent(parentId: string): void {
    const expanded = new Set(this.expandedAgentParents);
    if (expanded.has(parentId)) expanded.delete(parentId);
    else expanded.add(parentId);
    this.expandedAgentParents = expanded;
    if (!expanded.has(parentId)) this.selectedSessionIds = this.includeCollapsedChildren(this.selectedSessionIds);
    this.openMenuSessionId = undefined;
  }

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

  private focusedSessionId: string | undefined;
  private focusedPinRowId: string | undefined;
  private focusedMenuControl: HTMLElement | undefined;
  private menuFocusAfterReorder: HTMLElement | undefined;

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("pinnedRootIds")) {
      this.focusedPinRowId = this.focusedSessionId;
      this.menuFocusAfterReorder = this.focusedMenuControl;
    }
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("pinnedRootIds") && this.focusedPinRowId !== undefined) {
      const row = [...this.renderRoot.querySelectorAll<HTMLElement>(".action-row")].find((item) => item.dataset["sessionId"] === this.focusedPinRowId);
      row?.focus({ preventScroll: true });
      this.focusedPinRowId = undefined;
    }
    if (changed.has("pinnedRootIds") && this.menuFocusAfterReorder?.isConnected === true) {
      const control = this.menuFocusAfterReorder;
      const target = control instanceof HTMLButtonElement && control.disabled
        ? control.closest(".action-menu-panel")?.querySelector<HTMLElement>("button[data-pin-move]:not(:disabled)")
        : control;
      target?.focus({ preventScroll: true });
    }
    this.menuFocusAfterReorder = undefined;
    if (changed.has("sessions")) {
      if (this.openMenuSessionId !== undefined && !this.sessions.some((session) => session.id === this.openMenuSessionId)) this.openMenuSessionId = undefined;
      if (!this.sessions.some((session) => session.archived === true)) this.archivedExpanded = false;
      this.pruneSelectedSessionIds();
    }
    if (changed.has("collapsed") && this.collapsed) this.openMenuSessionId = undefined;
    const previousSelected = changed.get("selected");
    const selectionNavigated = changed.has("selected") && (previousSelected?.id !== this.selected?.id || (previousSelected?.archived === true && this.selected?.archived !== true));
    const agentRevealed = selectionNavigated && this.revealSelectedAgentRow();
    if (changed.has("selected") && this.selected?.archived === true && (previousSelected?.id !== this.selected.id || previousSelected.archived !== true) && !this.archivedExpanded) {
      this.archivedExpanded = true;
      void this.updateComplete.then(() => { this.scrollSelectedIntoView(); });
      return;
    }
    if (agentRevealed) {
      void this.updateComplete.then(() => { this.scrollSelectedIntoView(); });
    } else if (this.shouldRevealSelectedRow(changed)) this.scrollSelectedIntoView();
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
    const tree = this.sessionTree();
    const { currentRows, archivedRows, currentAgentOffsets, archivedAgentOffsets, pinnedRowCount } = this.visibleSessionTree();
    // The collapsed heading still needs tree counts, but never descendant actions.
    if (!this.collapsed) tree.descendantCounts ??= unarchivedDescendantCounts(this.sessions);
    const descendantCounts = tree.descendantCounts;
    const unreadCount = unreadSessionCount(tree.currentSelectableSessions, this.unreadSessionIds);
    const needsAgentAttention = !this.collapsed && currentRows.some(({ session }) =>
      tree.currentAgentGroups.countByParentId.has(session.id) && !this.expandedAgentParents.has(session.id));
    const agentAttention = needsAgentAttention ? this.agentGroupAttention(tree.currentRows, tree.currentAgentGroups) : undefined;
    return html`
      <section>
        ${this.renderHeading(tree.currentRows.length + tree.archivedRows.length, tree.currentSelectableSessions, unreadCount)}
        ${this.collapsed ? null : html`
          <div class="list-body">
            ${this.renderCurrentSelectionToolbar(tree.currentSelectableSessions)}
            ${this.startingCount > 0 ? this.renderStartingSession() : null}
            ${pinnedRowCount > 0 ? html`<h2 class="subheading pin-heading">Pinned</h2>` : null}
            ${repeat(currentRows, (row) => row.session.id, (row, index) => html`
              ${pinnedRowCount > 0 && index === pinnedRowCount ? html`<h2 class="subheading pin-heading">Recent</h2>` : null}
              ${this.renderSession(row, "current", tree.currentAgentGroups.countByParentId.get(row.session.id) ?? 0, currentAgentOffsets.get(row.session.id) ?? 0, agentAttention?.get(row.session.id))}
            `)}
            ${pinnedRowCount > 0 && pinnedRowCount === currentRows.length ? html`<h2 class="subheading pin-heading">Recent</h2>` : null}
            ${tree.archivedRows.length > 0 ? html`
              ${this.renderArchivedHeading(tree.archivedRows.length)}
              ${this.archivedExpanded ? html`
                ${this.renderArchivedSelectionToolbar(tree.archivedSessions)}
                ${repeat(archivedRows, (row) => row.session.id, (row) => this.renderSession(row, "archived", tree.archivedAgentGroups.countByParentId.get(row.session.id) ?? 0, archivedAgentOffsets.get(row.session.id) ?? 0))}
              ` : null}
            ` : null}
          </div>
          ${this.renderOpenSessionMenu(descendantCounts)}
        `}
      </section>
    `;
  }

  private renderHeading(sessionCount: number, currentSessions: SessionInfo[], unreadCount: number) {
    if (!this.collapsible) {
      return html`
        <h2 class="ui-toolbar">
          <span class="ui-toolbar-title plain-heading">Sessions</span>
          <span class="ui-toolbar-group">
            ${this.renderUnreadCount(unreadCount)}
            ${this.renderCurrentSelectionButton(currentSessions)}
            ${this.renderCleanupButton()}
            ${this.renderStartButton()}
          </span>
        </h2>
      `;
    }
    const selectedSummary = this.selected === undefined ? "No session selected" : sessionLabel(this.selected);
    const selectedTitle = this.selected?.path ?? selectedSummary;
    return html`
      <h2 class="ui-toolbar">
        <button class="ui-button ui-toolbar-title section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} Sessions</span>${this.collapsed ? html`<small class="section-selected" dir="auto" title=${selectedTitle}>${selectedSummary}</small>` : null}</span></button>
        <span class="ui-toolbar-group">
          ${this.renderUnreadCount(unreadCount)}
          ${this.renderCurrentSelectionButton(currentSessions)}
          <small class="section-count">${sessionCount}</small>
          ${this.renderCleanupButton()}
          ${this.renderStartButton()}
        </span>
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
    return html`<button class="ui-button ui-button--icon bulk-select-entry ${active ? "selected" : ""}" title=${active ? "Close current session selection" : "Select current sessions"} aria-label=${active ? "Close current session selection" : "Select current sessions"} aria-expanded=${String(active)} aria-pressed=${String(active)} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleSelection("current"); }}>☑</button>`;
  }

  private renderCleanupButton() {
    return html`<button class="ui-button cleanup-entry" title="Preview session cleanup" @click=${(event: MouseEvent) => { event.stopPropagation(); this.onCleanup?.(); }}>Clean up</button>`;
  }

  private renderStartButton() {
    const title = this.startingCount > 0 ? "Start another session" : "Start a new session";
    return html`<button class="ui-button ui-button--icon start-session-button" title=${title} aria-label=${title} ?disabled=${!this.canStart} @click=${(event: MouseEvent) => { event.stopPropagation(); this.onStart?.(); }}>+</button>`;
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

  private renderArchivedHeading(sessionCount: number) {
    const active = this.selectionScopes.has("archived");
    return html`
      <h2 class="ui-toolbar subheading">
        <button class="ui-button ui-toolbar-title section-toggle" aria-expanded=${String(this.archivedExpanded)} @click=${() => { this.toggleArchived(); }}><span>${this.archivedExpanded ? "▾" : "▸"} Archived</span></button>
        <span class="ui-toolbar-group">
          ${this.archivedExpanded ? html`<button class="ui-button ui-button--icon bulk-select-entry ${active ? "selected" : ""}" title=${active ? "Close archived session selection" : "Select archived sessions"} aria-label=${active ? "Close archived session selection" : "Select archived sessions"} aria-expanded=${String(active)} aria-pressed=${String(active)} @click=${() => { this.toggleSelection("archived"); }}>☑</button>` : null}
          <small class="section-count">${sessionCount}</small>
        </span>
      </h2>
    `;
  }

  private renderCurrentSelectionToolbar(sessions: SessionInfo[]) {
    if (sessions.length === 0 || !this.selectionScopes.has("current")) return null;

    const selectedSessions = this.selectedSessions("current");
    const archivableSessions = selectedSessions.filter((session) => isArchivableSessionInfo(session, this.statuses[session.id]));
    const unreadSelectedSessions = selectedSessions.filter((session) => this.unreadSessionIds.has(session.id));
    return html`
      <div class="selection-toolbar">
        <div class="ui-toolbar bulk-row selecting">
          ${this.renderSelectionControls("current")}
          <div class="ui-toolbar-group bulk-actions">
            <button class="ui-button" ?disabled=${archivableSessions.length === 0} @click=${() => { this.archiveSelectedCurrent(); }}>Archive</button>
            <button class="ui-button" ?disabled=${unreadSelectedSessions.length === 0} @click=${() => { this.markSelectedCurrentRead(); }}>Mark read</button>
          </div>
        </div>
      </div>
    `;
  }

  private renderArchivedSelectionToolbar(sessions: SessionInfo[]) {
    if (sessions.length === 0 || !this.selectionScopes.has("archived")) return null;

    const selectedSessions = this.selectedSessions("archived");
    return html`
      <div class="selection-toolbar">
        <div class="ui-toolbar bulk-row selecting">
          ${this.renderSelectionControls("archived")}
          <div class="ui-toolbar-group bulk-actions">
            <button class="ui-button danger" title="Permanently delete selected archived sessions" ?disabled=${selectedSessions.length === 0} @click=${() => { this.confirmDeleteSelectedArchived(); }}>Delete</button>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Shared selection toggle for both scopes. The toggle is binary: an empty
   * selection offers to select every session in the section, and any existing
   * selection offers to clear the whole scope. The selected count stays inside
   * the clear action so it cannot become a separate wrapping flex item.
   * Selection mode itself is exited from the same ☑ heading button that opened
   * it, so the toolbar carries no separate Done or Clear buttons.
   */
  private renderSelectionControls(scope: SessionSelectionScope) {
    const selectedCount = this.selectedSessions(scope).length;
    return selectedCount === 0
      ? html`<button class="ui-button" @click=${() => { this.selectAllSessions(scope); }}>Select all</button>`
      : html`<button class="ui-button" @click=${() => { this.clearSelection(scope); }}>Clear selected (${selectedCount})</button>`;
  }

  private renderSession(row: SessionRow, scope: SessionSelectionScope, agentChildCount: number, agentOffset: number, agentAttention?: AgentAttention) {
    const { session } = row;
    const linkedAgentChild = agentOffset > 0;
    const cappedDepth = Math.min(row.depth, 2);
    const canBulkSelect = sessionSelectionScope(session) === scope;
    const selectionActive = this.selectionScopes.has(scope);
    const showsCheckbox = selectionActive && canBulkSelect;
    const bulkSelected = showsCheckbox && this.selectedSessionIds.has(session.id);
    const status = this.statuses[session.id];
    const activity = this.activities[session.id];
    const indicatorKind = sessionRowActivityKind(session, status, activity, this.sending[session.id] === true, this.sessionFlags);
    const unread = sessionRowUnread(session, this.unreadSessionIds);
    const labelItems = this.sessionLabelItems(session);
    return html`
      <div
        class="action-row ${this.selected?.id === session.id ? "selected" : ""} ${bulkSelected ? "bulk-selected" : ""} ${session.archived === true ? "archived" : ""} ${selectionActive ? "selecting" : ""} ${unread ? "unread" : ""} ${agentChildCount > 0 ? "has-agent-subsessions" : ""} ${linkedAgentChild ? "linked-agent-child" : ""}"
        style=${`--depth:${String(cappedDepth)};--agent-offset:${String(agentOffset)}px`}
        tabindex="0"
        data-session-id=${session.id}
        title=${session.path}
        @focusin=${() => { this.focusedSessionId = session.id; }}
        @focusout=${() => { this.focusedSessionId = undefined; }}
        @click=${(event: MouseEvent) => { activateSelectableRow(event, () => { this.activateSessionRow(session, scope); }); }}
        @keydown=${(event: KeyboardEvent) => { this.handleSessionKeydown(event, session, scope); }}
      >
        <div class="action-main ${selectionActive ? "selecting" : ""}">
          ${showsCheckbox ? html`<input class="session-checkbox" type="checkbox" aria-label=${`Select ${sessionLabel(session)}`} .checked=${bulkSelected} @click=${(event: MouseEvent) => { event.stopPropagation(); }} @change=${() => { this.toggleSelected(session.id); }}>` : null}
          <span class="action-name-line"><span class="action-name" dir="auto" title=${sessionLabel(session)}>${this.renderRowMarker(row)}${sessionLabel(session)}</span>${this.renderRowBadges(row)}</span>
          <small class="session-secondary"><span class="session-meta">${this.renderSessionMetaPrefix(session, status, activity)}${String(session.messageCount)} messages</span>${labelItems.length === 0 ? null : html`<span class="session-label-separator" aria-hidden="true">·</span><span class="session-labels">${renderSessionLabelItems(labelItems)}</span>`}</small>
          ${this.renderActivity(indicatorKind, unread)}
        </div>
        <div class="action-menu">
          <button class="ui-button ui-button--icon action-menu-toggle" title="Session actions" @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(session.id); }}>⋯</button>
        </div>
      </div>
      ${agentChildCount > 0 ? html`<button class="agent-subsession-toggle" style=${`--depth:${String(cappedDepth)};--agent-offset:${String(agentOffset)}px`} aria-expanded=${String(this.expandedAgentParents.has(session.id))} @click=${() => { this.toggleAgentParent(session.id); }}><span class="agent-subsession-label">${this.expandedAgentParents.has(session.id) ? "▾" : "▸"} Agent subsessions (${agentChildCount})</span>${!this.expandedAgentParents.has(session.id) && agentAttention !== undefined ? renderActionActivityIndicator(agentAttention.kind, agentAttention.kind === "sending" ? "Sending subsession message" : "Agent subsessions active", agentAttention.unread ? "Unread subsession activity" : undefined) : null}</button>` : null}
    `;
  }

  private renderOpenSessionMenu(descendantCounts: ReadonlyMap<string, number> | undefined) {
    if (this.openMenuSessionId === undefined) return null;
    const { currentRows, archivedRows } = this.visibleSessionTree();
    const row = currentRows.find((candidate) => candidate.session.id === this.openMenuSessionId)
      ?? (this.archivedExpanded ? archivedRows.find((candidate) => candidate.session.id === this.openMenuSessionId) : undefined);
    if (row === undefined) return null;
    const { session } = row;
    const status = this.statuses[session.id];
    const canArchive = isArchivableSessionInfo(session, status);
    const isWorking = sessionRowActivityKind(session, status, this.activities[session.id], false, this.sessionFlags) === "session";
    const canDeleteTransient = isTransientNewSessionInfo(session, status);
    const descendantCount = descendantCounts?.get(session.id) ?? 0;
    // Fixed overlays are siblings of the isolated scroller, not trapped in its paint context.
    return html`
      <div class="action-menu-panel ui-menu" style=${this.menuPosition.style}
        @focusin=${(event: FocusEvent) => { this.focusedMenuControl = event.target instanceof HTMLElement ? event.target : undefined; }}
        @focusout=${() => { this.focusedMenuControl = undefined; }}
      >
        ${this.renderPinActions(row)}
        ${session.archived === true
          ? html`
            <button class="ui-button ui-menu-item" title="Restore session" @click=${() => { this.openMenuSessionId = undefined; this.onRestore?.(session); }}>Restore</button>
            <button class="danger ui-button ui-menu-item" title="Permanently delete archived session" @click=${() => { this.openMenuSessionId = undefined; this.confirmDeleteArchived(session); }}>Delete archived session</button>
          `
          : canDeleteTransient
            ? html`<button class="ui-button ui-menu-item" title="Delete transient new session" @click=${() => { this.openMenuSessionId = undefined; this.onDelete?.(session); }}>Delete</button>`
            : html`
              ${this.unreadSessionIds.has(session.id) ? html`<button class="ui-button ui-menu-item" title="Mark session as read" @click=${() => { this.openMenuSessionId = undefined; this.onMarkRead?.(session); }}>Mark as read</button>` : null}
              ${canArchive ? html`
                <button class="ui-button ui-menu-item" title="Archive session" @click=${() => { this.openMenuSessionId = undefined; this.onArchive?.(session); }}>Archive</button>
                ${descendantCount > 0 ? html`<button class="ui-button ui-menu-item" title="Archive this session and its descendants" @click=${() => { this.openMenuSessionId = undefined; this.confirmArchiveWithDescendants(session, descendantCount); }}>Archive with descendants (${descendantCount})</button>` : null}
              ` : null}
              ${session.parentSessionPath !== undefined ? html`<button class="ui-button ui-menu-item" title="Detach from parent" @click=${() => { this.openMenuSessionId = undefined; this.onDetachParent?.(session); }}>Detach from parent</button>` : null}
              ${canArchive ? html`<button class="ui-button ui-menu-item" title=${isWorking ? "Stop current session activity before reloading from disk" : "Reload session from disk without refreshing Pi runtime resources"} ?disabled=${isWorking} @click=${() => { this.openMenuSessionId = undefined; this.onReload?.(session); }}>Reload from disk</button>` : null}
            `}
      </div>
    `;
  }

  private renderPinActions(row: SessionRow) {
    if (!isPinnableRoot(row)) return null;
    const { session } = row;
    const pins = this.visibleSessionTree().pinnedRootIds;
    const index = pins.indexOf(session.id);
    if (index < 0) return html`<button class="ui-button ui-menu-item" @click=${() => { this.changePin(session, () => this.onPin?.(session)); }}>Pin session</button>`;
    return html`
      <button class="ui-button ui-menu-item" @click=${() => { this.changePin(session, () => this.onUnpin?.(session)); }}>Unpin session</button>
      <button class="ui-button ui-menu-item" data-pin-move ?disabled=${index === 0} @click=${() => { this.onMovePin?.(session, -1); }}>Move up</button>
      <button class="ui-button ui-menu-item" data-pin-move ?disabled=${index === pins.length - 1} @click=${() => { this.onMovePin?.(session, 1); }}>Move down</button>
    `;
  }

  private changePin(session: SessionInfo, action: () => void): void {
    this.openMenuSessionId = undefined;
    action();
    void this.updateComplete.then(() => {
      const row = [...this.renderRoot.querySelectorAll<HTMLElement>(".action-row")].find((item) => item.dataset["sessionId"] === session.id);
      row?.focus({ preventScroll: true });
    });
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

  private toggleSelection(scope: SessionSelectionScope): void {
    if (this.selectionScopes.has(scope)) {
      this.closeSelection(scope);
      return;
    }
    this.startSelection(scope);
  }

  private startSelection(scope: SessionSelectionScope): void {
    this.selectionScopes = new Set([...this.selectionScopes, scope]);
    const visible = this.visibleSessionTree();
    const visibleSessions = scope === "current" ? visible.currentSelectableSessions : visible.archivedSessions;
    const onlyVisibleSession = visibleSessions.length === 1 ? visibleSessions[0] : undefined;
    if (onlyVisibleSession !== undefined) this.selectedSessionIds = this.includeCollapsedChildren(new Set([...this.selectedSessionIds, onlyVisibleSession.id]));
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
    const group = this.includeCollapsedChildren(new Set([sessionId]));
    const selected = this.selectedSessionIds.has(sessionId);
    const next = new Set(this.selectedSessionIds);
    for (const id of group) {
      if (selected) next.delete(id);
      else next.add(id);
    }
    this.selectedSessionIds = next;
  }

  /** Materialize hidden children so counts, bulk actions, and later expansion agree. */
  private includeCollapsedChildren(sessionIds: ReadonlySet<string>): ReadonlySet<string> {
    if (sessionIds.size === 0) return sessionIds;
    const tree = this.sessionTree();
    const visible = this.visibleSessionTree();
    const scopeById = new Map(this.sessions.map((session) => [session.id, sessionSelectionScope(session)]));
    const next = new Set(sessionIds);
    for (const scope of ["current", "archived"] as const) {
      const inherited = new Set([...sessionIds].filter((id) => scopeById.get(id) === scope));
      if (inherited.size === 0) continue;
      for (const [rows, visibleRows, groups] of [
        [tree.currentRows, visible.currentRows, tree.currentAgentGroups],
        [tree.archivedRows, visible.archivedRows, tree.archivedAgentGroups],
      ] as const) {
        const visibleIds = new Set(visibleRows.map((row) => row.session.id));
        // Parent-first order includes nested hidden groups even if their own toggle is expanded.
        for (const { session } of rows) {
          const parentId = groups.parentByAgentId.get(session.id);
          if (parentId === undefined || visibleIds.has(session.id) || !inherited.has(parentId)) continue;
          // Carry inheritance through mixed archive states without selecting outside the scope.
          inherited.add(session.id);
          if (sessionSelectionScope(session) === scope) next.add(session.id);
        }
      }
    }
    return next.size === sessionIds.size ? sessionIds : next;
  }

  private selectAllSessions(scope: SessionSelectionScope): void {
    const tree = this.sessionTree();
    const sessions = scope === "current" ? tree.currentSelectableSessions : tree.archivedSessions;
    this.selectedSessionIds = new Set([...this.selectedSessionIds, ...sessions.map((session) => session.id)]);
  }

  private selectedSessions(scope: SessionSelectionScope): SessionInfo[] {
    return this.sessions.filter((session) => this.selectedSessionIds.has(session.id) && sessionSelectionScope(session) === scope);
  }

  private pruneSelectedSessionIds(): void {
    const existing = new Set(this.sessions.map((session) => session.id));
    const next = new Set([...this.selectedSessionIds].filter((sessionId) => existing.has(sessionId)));
    if (next.size !== this.selectedSessionIds.size) this.selectedSessionIds = next;
    this.selectedSessionIds = this.includeCollapsedChildren(this.selectedSessionIds);
    if (this.selectionScopes.has("archived") && !this.sessions.some((session) => session.archived === true)) this.closeSelection("archived");
    if (this.selectionScopes.has("current") && !this.sessions.some((session) => session.archived !== true)) this.closeSelection("current");
  }

  private toggleMenu(sessionId: string) {
    if (this.openMenuSessionId === sessionId) {
      this.openMenuSessionId = undefined;
      return;
    }
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

  static override styles = [listStyles, sidebarListStyles, css`
    /* Keep positioned/animated session content in the scroller's paint hierarchy. */
    .list-body { isolation: isolate; }
    .subheading.ui-toolbar { margin-top: 0; }
    h2 .section-count, h2 .section-unread-count { flex: 0 0 auto; align-self: center; padding-inline: 6px; display: inline; color: var(--pi-muted); font-size: inherit; }
    h2 .section-unread-count { color: var(--pi-accent); text-transform: none; }
    .bulk-row { flex-wrap: wrap; }
    .bulk-row button { white-space: nowrap; }
    .bulk-actions { margin-left: auto; }
    .action-name, .section-selected { text-align: start; unicode-bidi: plaintext; }
    .action-name { display: block; max-height: none; line-height: normal; white-space: nowrap; text-overflow: ellipsis; }
    .action-row.unread .action-name { color: var(--pi-text-bright); font-weight: 650; }
    .plain-heading { align-self: center; padding: 6px 10px; }
    .session-secondary { display: flex; align-items: baseline; gap: 5px; min-width: 0; margin-top: 3px; }
    .session-meta, .session-label-separator { flex: 0 0 auto; }
    .session-labels { min-width: 0; display: inline-flex; align-items: baseline; gap: 5px; max-width: 100%; overflow: hidden; white-space: nowrap; }
    .session-label-item, .session-label-render { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    a.session-label-item { color: var(--pi-accent); text-decoration: none; }
    a.session-label-item:hover, a.session-label-item:focus { text-decoration: underline; }
    .session-label-render > * { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .action-name-line { min-width: 0; display: flex; align-items: flex-start; gap: 6px; }
    .action-name-line .action-name { flex: 1 1 auto; min-width: 0; }
    /* Badges must not sit inside the line-clamped title, or a long name hides them entirely. */
    .row-badges { flex: 0 0 auto; display: flex; align-items: flex-start; gap: 4px; }
    .row-badges .badge { margin-left: 0; white-space: nowrap; }
    /* Same glyph as a normal child marker, dimmed: the row is a child whose parent is not displayed here. */
    .orphan-marker { color: var(--pi-dim); opacity: .65; }
    .selection-toolbar { position: sticky; top: 0; z-index: 4; background: var(--pi-bg); border-bottom: 1px solid var(--pi-border-muted); box-shadow: ${scrollBoundaryShadow}; }
    .action-row.bulk-selected { box-shadow: inset 3px 0 0 var(--pi-accent); }
    .pending-session-row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); margin: 0; padding: 3px 10px; cursor: default; }
    .pending-session-row.starting-session .action-main { border-radius: 0; border-style: dashed; border-color: var(--pi-border); color: var(--pi-muted); }
    .pending-session-row.starting-session .action-name { display: flex; align-items: center; gap: 6px; max-height: none; -webkit-line-clamp: 1; }
    .pending-session-row.starting-session .activity-indicator { flex: 0 0 auto; margin: 0; }
    .action-main.selecting, .action-row.linked-agent-child .action-main.selecting { padding-left: calc(48px + var(--depth, 0) * 16px + var(--agent-offset, 0px)); }
    .action-row.has-agent-subsessions { margin-bottom: 0; border-bottom: 0; }
    .action-row.has-agent-subsessions .action-main { padding-bottom: 6px; }
    /* Secondary desktop disclosures stay compact; indentation remains inside the click target. */
    .agent-subsession-toggle { position: relative; display: flex; align-items: center; gap: 6px; box-sizing: border-box; width: 100%; min-height: 28px; margin: 0; padding: 4px 16px 4px calc(35px + var(--agent-offset, 0px) + var(--depth, 0) * 16px); border: 0; border-radius: 0; background: transparent; font: 12px/20px var(--pi-font, system-ui, sans-serif); text-align: left; color: var(--pi-muted); overflow: hidden; }
    .agent-subsession-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent-subsession-toggle::before { content: ""; position: absolute; top: 0; bottom: 50%; left: calc(19px + var(--agent-offset, 0px) + var(--depth, 0) * 16px); width: 10px; border-left: 1px solid var(--pi-border-muted); border-bottom: 1px solid var(--pi-border-muted); pointer-events: none; }
    .agent-subsession-toggle .action-activity { pointer-events: none; }
    /* The disclosure closes a collapsed group; an expanded group's final row owns its separator. */
    .agent-subsession-toggle[aria-expanded="false"]:not(:last-child) { box-shadow: inset 0 -1px var(--pi-border-muted); }
    .agent-subsession-toggle[aria-expanded="true"] { color: var(--pi-accent); }
    .action-row.linked-agent-child .action-main { padding-left: calc(19px + var(--agent-offset) + var(--depth, 0) * 16px); }
    @media (pointer: coarse) {
      .agent-subsession-toggle { min-height: 44px; padding-block: 12px; }
    }
    .agent-subsession-toggle:hover, .agent-subsession-toggle:focus-visible { color: var(--pi-text); background: var(--pi-surface-hover); }
    .agent-subsession-toggle:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    .session-checkbox { position: absolute; top: 9px; left: calc(24px + var(--depth, 0) * 16px + var(--agent-offset, 0px)); z-index: 2; margin: 0; }
  `];
}

function isPinnableRoot(row: SessionRow): boolean {
  return row.depth === 0 && !row.hasMissingParent && row.session.parentSessionPath === undefined && row.session.archived !== true;
}

/** Move complete root trees, leaving their descendants and the unpinned order intact. */
export function pinnedSessionRows(rows: readonly SessionRow[], pinIds: readonly string[]): {
  rows: SessionRow[];
  pinnedRootIds: string[];
  pinnedRowCount: number;
} {
  const trees: SessionRow[][] = [];
  for (const row of rows) {
    if (row.depth === 0 || trees.length === 0) trees.push([]);
    trees[trees.length - 1]?.push(row);
  }
  const eligible = new Map(trees.flatMap((tree) => {
    const root = tree[0];
    return root !== undefined && isPinnableRoot(root) ? [[root.session.id, tree] as const] : [];
  }));
  const pinnedRootIds = [...new Set(pinIds)].filter((id) => eligible.has(id));
  const pinned = new Set(pinnedRootIds);
  const pinnedRows = pinnedRootIds.flatMap((id) => eligible.get(id) ?? []);
  return {
    rows: [...pinnedRows, ...trees.filter((tree) => !pinned.has(tree[0]?.session.id ?? "")).flat()],
    pinnedRootIds,
    pinnedRowCount: pinnedRows.length,
  };
}

/** Match the parent's chip inset on both sides, including nested groups. */
export function agentChildOffsets(rows: readonly SessionRow[], groups: AgentSessionGroups): ReadonlyMap<string, number> {
  const offsets = new Map<string, number>();
  for (const { session } of rows) {
    const parent = groups.parentByAgentId.get(session.id);
    if (parent !== undefined) offsets.set(session.id, (offsets.get(parent) ?? 0) + 12);
  }
  return offsets;
}

export interface AgentSessionGroups {
  parentByAgentId: ReadonlyMap<string, string>;
  countByParentId: ReadonlyMap<string, number>;
}

/** Only verified direct children with a parent in this section may be hidden. */
export function agentSessionGroups(rows: readonly SessionRow[]): AgentSessionGroups {
  const byPath = sessionsByNormalizedPath(rows.map((row) => row.session));
  const parentByAgentId = new Map<string, string>();
  const countByParentId = new Map<string, number>();
  for (const { session } of rows) {
    if (session.agentSubsession !== true || session.parentSessionPath === undefined) continue;
    const parent = byPath.get(normalizeSessionPath(session.parentSessionPath));
    if (parent === undefined || parent.id === session.id) continue;
    parentByAgentId.set(session.id, parent.id);
    countByParentId.set(parent.id, (countByParentId.get(parent.id) ?? 0) + 1);
  }
  return { parentByAgentId, countByParentId };
}

/**
 * Trees are in parent-first order. Hidden agent ancestors hide agent children,
 * but never user/unknown children: those remain reachable, with their own toggle.
 * Orphans have no group and remain visible rather than losing their reveal control.
 */
/** Before the list mounts, groups have their default collapsed state. */
export function sessionNavigationCandidates(sessions: SessionInfo[], options: {
  collapsed?: boolean;
  expandedAgentParents?: ReadonlySet<string>;
  archivedExpanded?: boolean;
} = {}): SessionInfo[] {
  if (options.collapsed === true) return [];
  const expanded = options.expandedAgentParents ?? new Set<string>();
  const currentRows = sessionRowsForCurrentTree(sessions);
  const visibleIds = new Set(visibleAgentSessionRows(currentRows, expanded).map((row) => row.session.id));
  if (options.archivedExpanded === true) {
    const currentIds = new Set(currentRows.map((row) => row.session.id));
    const archivedRows = sessionRows(sessions.filter((session) => session.archived === true && !currentIds.has(session.id)));
    for (const row of visibleAgentSessionRows(archivedRows, expanded)) visibleIds.add(row.session.id);
  }
  return sessions.filter((session) => visibleIds.has(session.id));
}

export function visibleAgentSessionRows(
  rows: readonly SessionRow[],
  expandedParents: ReadonlySet<string>,
  groups: AgentSessionGroups = agentSessionGroups(rows),
): SessionRow[] {
  const hidden = new Set<string>();
  return rows.filter((row) => {
    const parentId = groups.parentByAgentId.get(row.session.id);
    if (parentId === undefined) return true;
    if (!hidden.has(parentId) && expandedParents.has(parentId)) return true;
    hidden.add(row.session.id);
    return false;
  });
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
  sessionFlags?: Readonly<Record<string, StatusFlags>>,
): ActivityIndicatorKind | undefined {
  if (isCachedNewSessionInfo(session) || session.archived === true) return undefined;
  if (sending) return "sending";
  // The complete daemon projection owns navigation activity. Live chat events
  // are only a compatibility fallback, not a second writer of this state.
  const working = sessionFlags === undefined
    ? isSessionActive(status, activity)
    : sessionFlags[session.id]?.[CORE_STATUS_FLAGS.working] === true;
  if (working) return "session";
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

  // Keep the chip's agent children together before user/unknown siblings,
  // preserving the listing order within each group and among root sessions.
  for (const children of childrenByPath.values()) {
    children.sort((a, b) => Number(b.agentSubsession === true) - Number(a.agentSubsession === true));
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
