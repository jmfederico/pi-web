import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionActivity, SessionInfo, SessionStatus } from "../api";
import { isCachedNewSessionInfo } from "../cachedNewSessions";
import { isSessionActive } from "../../../shared/activity";
import { renderActivityIndicator } from "./activityBadge";
import { activateSelectableRow, activateSelectableRowFromKeyboard } from "./selectableRow";
import { listStyles } from "./shared";

function sessionLabel(session: SessionInfo): string {
  if (session.name !== undefined && session.name !== "") return session.name;
  return session.firstMessage !== "" ? session.firstMessage : session.id.slice(0, 8);
}

interface SessionRow {
  session: SessionInfo;
  depth: number;
  hasMissingParent: boolean;
}

@customElement("session-list")
export class SessionList extends LitElement {
  @property({ attribute: false }) sessions: SessionInfo[] = [];
  @property({ attribute: false }) statuses: Record<string, SessionStatus> = {};
  @property({ attribute: false }) activities: Record<string, SessionActivity> = {};
  @property({ attribute: false }) selected?: SessionInfo;
  @property({ type: Boolean }) canStart = false;
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ attribute: false }) onSelect?: (session: SessionInfo) => void;
  @property({ attribute: false }) onStart?: () => void;
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @state() private openMenuSessionId: string | undefined;
  @state() private menuStyle = "";
  @state() private archivedExpanded = false;
  private readonly onDocumentClick = (event: MouseEvent) => {
    if (event.composedPath().includes(this)) return;
    this.openMenuSessionId = undefined;
  };
  @property({ attribute: false }) onArchive?: (session: SessionInfo) => void;
  @property({ attribute: false }) onRestore?: (session: SessionInfo) => void;
  @property({ attribute: false }) onDelete?: (session: SessionInfo) => void;
  @property({ attribute: false }) onDetachParent?: (session: SessionInfo) => void;

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onDocumentClick);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.onDocumentClick);
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("sessions") && this.openMenuSessionId !== undefined && !this.sessions.some((session) => session.id === this.openMenuSessionId)) this.openMenuSessionId = undefined;
    if (changed.has("collapsed") && this.collapsed) this.openMenuSessionId = undefined;
    if (changed.has("sessions") && !this.sessions.some((session) => session.archived === true)) this.archivedExpanded = false;
    if (this.selected?.archived === true && !this.archivedExpanded) {
      this.archivedExpanded = true;
      void this.updateComplete.then(() => { this.scrollSelectedIntoView(); });
      return;
    }
    if ((changed.has("selected") || changed.has("sessions") || changed.has("collapsed")) && !this.collapsed) this.scrollSelectedIntoView();
  }

  override render() {
    const activeRows = sessionRowsForActiveTree(this.sessions);
    const activeIds = new Set(activeRows.map((row) => row.session.id));
    const archivedRows = sessionRows(this.sessions.filter((session) => session.archived === true && !activeIds.has(session.id)));
    return html`
      <section>
        ${this.renderHeading(activeRows.length + archivedRows.length)}
        ${this.collapsed ? null : activeRows.map((row) => this.renderSession(row))}
        ${this.collapsed ? null : archivedRows.length > 0 ? html`
          <h2 class="subheading"><button class="section-toggle" aria-expanded=${String(this.archivedExpanded)} @click=${() => { this.toggleArchived(); }}><span>${this.archivedExpanded ? "▾" : "▸"} Archived</span><small>${archivedRows.length}</small></button></h2>
          ${this.archivedExpanded ? archivedRows.map((row) => this.renderSession(row)) : null}
        ` : null}
      </section>
    `;
  }

  private renderHeading(sessionCount: number) {
    if (!this.collapsible) return html`<h2>Sessions <button ?disabled=${!this.canStart} @click=${() => this.onStart?.()}>+</button></h2>`;
    const selectedSummary = this.selected === undefined ? "No session selected" : sessionLabel(this.selected);
    const selectedTitle = this.selected?.path ?? selectedSummary;
    return html`
      <h2>
        <button class="section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} Sessions</span><small class="section-selected" title=${selectedTitle}>${selectedSummary}</small></span><small class="section-count">${sessionCount}</small></button>
        <button ?disabled=${!this.canStart} @click=${(event: MouseEvent) => { event.stopPropagation(); this.onStart?.(); }}>+</button>
      </h2>
    `;
  }

  private renderSession(row: SessionRow) {
    const { session } = row;
    const cappedDepth = Math.min(row.depth, 2);
    return html`
      <div
        class="action-row ${this.selected?.id === session.id ? "selected" : ""} ${session.archived === true ? "archived" : ""}"
        style=${`--depth:${String(cappedDepth)}`}
        tabindex="0"
        title=${session.path}
        @click=${(event: MouseEvent) => { activateSelectableRow(event, () => this.onSelect?.(session)); }}
        @keydown=${(event: KeyboardEvent) => { activateSelectableRowFromKeyboard(event, () => this.onSelect?.(session)); }}
      >
        <div class="action-main">
          <span>${row.depth > 0 ? html`<span class="tree-marker">↳</span>` : null}${sessionLabel(session)}${row.depth > 2 ? html` <span class="badge">depth ${row.depth}</span>` : null}${row.hasMissingParent ? html` <span class="badge">parent unavailable</span>` : null}</span><small>${this.renderStatus(session)}${String(session.messageCount)} messages</small>
        </div>
        <div class="action-menu">
          <button class="action-menu-toggle" title="Session actions" @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(session.id, event.currentTarget); }}>⋯</button>
          ${this.openMenuSessionId === session.id ? html`
            <div class="action-menu-panel" style=${this.menuStyle}>
              ${session.parentSessionPath !== undefined ? html`<button title="Detach from parent" @click=${() => { this.openMenuSessionId = undefined; this.onDetachParent?.(session); }}>Detach from parent</button>` : null}
              ${isCachedNewSessionInfo(session)
                ? html`<button title="Delete browser-cached new session" @click=${() => { this.openMenuSessionId = undefined; this.onDelete?.(session); }}>Delete</button>`
                : session.archived === true
                  ? html`<button title="Restore session" @click=${() => { this.openMenuSessionId = undefined; this.onRestore?.(session); }}>Restore</button>`
                  : html`<button title="Archive session" @click=${() => { this.openMenuSessionId = undefined; this.onArchive?.(session); }}>Archive</button>`}
            </div>
          ` : null}
        </div>
      </div>
    `;
  }

  private toggleMenu(sessionId: string, target: EventTarget | null) {
    if (this.openMenuSessionId === sessionId) {
      this.openMenuSessionId = undefined;
      return;
    }
    if (target instanceof HTMLElement) {
      const rect = target.getBoundingClientRect();
      this.menuStyle = `top: ${String(rect.bottom + 4)}px; right: ${String(window.innerWidth - rect.right)}px;`;
    }
    this.openMenuSessionId = sessionId;
  }

  private toggleArchived() {
    this.archivedExpanded = !this.archivedExpanded;
    if (!this.archivedExpanded) this.openMenuSessionId = undefined;
  }

  private scrollSelectedIntoView(): void {
    this.renderRoot.querySelector<HTMLElement>(".action-row.selected")?.scrollIntoView({ block: "nearest" });
  }

  private renderStatus(session: SessionInfo) {
    if (isCachedNewSessionInfo(session)) return "new · ";
    if (session.archived === true) return "read-only · ";
    return renderActivityIndicator(isSessionActive(this.statuses[session.id], this.activities[session.id]) ? "session" : undefined, "Session active") ?? "";
  }

  static override styles = listStyles;
}

