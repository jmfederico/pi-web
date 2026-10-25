import { LocalizationController } from "../../localization/browser";
import { appShellMessages as m } from "../../appShellMessages";
import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { LitElement, css, html } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { NavigationSectionResizeController, type ResizableNavigationSection } from "../../appShell/navigationSectionResizeController";
import type { NavigationSectionMeasurement } from "./NavigationSectionResizeHandle";
import "./NavigationSectionResizeHandle";
import { customElement, property, query, state } from "lit/decorators.js";
import type { Machine, MachineHealth, Project, SessionActivity, SessionInfo, SessionStatus, Workspace } from "../../api";
import type { MachineStatusSnapshot } from "../../../../shared/machineStatus";
import type { SessionLabelItem, WorkspaceLabelItem } from "../../plugins/types";
import { selectedMachineId } from "../../controllers/types";
import type { NavigationSection } from "../../appShell/navigationState";
import { NAVIGATION_SECTION_ORDER } from "../../appShell/navigationState";
import type { KeyboardNavigableSection } from "../navigationFocus";
import { uiButtonStyles } from "../ui/controlStyles";
import { renderPanelToggleButton } from "./panelToggleButton";
import "../MachineList";
import "../MachineSwitcher";
import "../ProjectList";
import "../WorkspaceList";
import type { SessionList } from "../SessionList";
import "../SessionList";

export type NavigationFocusTarget = NavigationSection | "chat";

