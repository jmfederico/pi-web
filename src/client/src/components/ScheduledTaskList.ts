import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ScheduledTask } from "../api";
import { actionMenuPanelStyle } from "./actionMenu";
import type { KeyboardNavigableSection } from "./navigationFocus";
import { activateSelectableRow, focusSelectedOrFirstSelectableRow, handleSelectableRowKeyboard } from "./selectableRow";
import { listStyles } from "./shared";

function relativeNextRun(nextRunAt: string | undefined, now = new Date()): string {
  if (nextRunAt === undefined) return "—";
  const diffMs = new Date(nextRunAt).getTime() - now.getTime();
  if (diffMs <= 0) return "due";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `in ${String(minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${String(hours)}h`;
  const days = Math.round(hours / 24);
  return `in ${String(days)}d`;
}

/**
 * Sidebar section listing scheduled tasks for the *currently selected*
 * workspace — a peer of `<session-list>`, not a global cross-project list.
 * A task's identity is a workspace cwd, same as a session's, so it belongs in
 * the same drill-down rather than a separate top-level surface (see the
 * "Scheduled Tasks" implementation plan for why).
 */
@customElement("scheduled-task-list")
export class ScheduledTaskList extends LitElement implements KeyboardNavigableSection {
  @property({ attribute: false }) tasks: ScheduledTask[] = [];
  @property({ attribute: false }) runningTaskIds: ReadonlySet<string> = new Set();
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ attribute: false }) onNew?: () => void;
  @property({ attribute: false }) onEdit?: (task: ScheduledTask) => void;
  @property({ attribute: false }) onRunNow?: (task: ScheduledTask) => void;
  @property({ attribute: false }) onToggleEnabled?: (task: ScheduledTask) => void;
  @property({ attribute: false }) onViewHistory?: (task: ScheduledTask) => void;
  @property({ attribute: false }) onDelete?: (task: ScheduledTask) => void;
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @property({ attribute: false }) onFocusPreviousSection?: () => void | Promise<void>;
  @property({ attribute: false }) onFocusNextSection?: () => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;

  @state() private openMenuTaskId: string | undefined;
  @state() private menuStyle = "";

  private readonly onDocumentClick = (event: MouseEvent) => {
    if (event.composedPath().includes(this)) return;
    this.openMenuTaskId = undefined;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onDocumentClick);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.onDocumentClick);
    super.disconnectedCallback();
  }

  async focusSelectedOrFirst(): Promise<boolean> {
    await this.updateComplete;
    return focusSelectedOrFirstSelectableRow(this.renderRoot, { fallbackSelector: ".section-toggle" });
  }

  override render() {
    return html`
      <section>
        <h2>${this.renderHeading()}</h2>
        ${this.collapsed ? null : html`
          <div class="list-body">
            ${this.tasks.map((task) => this.renderTask(task))}
            <button class="new-task" @click=${() => { this.onNew?.(); }}>+ New task</button>
          </div>
        `}
      </section>
    `;
  }

  private renderHeading() {
    if (!this.collapsible) return html`Scheduled tasks${this.tasks.length > 0 ? html` <span class="badge">${this.tasks.length}</span>` : null}`;
    return html`<button class="section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} Scheduled tasks</span></span><small class="section-count">${this.tasks.length}</small></button>`;
  }

  private renderTask(task: ScheduledTask) {
    const running = this.runningTaskIds.has(task.id);
    const open = this.openMenuTaskId === task.id;
    return html`
      <div
        class="action-row"
        tabindex="0"
        title=${task.prompt}
        @click=${(event: MouseEvent) => { activateSelectableRow(event, () => this.onEdit?.(task)); }}
        @keydown=${(event: KeyboardEvent) => { this.handleTaskKeydown(event, task); }}
      >
        <div class="action-main">
          <span class="dot ${running ? "running" : task.enabled ? "idle" : "disabled"}"></span>
          <span class="action-name">${task.name}</span>
          <span class="next-run">${running ? "running…" : relativeNextRun(task.nextRunAt)}</span>
        </div>
        <div class="action-menu">
          <button class="action-menu-toggle" title="Task actions" aria-label=${`Actions for ${task.name}`} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(task.id, event.currentTarget); }}>⋯</button>
          ${open ? html`
            <div class="action-menu-panel" style=${this.menuStyle} @click=${(event: MouseEvent) => { event.stopPropagation(); }}>
              <button ?disabled=${running} @click=${() => { this.closeMenu(); this.onRunNow?.(task); }}>Run now</button>
              <button @click=${() => { this.closeMenu(); this.onEdit?.(task); }}>Edit</button>
              <button @click=${() => { this.closeMenu(); this.onViewHistory?.(task); }}>View run history</button>
              <button @click=${() => { this.closeMenu(); this.onToggleEnabled?.(task); }}>${task.enabled ? "Disable" : "Enable"}</button>
              <hr>
              <button class="danger" @click=${() => { this.closeMenu(); this.onDelete?.(task); }}>Delete</button>
            </div>
          ` : null}
        </div>
      </div>
    `;
  }

  private handleTaskKeydown(event: KeyboardEvent, task: ScheduledTask): void {
    handleSelectableRowKeyboard(event, {
      activate: () => this.onEdit?.(task),
      previousSection: this.onFocusPreviousSection === undefined ? undefined : () => { void this.onFocusPreviousSection?.(); },
      nextSection: this.onFocusNextSection === undefined ? undefined : () => { void this.onFocusNextSection?.(); },
      cancel: this.onCancelKeyboardNavigation === undefined ? undefined : () => { void this.onCancelKeyboardNavigation?.(); },
    });
  }

  private toggleMenu(taskId: string, target: EventTarget | null): void {
    if (this.openMenuTaskId === taskId) {
      this.openMenuTaskId = undefined;
      return;
    }
    this.menuStyle = actionMenuPanelStyle(target, { constrainTo: "viewport" });
    this.openMenuTaskId = taskId;
  }

  private closeMenu(): void {
    this.openMenuTaskId = undefined;
  }

  static override styles = [
    listStyles,
    css`
      .dot { display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; vertical-align: 1px; }
      .dot.idle { border: 1.5px solid var(--pi-muted); background: transparent; }
      .dot.running { background: var(--pi-accent); animation: pulse 1s ease-in-out infinite; }
      .dot.disabled { background: var(--pi-dim); }
      .action-main { display: flex; align-items: center; gap: 6px; }
      .action-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; -webkit-line-clamp: unset; max-height: none; }
      .next-run { flex: 0 0 auto; color: var(--pi-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
      .new-task { border: 1px dashed var(--pi-border); background: transparent; color: var(--pi-muted); width: 100%; text-align: left; }
      .new-task:hover { color: var(--pi-text); border-color: var(--pi-accent); }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "scheduled-task-list": ScheduledTaskList;
  }
}
