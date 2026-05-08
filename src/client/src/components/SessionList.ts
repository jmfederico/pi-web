import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionActivity, SessionInfo, SessionStatus } from "../api";
import { listStyles } from "./shared";

function sessionLabel(session: SessionInfo): string {
  if (session.name !== undefined && session.name !== "") return session.name;
  return session.firstMessage !== "" ? session.firstMessage : session.id.slice(0, 8);
}

@customElement("session-list")
export class SessionList extends LitElement {
  @property({ attribute: false }) sessions: SessionInfo[] = [];
  @property({ attribute: false }) statuses: Record<string, SessionStatus> = {};
  @property({ attribute: false }) activities: Record<string, SessionActivity> = {};
  @property({ attribute: false }) selected?: SessionInfo;
  @property({ type: Boolean }) canStart = false;
  @property({ attribute: false }) onSelect?: (session: SessionInfo) => void;
  @property({ attribute: false }) onStart?: () => void;
  @state() private openMenuSessionId: string | undefined;
  @state() private menuStyle = "";
  @state() private archivedExpanded = false;
  private readonly onDocumentClick = (event: MouseEvent) => {
    if (event.composedPath().includes(this)) return;
    this.openMenuSessionId = undefined;
  };
  @property({ attribute: false }) onArchive?: (session: SessionInfo) => void;
  @property({ attribute: false }) onRestore?: (session: SessionInfo) => void;

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
    if (changed.has("sessions") && !this.sessions.some((session) => session.archived === true)) this.archivedExpanded = false;
  }

  override render() {
    const active = this.sessions.filter((session) => session.archived !== true);
    const archived = this.sessions.filter((session) => session.archived === true);
    return html`
      <section>
        <h2>Sessions <button ?disabled=${!this.canStart} @click=${() => this.onStart?.()}>+</button></h2>
        ${active.map((session) => this.renderSession(session))}
        ${archived.length > 0 ? html`
          <h2 class="subheading"><button class="section-toggle" aria-expanded=${String(this.archivedExpanded)} @click=${() => { this.toggleArchived(); }}><span>${this.archivedExpanded ? "▾" : "▸"} Archived</span><small>${archived.length}</small></button></h2>
          ${this.archivedExpanded ? archived.map((session) => this.renderSession(session)) : null}
        ` : null}
      </section>
    `;
  }

  private renderSession(session: SessionInfo) {
    return html`
      <div class="action-row ${this.selected?.id === session.id ? "selected" : ""} ${session.archived === true ? "archived" : ""}">
        <button class="action-main" @click=${() => this.onSelect?.(session)}>
          <span>${sessionLabel(session)}</span><small>${this.renderStatus(session)}${String(session.messageCount)} messages</small>
        </button>
        <div class="action-menu">
          <button class="action-menu-toggle" title="Session actions" @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(session.id, event.currentTarget); }}>⋯</button>
          ${this.openMenuSessionId === session.id ? html`
            <div class="action-menu-panel" style=${this.menuStyle}>
              ${session.archived === true
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

  private renderStatus(session: SessionInfo) {
    if (session.archived === true) return "read-only · ";
    const status = this.statuses[session.id];
    const activity = this.activities[session.id];
    if (activity?.phase === "active") return `● ${activity.label} · `;
    if (status === undefined) return "";
    if (status.isStreaming) return "● streaming · ";
    if (status.isBashRunning) return "● bash · ";
    if (status.isCompacting) return "● compacting · ";
    if (status.pendingMessageCount > 0) return `● ${String(status.pendingMessageCount)} pending · `;
    return "";
  }

  static override styles = listStyles;
}
