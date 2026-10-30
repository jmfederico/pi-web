import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
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
import { createActionMenuController } from "./actionMenu";
import { interventionRequiredLabel, renderActionActivityIndicator, type ActivityIndicatorKind } from "./activityBadge";
import type { KeyboardNavigableSection } from "./navigationFocus";
import { activateSelectableRow, focusSelectedOrFirstSelectableRow, handleSelectableRowKeyboard } from "./selectableRow";
import { listStyles, scrollBoundaryShadow } from "./shared";
import { sidebarListStyles } from "./sidebarListStyles";
import { localization, LocalizationController } from "../localization/browser";
import definitions from "./sessionNavigation.messages";

export const sessionNavigationMessages = localization.registerMessages("core.sessionNavigation", definitions);

function sessionMenuId(sessionId: string): string {
  return `session-menu-${encodeURIComponent(sessionId)}`;
}

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
    new LocalizationController(this);
  }

  @property({ attribute: false }) sessions: SessionInfo[] = [];
  @property({ type: Boolean }) loading = false;
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
  @property({ attribute: false }) onMarkUnread?: (session: SessionInfo) => void;
  @property({ attribute: false }) onMarkReadMany?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onReload?: (session: SessionInfo) => void;
  @property({ attribute: false }) onCleanup?: () => void;

  @state() private openMenuSessionId: string | undefined;
  readonly actionMenu = createActionMenuController(this, () => {
    if (this.openMenuSessionId === undefined) return undefined;
    const row = [...this.renderRoot.querySelectorAll<HTMLElement>("[data-session-id]")].find((item) => item.dataset["sessionId"] === this.openMenuSessionId);
    return row?.querySelector<HTMLElement>(".action-menu-toggle") ?? undefined;
  }, () => { this.openMenuSessionId = undefined; });
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

  private autoExpandedForSelection = false;

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
      const kinds = [ownKind, nested?.kind, parent?.kind];
      const kind = kinds.includes("intervention-required") ? "intervention-required"
        : kinds.includes("sending") ? "sending" : ownKind ?? nested?.kind ?? parent?.kind;
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


  private focusedSessionId: string | undefined;
  private focusedPinRowId: string | undefined;
  private focusedMenuControl: HTMLElement | undefined;
  private menuFocusAfterReorder: HTMLElement | undefined;

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("pinnedRootIds")) {
      this.focusedPinRowId = this.focusedSessionId;
      this.menuFocusAfterReorder = this.focusedMenuControl;
    }
    this.autoExpandedForSelection = false;
    if (changed.has("sessions")) {
      if (this.openMenuSessionId !== undefined && !this.sessions.some((session) => session.id === this.openMenuSessionId)) this.openMenuSessionId = undefined;
      if (!this.sessions.some((session) => session.archived === true)) this.archivedExpanded = false;
      this.pruneSelectedSessionIds();
    }
    if (changed.has("collapsed") && this.collapsed) this.openMenuSessionId = undefined;
    const previousSelected = changed.get("selected");
    const selectionNavigated = changed.has("selected") && (previousSelected?.id !== this.selected?.id || (previousSelected?.archived === true && this.selected?.archived !== true));
    if (selectionNavigated) this.revealSelectedAgentRow();
    if (changed.has("selected") && this.selected?.archived === true && (previousSelected?.id !== this.selected.id || previousSelected.archived !== true) && !this.archivedExpanded) {
      this.archivedExpanded = true;
      this.autoExpandedForSelection = true;
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
    if (this.autoExpandedForSelection || this.shouldRevealSelectedRow(changed)) this.scrollSelectedIntoView();
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
      <section data-ui-context="sessions" data-collapsed=${this.collapsed}>
        ${this.renderHeading(tree.currentRows.length + tree.archivedRows.length, tree.currentSelectableSessions, unreadCount)}
        ${this.collapsed ? null : html`
          <div class="list-body ui-nav-list" aria-busy=${String(this.loading)}>
            ${this.loading ? html`<div class="list-status" role="status">${sessionNavigationMessages.t("loadingSessions")}</div>` : null}
            ${this.renderCurrentSelectionToolbar(tree.currentSelectableSessions)}
            ${this.startingCount > 0 ? this.renderStartingSession() : null}
            ${pinnedRowCount > 0 ? html`<h2 class="subheading pin-heading">${sessionNavigationMessages.t("pinned")}</h2>` : null}
            ${repeat(currentRows, (row) => row.session.id, (row, index) => html`
              ${pinnedRowCount > 0 && index === pinnedRowCount ? html`<h2 class="subheading pin-heading">${sessionNavigationMessages.t("recent")}</h2>` : null}
              ${this.renderSession(row, "current", tree.currentAgentGroups.countByParentId.get(row.session.id) ?? 0, currentAgentOffsets.get(row.session.id) ?? 0, agentAttention?.get(row.session.id))}
            `)}
            ${pinnedRowCount > 0 && pinnedRowCount === currentRows.length ? html`<h2 class="subheading pin-heading">${sessionNavigationMessages.t("recent")}</h2>` : null}
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
          <span class="ui-toolbar-title plain-heading">${sessionNavigationMessages.t("sessions")}</span>
          <span class="ui-toolbar-group">
            ${this.renderUnreadCount(unreadCount)}
            ${this.renderCurrentSelectionButton(currentSessions)}
            ${this.renderCleanupButton()}
            ${this.renderStartButton()}
          </span>
        </h2>
      `;
    }
    const selectedSummary = this.selected === undefined ? sessionNavigationMessages.t("noSelection") : sessionLabel(this.selected);
    const selectedTitle = this.selected?.path ?? selectedSummary;
    return html`
      <h2 class="ui-toolbar">
        <button class="ui-button ui-toolbar-title section-toggle ui-nav-section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} ${sessionNavigationMessages.t("sessions")}</span>${this.collapsed ? html`<small class="section-selected" dir="auto" title=${selectedTitle}>${selectedSummary}</small>` : null}</span></button>
        <span class="ui-toolbar-group">
          ${this.renderUnreadCount(unreadCount)}
          ${this.renderCurrentSelectionButton(currentSessions)}
          <small class="section-count">${localization.number(sessionCount)}</small>
          ${this.renderCleanupButton()}
          ${this.renderStartButton()}
        </span>
      </h2>
    `;
  }

  private renderUnreadCount(unreadCount: number) {
    if (unreadCount === 0) return null;
    const label = sessionNavigationMessages.t("unread", { count: unreadCount });
    return html`<small class="section-unread-count" title=${label}>${label}</small>`;
  }

  private renderCurrentSelectionButton(currentSessions: SessionInfo[]) {
    if (this.collapsed || currentSessions.length === 0) return null;
    const active = this.selectionScopes.has("current");
    return html`<button class="ui-button ui-button--icon bulk-select-entry ${active ? "selected" : ""}" title=${active ? sessionNavigationMessages.t("closeCurrentSelection") : sessionNavigationMessages.t("selectCurrent")} aria-label=${active ? sessionNavigationMessages.t("closeCurrentSelection") : sessionNavigationMessages.t("selectCurrent")} aria-expanded=${String(active)} aria-pressed=${String(active)} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleSelection("current"); }}>☑</button>`;
  }

  private renderCleanupButton() {
    return html`<button class="ui-button cleanup-entry" title=${sessionNavigationMessages.t("cleanupPreview")} @click=${(event: MouseEvent) => { event.stopPropagation(); this.onCleanup?.(); }}>${sessionNavigationMessages.t("cleanup")}</button>`;
  }

  private renderStartButton() {
    const title = this.startingCount > 0 ? sessionNavigationMessages.t("startAnother") : sessionNavigationMessages.t("start");
    return html`<button class="ui-button ui-button--icon start-session-button" title=${title} aria-label=${title} ?disabled=${!this.canStart} @click=${(event: MouseEvent) => { event.stopPropagation(); this.onStart?.(); }}>+</button>`;
  }

  private renderStartingSession() {
    return html`
      <div class="pending-session-row starting-session" role="status" aria-live="polite">
        <div class="action-main">
          <span class="action-name"><span class="activity-indicator sending" aria-hidden="true"></span>${sessionNavigationMessages.t("starting", { count: this.startingCount })}</span>
          <small>${sessionNavigationMessages.t("waiting", { count: this.startingCount })}</small>
        </div>
      </div>
    `;
  }

  private renderArchivedHeading(sessionCount: number) {
    const active = this.selectionScopes.has("archived");
    return html`
      <h2 class="ui-toolbar subheading">
        <button class="ui-button ui-toolbar-title section-toggle ui-nav-section-toggle" aria-expanded=${String(this.archivedExpanded)} @click=${() => { this.toggleArchived(); }}><span>${this.archivedExpanded ? "▾" : "▸"} ${sessionNavigationMessages.t("archived")}</span></button>
        <span class="ui-toolbar-group">
          ${this.archivedExpanded ? html`<button class="ui-button ui-button--icon bulk-select-entry ${active ? "selected" : ""}" title=${active ? sessionNavigationMessages.t("closeArchivedSelection") : sessionNavigationMessages.t("selectArchived")} aria-label=${active ? sessionNavigationMessages.t("closeArchivedSelection") : sessionNavigationMessages.t("selectArchived")} aria-expanded=${String(active)} aria-pressed=${String(active)} @click=${() => { this.toggleSelection("archived"); }}>☑</button>` : null}
          <small class="section-count">${localization.number(sessionCount)}</small>
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
        <div class="ui-toolbar ui-toolbar--borderless bulk-row selecting">
          ${this.renderSelectionControls("current")}
          <div class="ui-toolbar-group bulk-actions">
            <button class="ui-button" ?disabled=${archivableSessions.length === 0} @click=${() => { this.archiveSelectedCurrent(); }}>${sessionNavigationMessages.t("archive")}</button>
            <button class="ui-button" ?disabled=${unreadSelectedSessions.length === 0} @click=${() => { this.markSelectedCurrentRead(); }}>${sessionNavigationMessages.t("markRead")}</button>
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
        <div class="ui-toolbar ui-toolbar--borderless bulk-row selecting">
          ${this.renderSelectionControls("archived")}
          <div class="ui-toolbar-group bulk-actions">
            <button class="ui-button danger" title=${sessionNavigationMessages.t("deleteSelectedTitle")} ?disabled=${selectedSessions.length === 0} @click=${() => { this.confirmDeleteSelectedArchived(); }}>${sessionNavigationMessages.t("delete")}</button>
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
      ? html`<button class="ui-button" @click=${() => { this.selectAllSessions(scope); }}>${sessionNavigationMessages.t("selectAll")}</button>`
      : html`<button class="ui-button" @click=${() => { this.clearSelection(scope); }}>${sessionNavigationMessages.t("clearSelected", { count: selectedCount })}</button>`;
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
    const busy = !isCachedNewSessionInfo(session) && session.archived !== true
      && (this.sending[session.id] === true || sessionRowIsWorking(session, status, activity, this.sessionFlags));
    const unread = sessionRowUnread(session, this.unreadSessionIds);
    const labelItems = this.sessionLabelItems(session);
    return html`
      <div
        class="action-row ui-nav-row ${this.selected?.id === session.id ? "selected" : ""} ${bulkSelected ? "bulk-selected" : ""} ${session.archived === true ? "archived" : ""} ${selectionActive ? "selecting" : ""} ${unread ? "unread" : ""} ${indicatorKind === "intervention-required" ? "intervention-required" : ""} ${agentChildCount > 0 ? "has-agent-subsessions" : ""} ${linkedAgentChild ? "linked-agent-child" : ""}"
        style=${`--depth:${String(cappedDepth)};--agent-offset:${String(agentOffset)}px`}
        tabindex="0"
        data-session-id=${session.id}
        data-current=${this.selected?.id === session.id}
        aria-current=${this.selected?.id === session.id ? "true" : nothing}
        data-activity=${indicatorKind ?? "idle"}
        data-busy=${busy}
        data-unread=${unread}
        data-selected=${bulkSelected}
        data-selecting=${showsCheckbox}
        data-archived=${session.archived === true}
        data-expanded=${agentChildCount > 0 ? this.expandedAgentParents.has(session.id) : nothing}
        title=${session.path}
        @focusin=${() => { this.focusedSessionId = session.id; }}
        @focusout=${() => { this.focusedSessionId = undefined; }}
        @click=${(event: MouseEvent) => { activateSelectableRow(event, () => { this.activateSessionRow(session, scope); }); }}
        @keydown=${(event: KeyboardEvent) => { this.handleSessionKeydown(event, session, scope); }}
      >
        <div class="action-main ui-nav-row-main ${selectionActive ? "selecting" : ""}">
          ${showsCheckbox ? html`<input class="session-checkbox" type="checkbox" aria-label=${sessionNavigationMessages.t("selectSession", { label: sessionLabel(session) })} .checked=${bulkSelected} @click=${(event: MouseEvent) => { event.stopPropagation(); }} @change=${() => { this.toggleSelected(session.id); }}>` : null}
          <span class="action-name-line"><span class="action-name ui-nav-row-label" dir="auto" title=${sessionLabel(session)}>${this.renderRowMarker(row)}${sessionLabel(session)}</span>${this.renderRowBadges(row)}</span>
          <small class="session-secondary ui-nav-row-meta"><span class="session-meta">${indicatorKind === "intervention-required" ? html`${interventionRequiredLabel()} · ` : null}${sessionNavigationMessages.t("sessionMeta", { state: this.sessionMetaState(session, status, activity), count: session.messageCount })}</span>${labelItems.length === 0 ? null : html`<span class="session-label-separator" aria-hidden="true">·</span><span class="session-labels">${renderSessionLabelItems(labelItems)}</span>`}</small>
          ${this.renderActivity(indicatorKind, unread)}
        </div>
        <div class="action-menu ui-nav-row-actions">
          <button class="ui-button ui-button--icon action-menu-toggle ui-nav-row-action ui-popup-trigger" aria-expanded=${String(this.openMenuSessionId === session.id)} aria-controls=${sessionMenuId(session.id)} title=${sessionNavigationMessages.t("actions")} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(session.id); }}>⋯</button>
        </div>
      </div>
      ${agentChildCount > 0 ? html`<button class="agent-subsession-toggle ui-nav-row-disclosure" style=${`--depth:${String(cappedDepth)};--agent-offset:${String(agentOffset)}px`} aria-expanded=${String(this.expandedAgentParents.has(session.id))} @click=${() => { this.toggleAgentParent(session.id); }}><span class="agent-subsession-label">${this.expandedAgentParents.has(session.id) ? "▾" : "▸"} ${sessionNavigationMessages.t("agentSubsessions", { count: agentChildCount })}</span>${!this.expandedAgentParents.has(session.id) && agentAttention !== undefined ? renderActionActivityIndicator(agentAttention.kind, agentAttention.kind === "sending" ? sessionNavigationMessages.t("sendingSubsession") : sessionNavigationMessages.t("activeSubsessions"), agentAttention.unread ? sessionNavigationMessages.t("unreadSubsession") : undefined) : null}</button>` : null}
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
    const isWorking = sessionRowIsWorking(session, status, this.activities[session.id], this.sessionFlags);
    const canDeleteTransient = isTransientNewSessionInfo(session, status);
    const descendantCount = descendantCounts?.get(session.id) ?? 0;
    // Keep the panel beside the row scroller; the shared popup uses the top layer.
    return html`
      <div popover="auto" class="action-menu-panel ui-menu ui-nav-row-menu ui-popup-panel" data-ui-context="session-actions" id=${sessionMenuId(session.id)}
        @focusin=${(event: FocusEvent) => { this.focusedMenuControl = event.target instanceof HTMLElement ? event.target : undefined; }}
        @focusout=${() => { this.focusedMenuControl = undefined; }}
      >
        ${this.renderPinActions(row)}
        ${session.archived === true
          ? html`
            <button class="ui-button ui-menu-item" title=${sessionNavigationMessages.t("restoreTitle")} @click=${() => { this.openMenuSessionId = undefined; this.onRestore?.(session); }}>${sessionNavigationMessages.t("restore")}</button>
            <button class="danger ui-button ui-menu-item" title=${sessionNavigationMessages.t("deleteArchivedTitle")} @click=${() => { this.openMenuSessionId = undefined; this.confirmDeleteArchived(session); }}>${sessionNavigationMessages.t("deleteArchived")}</button>
          `
          : canDeleteTransient
            ? html`<button class="ui-button ui-menu-item" title=${sessionNavigationMessages.t("deleteTransient")} @click=${() => { this.openMenuSessionId = undefined; this.onDelete?.(session); }}>${sessionNavigationMessages.t("delete")}</button>`
            : html`
              ${this.unreadSessionIds.has(session.id) ? html`<button class="ui-button ui-menu-item" title=${sessionNavigationMessages.t("markReadTitle")} @click=${() => { this.openMenuSessionId = undefined; this.onMarkRead?.(session); }}>${sessionNavigationMessages.t("markAsRead")}</button>` : session.agentSubsession !== true ? html`<button class="ui-button ui-menu-item" title=${sessionNavigationMessages.t("markUnreadTitle")} @click=${() => { this.openMenuSessionId = undefined; this.onMarkUnread?.(session); }}>${sessionNavigationMessages.t("markAsUnread")}</button>` : null}
              ${canArchive ? html`
                <button class="ui-button ui-menu-item" title=${sessionNavigationMessages.t("archiveTitle")} @click=${() => { this.openMenuSessionId = undefined; this.onArchive?.(session); }}>${sessionNavigationMessages.t("archive")}</button>
                ${descendantCount > 0 ? html`<button class="ui-button ui-menu-item" title=${sessionNavigationMessages.t("archiveDescendantsTitle")} @click=${() => { this.openMenuSessionId = undefined; this.confirmArchiveWithDescendants(session, descendantCount); }}>${sessionNavigationMessages.t("archiveDescendants", { count: descendantCount })}</button>` : null}
              ` : null}
              ${session.parentSessionPath !== undefined ? html`<button class="ui-button ui-menu-item" title=${sessionNavigationMessages.t("detach")} @click=${() => { this.openMenuSessionId = undefined; this.onDetachParent?.(session); }}>${sessionNavigationMessages.t("detach")}</button>` : null}
              ${canArchive ? html`<button class="ui-button ui-menu-item" title=${isWorking ? sessionNavigationMessages.t("stopBeforeReload") : sessionNavigationMessages.t("reloadTitle")} ?disabled=${isWorking} @click=${() => { this.openMenuSessionId = undefined; this.onReload?.(session); }}>${sessionNavigationMessages.t("reload")}</button>` : null}
            `}
      </div>
    `;
  }

  private renderPinActions(row: SessionRow) {
    if (!isPinnableRoot(row)) return null;
    const { session } = row;
    const pins = this.visibleSessionTree().pinnedRootIds;
    const index = pins.indexOf(session.id);
    if (index < 0) return html`<button class="ui-button ui-menu-item" @click=${() => { this.changePin(session, () => this.onPin?.(session)); }}>${sessionNavigationMessages.t("pin")}</button>`;
    return html`
      <button class="ui-button ui-menu-item" @click=${() => { this.changePin(session, () => this.onUnpin?.(session)); }}>${sessionNavigationMessages.t("unpin")}</button>
      <button class="ui-button ui-menu-item" data-pin-move ?disabled=${index === 0} @click=${() => { this.onMovePin?.(session, -1); }}>${sessionNavigationMessages.t("moveUp")}</button>
      <button class="ui-button ui-menu-item" data-pin-move ?disabled=${index === pins.length - 1} @click=${() => { this.onMovePin?.(session, 1); }}>${sessionNavigationMessages.t("moveDown")}</button>
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
   * to signal that the parent itself is not shown here. Session trees are
   * workspace-scoped, so no alternate parent location is offered.
   */
  private renderRowMarker(row: SessionRow) {
    if (row.hasMissingParent) {
      return html`<span class="tree-marker orphan-marker" title=${sessionNavigationMessages.t("missingParentTitle")} aria-label=${sessionNavigationMessages.t("missingParent")}>↳</span>`;
    }
    return row.depth > 0 ? html`<span class="tree-marker">↳</span>` : null;
  }

  /**
   * Badges live outside `.action-name` so the clamped, ellipsizing title cannot
   * hide them.
   */
  private renderRowBadges(row: SessionRow) {
    if (row.depth <= 2) return null;
    return html`<span class="row-badges"><span class="badge">${sessionNavigationMessages.t("depth", { count: row.depth })}</span></span>`;
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
    if (confirm(sessionNavigationMessages.t("confirmArchive", { label: sessionLabel(session), count: descendantCount }))) this.onArchiveWithDescendants?.(session);
  }

  private confirmDeleteArchived(session: SessionInfo): void {
    if (confirm(sessionNavigationMessages.t("confirmDelete", { label: sessionLabel(session) }))) void this.onDeleteArchived?.(session);
  }

  private confirmDeleteSelectedArchived(): void {
    const archived = this.selectedSessions("archived");
    if (archived.length === 0) return;
    if (!confirm(sessionNavigationMessages.t("confirmDeleteSelected", { count: archived.length }))) return;
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

  private sessionMetaState(session: SessionInfo, status: SessionStatus | undefined, activity: SessionActivity | undefined) {
    if (isTransientNewSessionInfo(session, status)) {
      if (activity?.phase === "active") return "creating";
      if (activity?.phase === "error") return "error";
      return "new";
    }
    if (session.archived === true) return "archived";
    return "other";
  }

  private renderActivity(kind: ActivityIndicatorKind | undefined, unread: boolean) {
    const label = kind === "sending" ? sessionNavigationMessages.t("sending") : sessionNavigationMessages.t("active");
    return renderActionActivityIndicator(kind, label, unread ? sessionNavigationMessages.t("unreadActivity") : undefined);
  }

  static override styles = [listStyles, sidebarListStyles, css`
    @layer pi-web-base {
    /* Keep positioned/animated session content in the scroller's paint hierarchy. */
    .list-body { isolation: isolate; }
    .action-main { padding: 10px; padding-inline-start: calc(19px + var(--depth, 0) * 16px); text-align: start; }
    .tree-marker { margin: 0; margin-inline-end: 5px; }
    .subheading.ui-toolbar { margin-top: 0; }
    h2 .section-count, h2 .section-unread-count { flex: 0 0 auto; align-self: center; padding-inline: 6px; display: inline; color: var(--pi-muted); font-size: inherit; }
    h2 .section-unread-count { color: var(--pi-accent); text-transform: none; }
    .bulk-row { flex-wrap: wrap; }
    .bulk-row button { white-space: nowrap; }
    .bulk-actions { margin-inline-start: auto; }
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
    .row-badges .badge { margin: 0; white-space: nowrap; }
    /* Same glyph as a normal child marker, dimmed: the row is a child whose parent is not displayed here. */
    .orphan-marker { color: var(--pi-dim); opacity: .65; }
    .selection-toolbar { position: sticky; top: 0; z-index: 4; background: var(--pi-bg); border-bottom: 1px solid var(--pi-border-muted); box-shadow: ${scrollBoundaryShadow}; }
    .action-row.bulk-selected { box-shadow: inset 3px 0 0 var(--pi-accent); }
    .pending-session-row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); margin: 0; padding: 3px 10px; cursor: default; }
    .pending-session-row.starting-session .action-main { border-radius: 0; border-style: dashed; border-color: var(--pi-border); color: var(--pi-muted); }
    .pending-session-row.starting-session .action-name { display: flex; align-items: center; gap: 6px; max-height: none; -webkit-line-clamp: 1; }
    .pending-session-row.starting-session .activity-indicator { flex: 0 0 auto; margin: 0; }
    .action-main.selecting, .action-row.linked-agent-child .action-main.selecting { padding-inline-start: calc(48px + var(--depth, 0) * 16px + var(--agent-offset, 0px)); }
    .action-row.has-agent-subsessions { margin-bottom: 0; border-bottom: 0; }
    .action-row.has-agent-subsessions .action-main { padding-bottom: 6px; }
    /* Secondary tree disclosures stay compact; indentation remains inside the click target. */
    .agent-subsession-toggle { position: relative; display: flex; align-items: center; gap: 6px; box-sizing: border-box; width: 100%; min-height: 24px; margin: 0; padding-block: 2px; padding-inline: calc(35px + var(--agent-offset, 0px) + var(--depth, 0) * 16px) 16px; border: 0; border-radius: 0; background: transparent; font: 12px/20px var(--pi-font, system-ui, sans-serif); text-align: start; color: var(--pi-muted); overflow: hidden; }
    .agent-subsession-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent-subsession-toggle::before { content: ""; position: absolute; top: 0; bottom: 50%; inset-inline-start: calc(19px + var(--agent-offset, 0px) + var(--depth, 0) * 16px); width: 10px; border-inline-start: 1px solid var(--pi-border-muted); border-bottom: 1px solid var(--pi-border-muted); pointer-events: none; }
    .agent-subsession-toggle .action-activity { pointer-events: none; }
    /* The disclosure closes a collapsed group; an expanded group's final row owns its separator. */
    .agent-subsession-toggle[aria-expanded="false"]:not(:last-child) { box-shadow: inset 0 -1px var(--pi-border-muted); }
    .action-row.linked-agent-child .action-main { padding-inline-start: calc(19px + var(--agent-offset) + var(--depth, 0) * 16px); }
    .agent-subsession-toggle:hover, .agent-subsession-toggle:focus-visible { color: var(--pi-text); background: var(--pi-surface-hover); }
    .agent-subsession-toggle:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    .session-checkbox { position: absolute; top: 9px; inset-inline-start: calc(24px + var(--depth, 0) * 16px + var(--agent-offset, 0px)); z-index: 2; margin: 0; }
    }
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
 * Intervention takes priority over work. "sending" (client-side upload in flight)
 * takes precedence over ordinary server activity, so it can be colored distinctly to
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
  // Complete snapshots own navigation state, including absent/cleared flags.
  // Live status and persisted listings support daemons without that projection.
  const intervention = sessionFlags !== undefined
    ? sessionFlags[session.id]?.[CORE_STATUS_FLAGS.interventionRequired] === true
    : (status?.sessionId === session.id ? status.interventionRequired : undefined) ?? session.interventionRequired;
  if (intervention === true) return "intervention-required";
  if (sending) return "sending";
  return sessionRowIsWorking(session, status, activity, sessionFlags) ? "session" : undefined;
}

function sessionRowIsWorking(
  session: SessionInfo,
  status: SessionStatus | undefined,
  activity: SessionActivity | undefined,
  sessionFlags?: Readonly<Record<string, StatusFlags>>,
): boolean {
  // The complete daemon projection owns navigation activity. Live chat events
  // are only a compatibility fallback, not a second writer of this state.
  return sessionFlags === undefined
    ? isSessionActive(status, activity)
    : sessionFlags[session.id]?.[CORE_STATUS_FLAGS.working] === true;
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