function sessionRowsForActiveTree(sessions: SessionInfo[]): SessionRow[] {
  const byPath = new Map(sessions.map((session) => [session.path, session]));
  const visible = new Set<string>();
  for (const session of sessions) {
    if (session.archived === true) continue;
    visible.add(session.id);
    let parentPath = session.parentSessionPath;
    const seen = new Set<string>([session.path]);
    while (parentPath !== undefined && !seen.has(parentPath)) {
      seen.add(parentPath);
      const parent = byPath.get(parentPath);
      if (parent === undefined) break;
      visible.add(parent.id);
      parentPath = parent.parentSessionPath;
    }
  }
  return sessionRows(sessions.filter((session) => visible.has(session.id)));
}

function sessionRows(sessions: SessionInfo[]): SessionRow[] {
  const byPath = new Map(sessions.map((session) => [session.path, session]));
  const childrenByPath = new Map<string, SessionInfo[]>();
  const roots: SessionInfo[] = [];
  for (const session of sessions) {
    const parentPath = session.parentSessionPath;
    const parent = parentPath === undefined ? undefined : byPath.get(parentPath);
    if (parent === undefined) {
      roots.push(session);
      continue;
    }
    const children = childrenByPath.get(parent.path) ?? [];
    children.push(session);
    childrenByPath.set(parent.path, children);
  }

  const rows: SessionRow[] = [];
  const visit = (session: SessionInfo, depth: number, stack: Set<string>) => {
    if (stack.has(session.path)) return;
    const parentPath = session.parentSessionPath;
    rows.push({ session, depth, hasMissingParent: parentPath !== undefined && !byPath.has(parentPath) });
    const nextStack = new Set(stack);
    nextStack.add(session.path);
    for (const child of childrenByPath.get(session.path) ?? []) visit(child, depth + 1, nextStack);
  };
  for (const root of roots) visit(root, 0, new Set());
  return rows;
}
