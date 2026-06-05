import { LitElement, css, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { Machine, Project, SessionInfo, Workspace } from "../../api";
import type { NavigationSection } from "../../appShell/navigationState";

@customElement("app-context-bar")
export class AppContextBar extends LitElement {
  @property({ attribute: false }) machines: Machine[] = [];
  @property({ attribute: false }) machine?: Machine;
  @property({ attribute: false }) project?: Project;
  @property({ attribute: false }) workspace?: Workspace;
  @property({ attribute: false }) session?: SessionInfo;
  @property({ attribute: false }) refreshControl: unknown;
  @property({ attribute: false }) onOpenSection?: (section: NavigationSection) => void;
  @property({ attribute: false }) onShowActions?: () => void;
  @query(".context-items") private contextItems?: HTMLElement | null;
  @state() private canScrollLeft = false;
  @state() private canScrollRight = false;
  private observedContextItems: HTMLElement | undefined;
  private contextItemsResizeObserver: ResizeObserver | undefined;

  override disconnectedCallback(): void {
    this.contextItemsResizeObserver?.disconnect();
    this.contextItemsResizeObserver = undefined;
    this.observedContextItems = undefined;
    super.disconnectedCallback();
  }

  override firstUpdated(): void {
    this.observeContextItems();
    this.updateScrollState();
  }

  override updated(): void {
    this.observeContextItems();
    this.updateScrollState();
  }

  override render() {
    const showMachineContext = shouldShowMachineContext(this.machines);
    const machineLabel = machineContextLabel(this.machine);
    const projectLabel = projectContextLabel(this.project);
    const workspaceLabel = workspaceContextLabel(this.workspace);
    const sessionLabel = sessionContextLabel(this.session);
    return html`
      <nav class=${this.contextBarClass()} aria-label="Current location">
        <span class="context-bar-label">Location</span>
        <ol class="context-items" @scroll=${this.onContextScroll}>
          ${showMachineContext ? html`
            <li class="context-item">
              <button type="button" class=${this.machine === undefined ? "context-chip empty" : "context-chip"} title=${machineContextTitle(this.machine)} aria-label=${`Machine: ${machineLabel}. Open machine selection.`} @click=${() => { this.onOpenSection?.("machines"); }}>
                <span class="context-kind">Machine</span>
                <span class="context-value">${machineLabel}</span>
              </button>
            </li>
          ` : null}
          <li class="context-item">
            <button type="button" class=${this.project === undefined ? "context-chip empty" : "context-chip"} title=${projectContextTitle(this.project)} aria-label=${`Project: ${projectLabel}. Open project selection.`} @click=${() => { this.onOpenSection?.("projects"); }}>
              <span class="context-kind">Project</span>
              <span class="context-value">${projectLabel}</span>
            </button>
          </li>
          <li class="context-item">
            <button type="button" class=${this.workspace === undefined ? "context-chip empty" : "context-chip"} title=${workspaceContextTitle(this.workspace)} aria-label=${`Workspace: ${workspaceLabel}. Open workspace selection.`} @click=${() => { this.onOpenSection?.("workspaces"); }}>
              <span class="context-kind">Workspace</span>
              <span class="context-value">${workspaceLabel}</span>
            </button>
          </li>
          <li class="context-item">
            <button type="button" class=${this.session === undefined ? "context-chip empty" : "context-chip"} title=${sessionContextTitle(this.session)} aria-label=${`Session: ${sessionLabel}. Open session selection.`} @click=${() => { this.onOpenSection?.("sessions"); }}>
              <span class="context-kind">Session</span>
              <span class="context-value">${sessionLabel}</span>
            </button>
          </li>
        </ol>
        ${this.hasContextActions() ? html`<div class="context-actions">${this.renderActionsButton()}${this.refreshControl}</div>` : null}
      </nav>
    `;
  }

  private renderActionsButton() {
    if (this.onShowActions === undefined) return null;
    return html`
      <button type="button" class="context-action-button" title="Show Actions" aria-label="Show Actions" @click=${(event: MouseEvent) => { event.stopPropagation(); this.onShowActions?.(); }}>
        <svg class="context-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M13 2 4 14h7l-1 8 10-13h-7V2Z"></path>
        </svg>
      </button>
    `;
  }

  private contextBarClass(): string {
    const classes = ["context-bar"];
    if (this.hasContextActions()) classes.push("has-context-actions");
    if (this.refreshControl !== undefined && this.onShowActions !== undefined) classes.push("has-context-actions-double");
    if (this.canScrollLeft) classes.push("can-scroll-left");
    if (this.canScrollRight) classes.push("can-scroll-right");
    return classes.join(" ");
  }

  private hasContextActions(): boolean {
    return this.refreshControl !== undefined || this.onShowActions !== undefined;
  }

  private observeContextItems(): void {
    const contextItems = this.contextItemsElement();
    if (this.observedContextItems === contextItems) return;
    this.contextItemsResizeObserver?.disconnect();
    this.observedContextItems = contextItems;
    this.contextItemsResizeObserver = undefined;
    if (contextItems === undefined || typeof ResizeObserver === "undefined") return;
    this.contextItemsResizeObserver = new ResizeObserver(() => {
      this.updateScrollState();
    });
    this.contextItemsResizeObserver.observe(contextItems);
  }

  private updateScrollState(): void {
    const contextItems = this.contextItemsElement();
    const maxScrollLeft = contextItems === undefined ? 0 : Math.max(0, contextItems.scrollWidth - contextItems.clientWidth);
    const canScrollLeft = contextItems !== undefined && contextItems.scrollLeft > 1;
    const canScrollRight = contextItems !== undefined && maxScrollLeft - contextItems.scrollLeft > 1;
    if (this.canScrollLeft !== canScrollLeft) this.canScrollLeft = canScrollLeft;
    if (this.canScrollRight !== canScrollRight) this.canScrollRight = canScrollRight;
  }

  private contextItemsElement(): HTMLElement | undefined {
    const contextItems = this.contextItems;
    return contextItems instanceof HTMLElement ? contextItems : undefined;
  }

  private readonly onContextScroll = () => {
    this.updateScrollState();
  };

  static override styles = css`
    /* Keep the refresh menu in this shadow tree above the following mobile tab strip. */
    :host { position: relative; z-index: 20; flex: 0 0 auto; min-width: 0; }
    .context-bar { position: relative; flex: 0 0 auto; min-width: 0; display: flex; align-items: center; gap: 0; padding: 6px 0; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); }
    .context-bar::before, .context-bar::after { content: ""; position: absolute; top: 0; bottom: 0; z-index: 2; width: 20px; opacity: 0; pointer-events: none; transition: opacity .15s ease; }
    .context-bar::before { left: 0; background: linear-gradient(90deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
    .context-bar::after { right: 0; background: linear-gradient(270deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
    .context-bar.can-scroll-left::before, .context-bar.can-scroll-right::after { opacity: 1; }
    .context-bar-label { display: none; }
    .context-items { flex: 1 1 auto; min-width: 0; display: flex; align-items: stretch; gap: 5px; margin: 0; padding: 0 8px; list-style: none; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scroll-padding-inline: 8px; scrollbar-width: thin; }
    .context-bar.has-context-actions .context-items { padding-right: 58px; scroll-padding-inline: 8px 58px; }
    .context-bar.has-context-actions-double .context-items { padding-right: 102px; scroll-padding-inline: 8px 102px; }
    .context-item { flex: 0 0 auto; min-width: 0; display: flex; }
    .context-actions { position: absolute; top: 6px; right: 0; bottom: 6px; z-index: 3; display: flex; align-items: center; gap: 6px; padding: 0 8px; background: var(--pi-bg); pointer-events: none; }
    .context-actions::before { content: ""; position: absolute; top: 0; bottom: 0; left: -24px; z-index: 0; width: 24px; background: linear-gradient(90deg, transparent, var(--pi-bg)); pointer-events: none; }
    app-refresh-control, .context-action-button { position: relative; z-index: 1; pointer-events: auto; }
    .context-action-button { box-sizing: border-box; width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-surface); color: var(--pi-text); padding: 0; line-height: 1; }
    .context-action-button:hover, .context-action-button:focus-visible { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .context-action-icon { width: 18px; height: 18px; fill: currentColor; pointer-events: none; }
    .context-chip { flex: 0 0 auto; min-width: 0; display: inline-flex; align-items: baseline; gap: 5px; border: 1px solid var(--pi-border-muted); border-radius: 999px; background: var(--pi-surface); color: var(--pi-text); padding: 4px 8px; font: inherit; text-align: left; }
    .context-chip:hover { background: var(--pi-surface-hover); }
    .context-chip:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .context-chip.empty { border-style: dashed; color: var(--pi-muted); }
    .context-kind { display: none; }
    .context-value { min-width: 0; overflow: visible; text-overflow: clip; white-space: nowrap; }
    button { cursor: pointer; }
  `;
}

export function shouldShowMachineContext(machines: readonly Machine[]): boolean {
  return machines.length > 1;
}

function machineContextLabel(machine: Machine | undefined): string {
  return machine === undefined ? "No machine" : `${machine.name}${machine.kind === "remote" ? " · remote" : ""}`;
}

function machineContextTitle(machine: Machine | undefined): string {
  return machine === undefined ? "No machine selected" : machine.baseUrl ?? machine.name;
}

function projectContextLabel(project: Project | undefined): string {
  return project?.name ?? "No project";
}

function projectContextTitle(project: Project | undefined): string {
  return project === undefined ? "No project selected" : `${project.name} — ${project.path}`;
}

function workspaceContextLabel(workspace: Workspace | undefined): string {
  return workspace === undefined ? "No workspace" : `${workspace.label}${workspace.isMain ? " · main" : ""} · ${workspace.path}`;
}

function workspaceContextTitle(workspace: Workspace | undefined): string {
  return workspace === undefined ? "No workspace selected" : `${workspace.label}${workspace.isMain ? " · main" : ""} — ${workspace.path}`;
}

function sessionContextLabel(session: SessionInfo | undefined): string {
  const name = session?.name?.trim();
  const firstMessage = session?.firstMessage.trim();
  return name !== undefined && name !== "" ? name : firstMessage !== undefined && firstMessage !== "" ? firstMessage : session?.id.slice(0, 8) ?? "No session";
}

function sessionContextTitle(session: SessionInfo | undefined): string {
  return session === undefined ? "No session selected" : session.path;
}
