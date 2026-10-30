import { LocalizationController, localization } from "../../localization/browser";
import { horizontalScrollEdges } from "./scrollEdges";
import { appShellMessages as m } from "../../appShellMessages";
import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { LitElement, css, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { Machine, Project, SessionInfo, Workspace } from "../../api";
import { machineIconUrl } from "../../instanceIdentity";
import { shortSessionId } from "../../sessionLabels";
import { renderNavigationMenuIcon } from "../tabIcons";
import type { NavigationSection } from "../../appShell/navigationState";

@customElement("app-context-bar")
export class AppContextBar extends LitElement {
  constructor() {
    super();
    new LocalizationController(this);
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) machines: Machine[] = [];
  @property({ attribute: false }) machine?: Machine;
  @property({ attribute: false }) project?: Project;
  @property({ type: Boolean }) workspaceSelectionVisible = true;
  @property({ attribute: false }) workspace?: Workspace;
  @property({ attribute: false }) session?: SessionInfo;
  @property({ attribute: false }) refreshControl: unknown;
  @property({ attribute: false }) onOpenSection?: (section: NavigationSection) => void;
  @property({ attribute: false }) onShowActions?: () => void;
  @property({ attribute: false }) onShowNavigation?: () => void;
  @property({ type: Boolean }) hiddenActiveDestination = false;
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
    const machine = displayMachine(this.machine, this.machines);
    const machineChoice = this.machines.length > 1;
    const machineChipClass = machine === undefined ? "context-chip machine-chip empty" : "context-chip machine-chip";
    const projectLabel = projectContextLabel(this.project);
    const workspaceLabel = workspaceContextLabel(this.workspace);
    const sessionLabel = sessionContextLabel(this.session);
    return html`
      <nav class=${this.contextBarClass()} aria-label=${m.t("currentLocation")}>
        <span class="context-bar-label">${m.t("location")}</span>
        <ol class="context-items" @scroll=${this.onContextScroll}>
          <li class="context-item">
              ${machineChoice ? html`
                <button type="button" class=${machineChipClass} title=${machineContextTitle(machine)} aria-label=${m.t("machineSelection", { label: machineContextLabel(machine) })} @click=${() => { this.onOpenSection?.("machines"); }}>
                  ${this.renderMachineChipContent(machine)}
                </button>
              ` : html`
                <!-- No machine choice: the chip is the instance identity, not a control. -->
                <span class="${machineChipClass} static" title=${machineContextTitle(machine)}>
                  ${this.renderMachineChipContent(machine)}
                </span>
              `}
          </li>
          <li class="context-item">
            <button type="button" class=${this.project === undefined ? "context-chip empty" : "context-chip"} title=${projectContextTitle(this.project)} aria-label=${m.t("projectSelection", { label: projectLabel })} @click=${() => { this.onOpenSection?.("projects"); }}>
              <span class="context-kind">${m.t("project")}</span>
              <span class="context-value">${projectLabel}</span>
            </button>
          </li>
          ${this.workspaceSelectionVisible ? html`<li class="context-item">
            <button type="button" class=${this.workspace === undefined ? "context-chip empty" : "context-chip"} title=${workspaceContextTitle(this.workspace)} aria-label=${m.t("workspaceSelection", { label: workspaceLabel })} @click=${() => { this.onOpenSection?.("workspaces"); }}>
              <span class="context-kind">${m.t("workspace")}</span>
              <span class="context-value">${workspaceLabel}</span>
            </button>
          </li>` : null}
          <li class="context-item">
            <button type="button" class=${this.session === undefined ? "context-chip empty" : "context-chip"} title=${sessionContextTitle(this.session)} aria-label=${m.t("sessionSelection", { label: sessionLabel })} @click=${() => { this.onOpenSection?.("sessions"); }}>
              <span class="context-kind">${m.t("session")}</span>
              <span class="context-value">${sessionLabel}</span>
            </button>
          </li>
        </ol>
        ${this.hasContextActions() ? html`<div class="context-actions">${this.onShowNavigation === undefined ? null : html`<button type="button" class=${`context-action-button${this.hiddenActiveDestination ? " selected" : ""}`} data-navigation-trigger title=${m.t("navigation")} aria-label=${m.t("navigation")} aria-haspopup="dialog" @click=${this.onShowNavigation}>${renderNavigationMenuIcon()}</button>`}${this.refreshControl}${this.renderActionsButton()}</div>` : null}
      </nav>
    `;
  }

  private renderMachineChipContent(machine: Machine | undefined) {
    const identity = machine ?? { id: "local", name: "PI-WEB", kind: "local" as const, createdAt: "", updatedAt: "" };
    const label = this.machines.length > 1 ? machineSelectionLabel(identity) : machineContextLabel(identity);
    return html`
      <img class="context-chip-icon" src=${machineIconUrl(identity)} alt="" @error=${this.hideBrokenIcon} />
      <span class="context-value">${label}</span>
    `;
  }

  private readonly hideBrokenIcon = (event: Event): void => {
    if (event.currentTarget instanceof HTMLImageElement) event.currentTarget.style.display = "none";
  };

  private renderActionsButton() {
    if (this.onShowActions === undefined) return null;
    return html`
      <button type="button" class="context-action-button" title=${m.t("showActions")} aria-label=${m.t("showActions")} @click=${(event: MouseEvent) => { event.stopPropagation(); this.onShowActions?.(); }}>
        <svg class="context-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M13 2 4 14h7l-1 8 10-13h-7V2Z"></path>
        </svg>
      </button>
    `;
  }

  private contextBarClass(): string {
    const classes = ["context-bar"];
    if (this.canScrollLeft) classes.push("can-scroll-left");
    if (this.canScrollRight) classes.push("can-scroll-right");
    return classes.join(" ");
  }

  private hasContextActions(): boolean {
    return this.refreshControl !== undefined || this.onShowActions !== undefined || this.onShowNavigation !== undefined;
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
    const edges = horizontalScrollEdges(contextItems?.scrollLeft ?? 0, maxScrollLeft, localization.direction);
    const canScrollLeft = contextItems !== undefined && edges.left;
    const canScrollRight = contextItems !== undefined && edges.right;
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
    .context-bar { position: relative; flex: 0 0 auto; min-width: 0; min-height: 44px; display: flex; align-items: stretch; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); }
    .context-bar.can-scroll-left .context-items { box-shadow: inset 8px 0 6px -8px var(--pi-shadow-strong); }
    .context-bar.can-scroll-right .context-items { box-shadow: inset -8px 0 6px -8px var(--pi-shadow-strong); }
    .context-bar.can-scroll-left.can-scroll-right .context-items { box-shadow: inset 8px 0 6px -8px var(--pi-shadow-strong), inset -8px 0 6px -8px var(--pi-shadow-strong); }
    .context-bar-label { display: none; }
    .context-items { flex: 1 1 auto; min-width: 0; display: flex; align-items: stretch; margin: 0; padding: 0; list-style: none; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: none; }
    .context-items::-webkit-scrollbar { display: none; }
    .context-item { flex: 0 0 auto; min-width: 0; display: flex; }
    .context-item + .context-item { border-inline-start: 1px solid var(--pi-border-muted); }
    .context-actions { position: relative; flex: 0 0 auto; z-index: 3; display: flex; align-items: stretch; border-inline-start: 1px solid var(--pi-border-muted); background: var(--pi-bg); }
    .context-action-button { box-sizing: border-box; width: 44px; min-height: 44px; flex: 0 0 auto; display: grid; place-items: center; border: 0; border-radius: 0; background: transparent; color: var(--pi-text); padding: 0; line-height: 1; }
    .context-actions > * + * { border-inline-start: 1px solid var(--pi-border-muted); }
    .context-action-button.selected { background: var(--pi-selection-bg); }
    .context-action-button:hover { background: var(--pi-surface-hover); }
    .context-action-button:focus-visible, button.context-chip:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    .context-action-icon { width: 18px; height: 18px; fill: currentColor; pointer-events: none; }
    .context-chip { box-sizing: border-box; flex: 0 0 auto; min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; gap: 5px; border: 0; border-radius: 0; background: transparent; color: var(--pi-text); padding: 0 12px; font: inherit; text-align: start; }
    .context-chip-icon { flex: 0 0 auto; width: 14px; height: 14px; }
    button.context-chip:hover { background: var(--pi-surface-hover); }
    .context-chip.empty { color: var(--pi-muted); }
    .context-kind { display: none; }
    .context-value { min-width: 0; overflow: visible; text-overflow: clip; white-space: nowrap; }
    button { cursor: pointer; }
  `;
}

/**
 * The machine chip always shows the machine the UI acts on, falling back to
 * the local machine before an explicit selection lands.
 */
function displayMachine(machine: Machine | undefined, machines: readonly Machine[]): Machine | undefined {
  return machine ?? machines.find((candidate) => candidate.id === "local") ?? machines[0];
}

function machineContextLabel(machine: Machine | undefined): string {
  return machine?.name ?? "PI-WEB";
}

/** Distinguish remote selections without adding their URL to the breadcrumb. */
function machineSelectionLabel(machine: Machine): string {
  return machine.kind === "remote" ? m.t("remoteMachine", { name: machine.name }) : machine.name;
}

function machineContextTitle(machine: Machine | undefined): string {
  return machine === undefined ? "PI-WEB" : machine.baseUrl ?? machine.name;
}

function projectContextLabel(project: Project | undefined): string {
  return project?.name ?? m.t("noProject");
}

function projectContextTitle(project: Project | undefined): string {
  return project === undefined ? m.t("noProjectSelected") : m.t("projectDetail", { name: project.name, path: project.path });
}

function workspaceContextLabel(workspace: Workspace | undefined): string {
  return workspace === undefined ? m.t("noWorkspace") : m.t("workspaceLabel", { label: workspace.label, main: workspace.isMain ? "yes" : "no", path: workspace.path });
}

function workspaceContextTitle(workspace: Workspace | undefined): string {
  return workspace === undefined ? m.t("noWorkspaceSelected") : m.t("workspaceDetail", { label: workspace.label, main: workspace.isMain ? "yes" : "no", path: workspace.path });
}

function sessionContextLabel(session: SessionInfo | undefined): string {
  const name = session?.name?.trim();
  const firstMessage = session?.firstMessage.trim();
  return name !== undefined && name !== "" ? name : firstMessage !== undefined && firstMessage !== "" ? firstMessage : session === undefined ? m.t("noSession") : shortSessionId(session.id);
}

function sessionContextTitle(session: SessionInfo | undefined): string {
  return session === undefined ? m.t("noSessionSelected") : session.path;
}
