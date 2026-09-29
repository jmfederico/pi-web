import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import type { Machine, MachineHealth, Project, SessionActivity, SessionInfo, SessionStatus, Workspace } from "../../api";
import type { MachineStatusSnapshot } from "../../../../shared/machineStatus";
import type { WorkspaceLabelItem } from "../../plugins/types";
import { selectedMachineId } from "../../controllers/types";
import type { NavigationSection } from "../../appShell/navigationState";
import { NAVIGATION_SECTION_ORDER } from "../../appShell/navigationState";
import type { KeyboardNavigableSection } from "../navigationFocus";
import "../MachineList";
import "../MachineSwitcher";
import "../ProjectList";
import "../WorkspaceList";
import "../SessionList";

export type NavigationFocusTarget = NavigationSection | "chat";

@customElement("app-navigation-panel")
export class AppNavigationPanel extends LitElement {
  @property({ attribute: false }) machines: Machine[] = [];
  @property({ attribute: false }) selectedMachine?: Machine;
  /** PWA display mode: surfaces the single-machine identity bubble in the header. */
  @property({ type: Boolean }) locationIndicator = false;
  @property({ attribute: false }) machineStatuses: Record<string, MachineHealth> = {};
  @property({ attribute: false }) machineStatusSnapshots: Record<string, MachineStatusSnapshot> = {};
  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) selectedProject?: Project;
  @property({ attribute: false }) workspaces: Workspace[] = [];
  @property({ attribute: false }) selectedWorkspace?: Workspace;
  @property({ attribute: false }) sessions: SessionInfo[] = [];
  @property({ attribute: false }) selectedSession?: SessionInfo;
  @property({ attribute: false }) sessionActivities: Record<string, SessionActivity> = {};
  @property({ attribute: false }) sessionStatuses: Record<string, SessionStatus> = {};
  @property({ attribute: false }) sendingPrompts: Record<string, true> = {};
  @property({ attribute: false }) unreadSessionIds: ReadonlySet<string> = new Set();
  @property({ attribute: false }) deletingWorkspaceIds: string[] = [];
  // Unlike event callbacks, this provider affects rendered content; replacements
  // must remain reactive inputs to WorkspaceList.
  @property({ attribute: false }) workspaceLabelItems: (workspace: Workspace) => WorkspaceLabelItem[] = () => [];
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
  @property({ attribute: false }) onToggleMachines?: () => void;
  @property({ attribute: false }) onToggleProjects?: () => void;
  @property({ attribute: false }) onToggleWorkspaces?: () => void;
  @property({ attribute: false }) onToggleSessions?: () => void;
  @property({ attribute: false }) onSelectProject?: (project: Project) => void | Promise<void>;
  @property({ attribute: false }) onCloseProject?: (project: Project) => void | Promise<void>;
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
  @property({ attribute: false }) onMarkSessionsRead?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onReloadSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onCleanupSessions?: () => void | Promise<void>;
  @property({ attribute: false }) onArchivedCollapsed?: () => void | Promise<void>;
  @property({ attribute: false }) onSelectMachine?: (machine: Machine) => void | Promise<void>;
  @property({ attribute: false }) onRemoveMachine?: (machine: Machine) => void | Promise<void>;
  @property({ attribute: false }) onFocusNavigationTarget?: (target: NavigationFocusTarget) => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;

  @query("machine-list") private machineList?: KeyboardNavigableSection;
  @query("machine-switcher") private machineSwitcher?: KeyboardNavigableSection;
  @query("project-list") private projectList?: KeyboardNavigableSection;
  @query("workspace-list") private workspaceList?: KeyboardNavigableSection;
  @query("session-list") private sessionList?: KeyboardNavigableSection;

  async focusSection(section: NavigationSection): Promise<boolean> {
    await this.updateComplete;
    switch (section) {
      case "machines": return await this.focusNavigableSection(this.compact ? this.machineList : this.machineSwitcher);
      case "projects": return await this.focusNavigableSection(this.projectList);
      case "workspaces": return await this.focusNavigableSection(this.workspaceList);
      case "sessions": return await this.focusNavigableSection(this.sessionList);
    }
  }

  // Stable child inputs delegate at invocation time, never capturing old props.
  private readonly childCallbacks = {
    toggleProjects: () => { this.onToggleProjects?.(); },
    selectProject: (project: Project) => this.onSelectProject?.(project),
    closeProject: (project: Project) => this.onCloseProject?.(project),
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
        <strong>PI WEB</strong>
        <machine-switcher
          .machines=${this.machines}
          .selected=${this.selectedMachine}
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
          <button title="Show Actions" aria-label="Show Actions" @click=${() => { this.onShowActions?.(); }}>Actions</button>
        </div>
      </header>
      ${this.compact && shouldShowMachinesSection(this.machines) ? html`
        <machine-list
          .machines=${this.machines}
          .selected=${this.selectedMachine}
          .statuses=${this.machineStatuses}
          .statusSnapshots=${this.machineStatusSnapshots}
          .collapsible=${this.collapsible}
          .collapsed=${this.machinesCollapsed}
          .onToggleCollapsed=${() => { this.onToggleMachines?.(); }}
          .onSelect=${(machine: Machine) => this.onSelectMachine?.(machine)}
          .onRemove=${(machine: Machine) => this.onRemoveMachine?.(machine)}
          .onFocusNextSection=${() => { this.focusNextFrom("machines"); }}
          .onCancelKeyboardNavigation=${() => { this.cancelKeyboardNavigation(); }}
        ></machine-list>
      ` : null}
      <project-list
        .projects=${this.projects}
        .selected=${this.selectedProject}
        .statusSnapshot=${this.selectedMachineStatusSnapshot()}
        .collapsible=${this.collapsible}
        .collapsed=${this.projectsCollapsed}
        .onToggleCollapsed=${this.childCallbacks.toggleProjects}
        .onSelect=${this.childCallbacks.selectProject}
        .onClose=${this.childCallbacks.closeProject}
        .onFocusPreviousSection=${this.childCallbacks.previousFromProjects}
        .onFocusNextSection=${this.childCallbacks.nextFromProjects}
        .onCancelKeyboardNavigation=${this.childCallbacks.cancelKeyboardNavigation}
      ></project-list>
      <workspace-list
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
        .onFocusPreviousSection=${this.childCallbacks.previousFromWorkspaces}
        .onFocusNextSection=${this.childCallbacks.nextFromWorkspaces}
        .onCancelKeyboardNavigation=${this.childCallbacks.cancelKeyboardNavigation}
      ></workspace-list>
      <session-list
        .sessions=${this.sessions}
        .statuses=${this.sessionStatuses}
        .activities=${this.sessionActivities}
        .sending=${this.sendingPrompts}
        .unreadSessionIds=${this.unreadSessionIds}
        .selected=${this.selectedSession}
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
        .onMarkReadMany=${this.childCallbacks.markSessionsRead}
        .onReload=${this.childCallbacks.reloadSession}
        .onCleanup=${this.childCallbacks.cleanupSessions}
        .onFocusPreviousSection=${this.childCallbacks.previousFromSessions}
        .onFocusNextSection=${this.childCallbacks.nextFromSessions}
        .onCancelKeyboardNavigation=${this.childCallbacks.cancelKeyboardNavigation}
      ></session-list>
    `;
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
    const target = previousVisibleNavigationTarget(section, this.machines);
    if (target !== undefined) void this.onFocusNavigationTarget?.(target);
  }

  private focusNextFrom(section: NavigationSection): void {
    void this.onFocusNavigationTarget?.(nextVisibleNavigationTarget(section, this.machines));
  }

  private cancelKeyboardNavigation(): void {
    void this.onCancelKeyboardNavigation?.();
  }

  static override styles = css`
    :host { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
    :host([compact]) { flex: 1 1 auto; }
    header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px; border-bottom: 1px solid var(--pi-border); }
    header strong { flex: 0 0 auto; }
    machine-switcher { flex: 1 1 auto; min-width: 0; }
    :host([compact]) header { display: none; }
    .header-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
    /* Expanded sections share the panel height equally, so collapsing one
       section distributes its space to every remaining section, not just the
       session list. Collapsed sections keep only their heading height. */
    machine-list, project-list, workspace-list, session-list { flex: 1 1 0px; min-height: 0; overflow: hidden; border-bottom: 1px solid var(--pi-border-muted); }
    machine-list[collapsed],
    project-list[collapsed],
    workspace-list[collapsed],
    session-list[collapsed] { flex: 0 0 auto; min-height: auto; overflow: hidden; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
  `;
}

export function shouldShowMachinesSection(machines: readonly Machine[]): boolean {
  return machines.length > 1;
}

function previousVisibleNavigationTarget(section: NavigationSection, machines: readonly Machine[]): NavigationSection | undefined {
  const sections = visibleNavigationSections(machines);
  return sections[sections.indexOf(section) - 1];
}

function nextVisibleNavigationTarget(section: NavigationSection, machines: readonly Machine[]): NavigationFocusTarget {
  const sections = visibleNavigationSections(machines);
  return sections[sections.indexOf(section) + 1] ?? "chat";
}

// Only a machine choice makes the machines section navigable: with a single
// machine the switcher is a static bubble, and compact mode has no list.
function visibleNavigationSections(machines: readonly Machine[]): NavigationSection[] {
  return NAVIGATION_SECTION_ORDER.filter((section) => section !== "machines" || shouldShowMachinesSection(machines));
}