@customElement("app-navigation-panel")
export class AppNavigationPanel extends LitElement {
  constructor() {
    super();
    new LocalizationController(this);
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) machines: Machine[] = [];
  @property({ attribute: false }) selectedMachine?: Machine;
  /** PWA display mode: surfaces the single-machine identity in the header. */
  @property({ type: Boolean }) locationIndicator = false;
  @property({ attribute: false }) machineStatuses: Record<string, MachineHealth> = {};
  @property({ attribute: false }) machineStatusSnapshots: Record<string, MachineStatusSnapshot> = {};
  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) selectedProject?: Project;
  @property({ type: Boolean }) workspaceSelectionVisible = true;
  @property({ attribute: false }) workspaces: Workspace[] = [];
  @property({ attribute: false }) selectedWorkspace?: Workspace;
  @property({ attribute: false }) sessions: SessionInfo[] = [];
  @property({ attribute: false }) selectedSession?: SessionInfo;
  @property({ attribute: false }) pinnedRootIds: string[] = [];
  @property({ attribute: false }) sessionActivities: Record<string, SessionActivity> = {};
  @property({ attribute: false }) sessionStatuses: Record<string, SessionStatus> = {};
  @property({ attribute: false }) sendingPrompts: Record<string, true> = {};
  @property({ attribute: false }) unreadSessionIds: ReadonlySet<string> = new Set();
  @property({ attribute: false }) deletingWorkspaceIds: string[] = [];
  // Unlike event callbacks, this provider affects rendered content; replacements
  // must remain reactive inputs to WorkspaceList.
  @property({ attribute: false }) workspaceLabelItems: (workspace: Workspace) => WorkspaceLabelItem[] = () => [];
  @property({ attribute: false }) sessionLabelItems: (session: SessionInfo) => SessionLabelItem[] = () => [];
  @property({ attribute: false }) refreshControl: unknown;
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) compact = false;
  @property({ type: Boolean }) machinesCollapsed = false;
  @property({ type: Boolean }) projectsCollapsed = false;
  @property({ type: Boolean }) workspacesCollapsed = false;
  @property({ type: Boolean }) sessionsCollapsed = false;
  @property({ type: Number }) startingSessionCount = 0;
  @property({ type: Boolean }) canStartSession = false;
  @property({ attribute: false }) onShowActions?: () => void;
  @property({ attribute: false }) onTogglePanel?: () => void;
  @property({ attribute: false }) onToggleMachines?: () => void;
  @property({ attribute: false }) onToggleProjects?: () => void;
  @property({ attribute: false }) onToggleWorkspaces?: () => void;
  @property({ attribute: false }) onToggleSessions?: () => void;
  @property({ attribute: false }) onSelectProject?: (project: Project) => void | Promise<void>;
  @property({ attribute: false }) onCloseProject?: (project: Project) => void | Promise<void>;
  @property({ attribute: false }) onMoveProject?: (project: Project, direction: -1 | 1) => void;
  @property({ attribute: false }) onReorderProject?: (project: Project, neighbor: Project, position: "before" | "after") => void;
  @property({ attribute: false }) onMoveWorkspace?: (workspace: Workspace, direction: -1 | 1) => void;
  @property({ attribute: false }) onPinSession?: (session: SessionInfo) => void;
  @property({ attribute: false }) onUnpinSession?: (session: SessionInfo) => void;
  @property({ attribute: false }) onMoveSessionPin?: (session: SessionInfo, direction: -1 | 1) => void;
  @property({ attribute: false }) onSelectWorkspace?: (workspace: Workspace) => void | Promise<void>;
  @property({ attribute: false }) onDeleteWorkspace?: (workspace: Workspace) => void | Promise<void>;
  @property({ attribute: false }) onStartSession?: () => void | Promise<void>;
  @property({ attribute: false }) onSelectSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onArchiveSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onArchiveSessionWithDescendants?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onArchiveSessions?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onRestoreSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onDeleteCachedNewSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onDeleteArchivedSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onDeleteArchivedSessions?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onDetachParentSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onMarkSessionRead?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onMarkSessionUnread?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onMarkSessionsRead?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onReloadSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onCleanupSessions?: () => void | Promise<void>;
  @property({ attribute: false }) onArchivedCollapsed?: () => void | Promise<void>;
  @property({ attribute: false }) onSelectMachine?: (machine: Machine) => void | Promise<void>;
  @property({ attribute: false }) onEditMachine?: (machine: Machine) => void;
  @property({ attribute: false }) onRemoveMachine?: (machine: Machine) => void | Promise<void>;
  @property({ attribute: false }) onFocusNavigationTarget?: (target: NavigationFocusTarget) => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;

  private readonly sectionSizes = new NavigationSectionResizeController(this);
  @state() private sectionMeasurements: Record<ResizableNavigationSection, NavigationSectionMeasurement> = {
    projects: { height: 44, maxHeight: 44 },
    workspaces: { height: 44, maxHeight: 44 },
  };
  private layoutObserver: ResizeObserver | undefined;
  private observedLayoutElements: Element[] = [];

  override connectedCallback(): void {
    super.connectedCallback();
    if (typeof ResizeObserver !== "undefined") {
      this.layoutObserver = new ResizeObserver(() => { this.refreshSectionMeasurements(); });
      this.requestUpdate();
    }
  }

  override disconnectedCallback(): void {
    this.layoutObserver?.disconnect();
    this.layoutObserver = undefined;
    this.observedLayoutElements = [];
    super.disconnectedCallback();
  }

  protected override updated(): void {
    if (this.layoutObserver === undefined) return;
    const elements = [this, ...this.renderRoot.querySelectorAll("header, machine-list, project-list, workspace-list, session-list")];
    if (elements.length === this.observedLayoutElements.length && elements.every((element, index) => element === this.observedLayoutElements[index])) return;
    this.layoutObserver.disconnect();
    for (const element of elements) this.layoutObserver.observe(element);
    this.observedLayoutElements = elements;
  }

  private refreshSectionMeasurements(): void {
    const projects = this.measureSection("projects");
    const workspaces = this.measureSection("workspaces");
    if (projects.height === this.sectionMeasurements.projects.height && projects.maxHeight === this.sectionMeasurements.projects.maxHeight
      && workspaces.height === this.sectionMeasurements.workspaces.height && workspaces.maxHeight === this.sectionMeasurements.workspaces.maxHeight) return;
    this.sectionMeasurements = { projects, workspaces };
  }

  @query("machine-list") private machineList?: KeyboardNavigableSection;
  @query("machine-switcher") private machineSwitcher?: KeyboardNavigableSection;
  @query("project-list") private projectList?: KeyboardNavigableSection;
  @query("workspace-list") private workspaceList?: KeyboardNavigableSection;
  @query("session-list") private sessionList?: SessionList;

  automaticSessionCandidates(sessions: SessionInfo[]): SessionInfo[] {
    if (this.sessionsCollapsed) return [];
    return this.sessionList?.automaticSessionCandidates(sessions) ?? [];
  }

  async focusSection(section: NavigationSection): Promise<boolean> {
    await this.updateComplete;
    switch (section) {
      case "machines": return await this.focusNavigableSection(this.compact ? this.machineList : this.machineSwitcher);
      case "projects": return await this.focusNavigableSection(this.projectList);
      case "workspaces": return this.workspaceSelectionVisible && await this.focusNavigableSection(this.workspaceList);
      case "sessions": return await this.focusNavigableSection(this.sessionList);
    }
  }

  // Stable child inputs delegate at invocation time, never capturing old props.
  private readonly childCallbacks = {
    toggleProjects: () => { this.onToggleProjects?.(); },
    selectProject: (project: Project) => this.onSelectProject?.(project),
    closeProject: (project: Project) => this.onCloseProject?.(project),
    moveProject: (project: Project, direction: -1 | 1) => this.onMoveProject?.(project, direction),
    reorderProject: (project: Project, neighbor: Project, position: "before" | "after") => this.onReorderProject?.(project, neighbor, position),
    moveWorkspace: (workspace: Workspace, direction: -1 | 1) => this.onMoveWorkspace?.(workspace, direction),
    pinSession: (session: SessionInfo) => this.onPinSession?.(session),
    unpinSession: (session: SessionInfo) => this.onUnpinSession?.(session),
    moveSessionPin: (session: SessionInfo, direction: -1 | 1) => this.onMoveSessionPin?.(session, direction),
    toggleWorkspaces: () => { this.onToggleWorkspaces?.(); },
    selectWorkspace: (workspace: Workspace) => this.onSelectWorkspace?.(workspace),
    deleteWorkspace: (workspace: Workspace) => this.onDeleteWorkspace?.(workspace),
    toggleSessions: () => { this.onToggleSessions?.(); },
    archivedCollapsed: () => this.onArchivedCollapsed?.(),
    startSession: () => this.onStartSession?.(),
    selectSession: (session: SessionInfo) => this.onSelectSession?.(session),
    archiveSession: (session: SessionInfo) => this.onArchiveSession?.(session),
    archiveSessionWithDescendants: (session: SessionInfo) => this.onArchiveSessionWithDescendants?.(session),
    archiveSessions: (sessions: SessionInfo[]) => this.onArchiveSessions?.(sessions),
    restoreSession: (session: SessionInfo) => this.onRestoreSession?.(session),
    deleteCachedNewSession: (session: SessionInfo) => this.onDeleteCachedNewSession?.(session),
    deleteArchivedSession: (session: SessionInfo) => this.onDeleteArchivedSession?.(session),
    deleteArchivedSessions: (sessions: SessionInfo[]) => this.onDeleteArchivedSessions?.(sessions),
    detachParentSession: (session: SessionInfo) => this.onDetachParentSession?.(session),
    markSessionRead: (session: SessionInfo) => this.onMarkSessionRead?.(session),
    markSessionUnread: (session: SessionInfo) => this.onMarkSessionUnread?.(session),
    markSessionsRead: (sessions: SessionInfo[]) => this.onMarkSessionsRead?.(sessions),
    reloadSession: (session: SessionInfo) => this.onReloadSession?.(session),
    cleanupSessions: () => this.onCleanupSessions?.(),
    previousFromProjects: () => { this.focusPreviousFrom("projects"); },
    nextFromProjects: () => { this.focusNextFrom("projects"); },
    previousFromWorkspaces: () => { this.focusPreviousFrom("workspaces"); },
    nextFromWorkspaces: () => { this.focusNextFrom("workspaces"); },
    previousFromSessions: () => { this.focusPreviousFrom("sessions"); },
    nextFromSessions: () => { this.focusNextFrom("sessions"); },
    cancelKeyboardNavigation: () => { this.cancelKeyboardNavigation(); },
  };

  override render() {
    return html`
      <header>
        ${renderPanelToggleButton("navigation", false, this.onTogglePanel)}
        <machine-switcher
          .machines=${this.machines}
          .selected=${this.selectedMachine}
          .onEdit=${this.onEditMachine}
          .locationIndicator=${this.locationIndicator}
          .statuses=${this.machineStatuses}
          .statusSnapshots=${this.machineStatusSnapshots}
          .onSelect=${(machine: Machine) => this.onSelectMachine?.(machine)}
          .onRemove=${(machine: Machine) => this.onRemoveMachine?.(machine)}
          .onFocusNextSection=${() => { this.focusNextFrom("machines"); }}
          .onCancelKeyboardNavigation=${() => { this.cancelKeyboardNavigation(); }}
        ></machine-switcher>
        <div class="header-actions">
          ${this.refreshControl}
          <button type="button" class="ui-button actions-button" title=${m.t("showActions")} aria-label=${m.t("showActions")} @click=${() => { this.onShowActions?.(); }}>
            <svg class="actions-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M13 2 4 14h7l-1 8 10-13h-7V2Z"></path>
            </svg>
            <span class="actions-label">${m.t("actions")}</span>
          </button>
        </div>
      </header>
      <div class="navigation-sections">
      ${this.compact && shouldShowMachinesSection(this.machines) ? html`
        <machine-list
          .machines=${this.machines}
          .selected=${this.selectedMachine}
          .statuses=${this.machineStatuses}
          .statusSnapshots=${this.machineStatusSnapshots}
          .collapsible=${this.collapsible}
          .collapsed=${this.machinesCollapsed}
          .onEdit=${this.onEditMachine}
          .onToggleCollapsed=${() => { this.onToggleMachines?.(); }}
          .onSelect=${(machine: Machine) => this.onSelectMachine?.(machine)}
          .onRemove=${(machine: Machine) => this.onRemoveMachine?.(machine)}
          .onFocusNextSection=${() => { this.focusNextFrom("machines"); }}
          .onCancelKeyboardNavigation=${() => { this.cancelKeyboardNavigation(); }}
        ></machine-list>
      ` : null}
      <project-list
        id="navigation-projects"
        style=${styleMap(this.sectionSizeStyle("projects"))}
        ?data-manual-size=${!this.compact && this.sectionSizes.height("projects") !== undefined}
        .projects=${this.projects}
        .selected=${this.selectedProject}
        .statusSnapshot=${this.selectedMachineStatusSnapshot()}
        .collapsible=${this.collapsible}
        .collapsed=${this.projectsCollapsed}
        .onToggleCollapsed=${this.childCallbacks.toggleProjects}
        .onSelect=${this.childCallbacks.selectProject}
        .onClose=${this.childCallbacks.closeProject}
        .onMove=${this.childCallbacks.moveProject}
        .onReorder=${this.childCallbacks.reorderProject}
        .onFocusPreviousSection=${this.childCallbacks.previousFromProjects}
        .onFocusNextSection=${this.childCallbacks.nextFromProjects}
        .onCancelKeyboardNavigation=${this.childCallbacks.cancelKeyboardNavigation}
      ></project-list>
      ${this.projectsCollapsed ? null : this.renderSectionResizeHandle("projects")}
      ${this.workspaceSelectionVisible ? html`<workspace-list
        id="navigation-workspaces"
        style=${styleMap(this.sectionSizeStyle("workspaces"))}
        ?data-manual-size=${!this.compact && this.sectionSizes.height("workspaces") !== undefined}
        .workspaces=${this.workspaces}
        .selected=${this.selectedWorkspace}
        .machineId=${this.selectedMachine?.id ?? "local"}
        .statusSnapshot=${this.selectedMachineStatusSnapshot()}
        .deletingWorkspaceIds=${this.deletingWorkspaceIds}
        .collapsible=${this.collapsible}
        .collapsed=${this.workspacesCollapsed}
        .workspaceLabelItems=${this.workspaceLabelItems}
        .onToggleCollapsed=${this.childCallbacks.toggleWorkspaces}
        .onSelect=${this.childCallbacks.selectWorkspace}
        .onDelete=${this.childCallbacks.deleteWorkspace}
        .onMove=${this.childCallbacks.moveWorkspace}
        .onFocusPreviousSection=${this.childCallbacks.previousFromWorkspaces}
        .onFocusNextSection=${this.childCallbacks.nextFromWorkspaces}
        .onCancelKeyboardNavigation=${this.childCallbacks.cancelKeyboardNavigation}
      ></workspace-list>
      ${this.workspacesCollapsed ? null : this.renderSectionResizeHandle("workspaces")}` : null}
      <session-list
        .sessions=${this.sessions}
        .pinnedRootIds=${this.pinnedRootIds}
        .onPin=${this.childCallbacks.pinSession}
        .onUnpin=${this.childCallbacks.unpinSession}
        .onMovePin=${this.childCallbacks.moveSessionPin}
        .statuses=${this.sessionStatuses}
        .activities=${this.sessionActivities}
        .sessionFlags=${this.selectedMachineStatusSnapshot()?.sessions}
        .sending=${this.sendingPrompts}
        .unreadSessionIds=${this.unreadSessionIds}
        .selected=${this.selectedSession}
        .sessionLabelItems=${this.sessionLabelItems}
        .startingCount=${this.startingSessionCount}
        .canStart=${this.canStartSession}
        .collapsible=${this.collapsible}
        .collapsed=${this.sessionsCollapsed}
        .onToggleCollapsed=${this.childCallbacks.toggleSessions}
        .onArchivedCollapsed=${this.childCallbacks.archivedCollapsed}
        .onStart=${this.childCallbacks.startSession}
        .onSelect=${this.childCallbacks.selectSession}
        .onArchive=${this.childCallbacks.archiveSession}
        .onArchiveWithDescendants=${this.childCallbacks.archiveSessionWithDescendants}
        .onArchiveMany=${this.childCallbacks.archiveSessions}
        .onRestore=${this.childCallbacks.restoreSession}
        .onDelete=${this.childCallbacks.deleteCachedNewSession}
        .onDeleteArchived=${this.childCallbacks.deleteArchivedSession}
        .onDeleteArchivedMany=${this.childCallbacks.deleteArchivedSessions}
        .onDetachParent=${this.childCallbacks.detachParentSession}
        .onMarkRead=${this.childCallbacks.markSessionRead}
        .onMarkUnread=${this.childCallbacks.markSessionUnread}
        .onMarkReadMany=${this.childCallbacks.markSessionsRead}
        .onReload=${this.childCallbacks.reloadSession}
        .onCleanup=${this.childCallbacks.cleanupSessions}
        .onFocusPreviousSection=${this.childCallbacks.previousFromSessions}
        .onFocusNextSection=${this.childCallbacks.nextFromSessions}
        .onCancelKeyboardNavigation=${this.childCallbacks.cancelKeyboardNavigation}
      ></session-list>
      </div>
    `;
  }

  private sectionSizeStyle(section: ResizableNavigationSection): Record<string, string> {
    const height = this.sectionSizes.height(section);
    return this.compact || height === undefined ? {} : { "--navigation-section-height": `${String(height)}px` };
  }

  private renderSectionResizeHandle(section: ResizableNavigationSection) {
    if (this.compact) return null;
    return html`<navigation-section-resize-handle
      .sectionLabel=${m.t(section === "projects" ? "projects" : "workspaces")}
      .controls=${`navigation-${section}`}
      .measurement=${this.sectionMeasurements[section]}
      .onResize=${(height: number) => { this.sectionSizes.resize(section, height); }}
      .onReset=${() => { this.sectionSizes.reset(section); }}
    ></navigation-section-resize-handle>`;
  }

  private measureSection(section: ResizableNavigationSection): NavigationSectionMeasurement {
    const target = this.renderRoot.querySelector<HTMLElement>(`#navigation-${section}`);
    const height = target?.getBoundingClientRect().height ?? 44;
    // Leave other sections where they are and preserve at least a session heading.
    const sessionsHeight = this.sessionList?.getBoundingClientRect().height ?? 44;
    return { height, maxHeight: Math.max(44, height + sessionsHeight - 44) };
  }

  /**
   * Project and workspace rows always belong to the selected machine, resolved
   * exactly as the rest of the app resolves it — including its local-machine
   * default, which is the key snapshots arrive under before a machine has been
   * selected. Diverging here would blank every row's indicator while a snapshot
   * is in fact loaded.
   */
  private selectedMachineStatusSnapshot(): MachineStatusSnapshot | undefined {
    return this.machineStatusSnapshots[selectedMachineId({ selectedMachine: this.selectedMachine })];
  }

  private async focusNavigableSection(section: KeyboardNavigableSection | undefined): Promise<boolean> {
    if (section === undefined) return false;
    return await section.focusSelectedOrFirst();
  }

  private focusPreviousFrom(section: NavigationSection): void {
    const target = previousVisibleNavigationTarget(section, this.machines, this.workspaceSelectionVisible);
    if (target !== undefined) void this.onFocusNavigationTarget?.(target);
  }

  private focusNextFrom(section: NavigationSection): void {
    void this.onFocusNavigationTarget?.(nextVisibleNavigationTarget(section, this.machines, this.workspaceSelectionVisible));
  }

  private cancelKeyboardNavigation(): void {
    void this.onCancelKeyboardNavigation?.();
  }

  static override styles = [uiButtonStyles, css`
    :host { display: flex; flex-direction: column; min-height: 0; overflow: hidden; container: navigation-panel / inline-size; }
    :host([compact]) { flex: 1 1 auto; }
    header { flex: 0 0 auto; display: flex; align-items: stretch; min-height: 44px; gap: 0; padding: 0; border-bottom: 1px solid var(--pi-border); }
    machine-switcher { flex: 1 1 auto; min-width: 0; }
    :host([compact]) header { display: none; }
    .header-actions { flex: 0 0 auto; display: flex; align-items: stretch; gap: 0; border-inline-start: 1px solid var(--pi-border-muted); }
    .header-actions > * + * { border-inline-start: 1px solid var(--pi-border-muted); }
    .panel-toggle { border-inline-end: 1px solid var(--pi-border-muted); }
    .actions-icon { flex: 0 0 auto; width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    @container navigation-panel (max-width: 400px) {
      .actions-label { display: none; }
      .actions-button { min-width: 44px; padding-inline: 0; }
    }
    .navigation-sections { display: flex; flex-direction: column; flex: 1 1 0px; min-height: 0; }
    /* Projects and workspaces default to content height capped at a third of
       the area below the header, matching sessions when both lists are long.
       Explicit heights survive content/navigation changes; flex shrink only
       constrains them when the viewport cannot fit every section's minimum.
       Sessions take the remaining space. */
    machine-list, project-list, workspace-list, session-list { box-sizing: border-box; flex: 1 1 0px; min-height: 0; overflow: hidden; border-bottom: 1px solid var(--pi-border-muted); }
    project-list:not([collapsed]), workspace-list:not([collapsed]) { flex: 0 1 auto; max-height: calc(100% / 3); min-height: 44px; }
    project-list[data-manual-size]:not([collapsed]), workspace-list[data-manual-size]:not([collapsed]) { flex-basis: var(--navigation-section-height); max-height: none; }
    session-list:not([collapsed]) { min-height: 44px; }
    :host([compact]) project-list:not([collapsed]), :host([compact]) workspace-list:not([collapsed]) { flex: 1 1 0px; max-height: none; }
    /* A collapsed heading already owns its separator; do not add a second line. */
    machine-list[collapsed],
    project-list[collapsed],
    workspace-list[collapsed],
    session-list[collapsed] { flex: 0 0 auto; min-height: auto; overflow: hidden; border-bottom: 0; }
  `];
}

export function shouldShowMachinesSection(machines: readonly Machine[]): boolean {
  return machines.length > 1;
}

function previousVisibleNavigationTarget(section: NavigationSection, machines: readonly Machine[], workspaceSelectionVisible: boolean): NavigationSection | undefined {
  const sections = visibleNavigationSections(machines, workspaceSelectionVisible);
  return sections[sections.indexOf(section) - 1];
}

function nextVisibleNavigationTarget(section: NavigationSection, machines: readonly Machine[], workspaceSelectionVisible: boolean): NavigationFocusTarget {
  const sections = visibleNavigationSections(machines, workspaceSelectionVisible);
  return sections[sections.indexOf(section) + 1] ?? "chat";
}

// Only a machine choice makes the machines section navigable: with a single
// machine the switcher is a static identity, and compact mode has no list.
function visibleNavigationSections(machines: readonly Machine[], workspaceSelectionVisible: boolean): NavigationSection[] {
  return NAVIGATION_SECTION_ORDER.filter((section) => (section !== "machines" || shouldShowMachinesSection(machines))
    && (section !== "workspaces" || workspaceSelectionVisible));
}
