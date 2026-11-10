import { LocalizationController, localization } from "../localization/browser";
import { projectWorkspaceMessages as messages } from "../projectWorkspaceMessages";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { trustApi, workspacesApi, type Project } from "../api";
import { CORE_STATUS_FLAGS, type MachineStatusSnapshot } from "../../../shared/machineStatus";
import { renderCopyIdAction } from "./copyIdAction";
import { DetailCopyController } from "./detailCopy";
import { createActionMenuController } from "./actionMenu";
import { hasStatusUnread, renderActionActivityIndicator, statusActivityKind } from "./activityBadge";
import type { KeyboardNavigableSection } from "./navigationFocus";
import { activateSelectableRow, focusSelectedOrFirstSelectableRow, handleSelectableRowKeyboard } from "./selectableRow";
import { listStyles } from "./shared";
import { sidebarListStyles } from "./sidebarListStyles";
import type { DropPosition } from "./listReorder";
import { ListReorderController } from "./listReorderController";
import { renderTrustMenuControl, type TrustMenuState } from "./trustMenuControl";

interface RootTrustState extends TrustMenuState {
  workspaceId?: string;
}

@customElement("project-list")
export class ProjectList extends LitElement implements KeyboardNavigableSection {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) machineId = "local";
  @property({ attribute: false }) selected?: Project;
  @property({ type: Boolean }) selectionLoading = false;
  /** Status tree of the machine these projects belong to; absent means no indicators. */
  @property({ attribute: false }) statusSnapshot: MachineStatusSnapshot | undefined;
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ attribute: false }) onSelect?: (project: Project) => void;
  @property({ attribute: false }) onClose?: (project: Project) => void;
  @property({ attribute: false }) onMove?: (project: Project, direction: -1 | 1) => void;
  /** The parent persists a drop relative to a visible neighbor. */
  @property({ attribute: false }) onReorder?: (project: Project, neighbor: Project, position: DropPosition) => void;
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @property({ attribute: false }) onFocusPreviousSection?: () => void | Promise<void>;
  @property({ attribute: false }) onFocusNextSection?: () => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;
  @state() private openMenuProjectId: string | undefined;
  @state() private rootTrustByScope: Record<string, RootTrustState> = {};
  readonly actionMenu = createActionMenuController(this, () => {
    if (this.openMenuProjectId === undefined) return undefined;
    const row = [...this.renderRoot.querySelectorAll<HTMLElement>("[data-project-id]")].find((item) => item.dataset["projectId"] === this.openMenuProjectId);
    return row?.querySelector<HTMLElement>(".action-menu-toggle") ?? undefined;
  }, () => { this.openMenuProjectId = undefined; });

  private readonly detailCopy = new DetailCopyController(this);
  private focusedControl: HTMLElement | undefined;
  private focusAfterReorder: HTMLElement | undefined;
  private readonly reorder: ListReorderController<Project> = new ListReorderController<Project>(this, {
    items: () => this.projects,
    enabled: () => this.onReorder !== undefined && !this.collapsed,
    onDrop: (project, neighbor, position) => { this.onReorder?.(project, neighbor, position); },
    onStart: () => { this.openMenuProjectId = undefined; },
    label: (project) => project.name,
  });

  private reorderMembership = "";

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("projects")) this.focusAfterReorder = this.focusedControl;
    const membership = JSON.stringify(this.projects.map(({ id }) => id));
    if (membership !== this.reorderMembership || changed.has("machineId") || this.collapsed || this.onReorder === undefined) this.reorder.cancel();
    this.reorderMembership = membership;
    if (changed.has("machineId")) this.openMenuProjectId = undefined;
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("projects") && this.focusAfterReorder?.isConnected === true) {
      const control = this.focusAfterReorder;
      const target = control instanceof HTMLButtonElement && control.disabled
        ? control.closest(".action-menu-panel")?.querySelector<HTMLElement>("button[data-move]:not(:disabled)")
        : control;
      target?.focus({ preventScroll: true });
    }
    this.focusAfterReorder = undefined;
    if (changed.has("projects") && this.openMenuProjectId !== undefined && !this.projects.some((project) => project.id === this.openMenuProjectId)) this.openMenuProjectId = undefined;
    if (changed.has("collapsed") && this.collapsed) this.openMenuProjectId = undefined;
  }

  async focusSelectedOrFirst(): Promise<boolean> {
    await this.updateComplete;
    return focusSelectedOrFirstSelectableRow(this.renderRoot, { fallbackSelector: ".section-toggle" });
  }

  override render() {
    return html`
      <span class="list-reorder-status" role="status">${this.reorder.announcement}</span>
      <section data-ui-context="projects" data-collapsed=${String(this.collapsed)}>
        <h2 class="ui-toolbar">${this.renderHeading()}</h2>
        ${this.collapsed ? null : html`
          <div class="list-body ui-nav-list" aria-busy=${String(this.selectionLoading)}>
            ${repeat(this.projects, (project) => project.id, (project, index) => {
              const flags = this.statusSnapshot?.projects[project.id];
              const kind = statusActivityKind(flags);
              const unread = hasStatusUnread(flags);
              const current = this.selected?.id === project.id;
              return html`
                <div
                  class=${`action-row ui-nav-row ${current ? "selected" : ""} ${this.reorder.rowClass(project.id)}`}
                  data-reorderable=${String(this.onReorder !== undefined)}
                  data-current=${String(current)}
                  aria-current=${current ? "true" : nothing}
                  data-activity=${kind ?? "idle"}
                  data-busy=${String(flags?.[CORE_STATUS_FLAGS.working] === true)}
                  data-unread=${String(unread)}
                  tabindex="0"
                  data-project-id=${project.id}
                  data-reorder-id=${this.onReorder === undefined ? nothing : project.id}
                  @focusin=${(event: FocusEvent) => { this.focusedControl = event.target instanceof HTMLElement ? event.target : undefined; }}
                  @focusout=${() => { this.focusedControl = undefined; }}
                  title=${project.path}
                  @pointerdown=${(event: PointerEvent) => { this.reorder.begin(event, project); }}
                  @lostpointercapture=${() => { this.reorder.cancel(); }}
                  @contextmenu=${(event: MouseEvent) => { if (this.reorder.draggingId !== undefined) event.preventDefault(); }}
                  @click=${(event: MouseEvent) => {
                    if (this.reorder.consumeClick()) { event.preventDefault(); event.stopPropagation(); return; }
                    activateSelectableRow(event, () => this.onSelect?.(project));
                  }}
                  @keydown=${(event: KeyboardEvent) => { this.handleProjectKeydown(event, project); }}
                >
                  <div class="action-main ui-nav-row-main">
                    <span class="workspace-primary"><span class="workspace-primary-label ui-nav-row-label"><bdi>${project.name}</bdi></span></span><small class="ui-nav-row-meta"><bdi dir="ltr">${project.path}</bdi></small>
                    ${this.renderActivity(kind, unread)}
                  </div>
                  <div class="action-menu ui-nav-row-actions">
                    <button class="ui-button ui-button--icon action-menu-toggle ui-nav-row-action ui-popup-trigger" aria-expanded=${String(this.openMenuProjectId === project.id)} aria-controls=${`project-menu-${encodeURIComponent(project.id)}`} title=${messages.t("projectActions")} aria-label=${messages.t("actionsFor", { name: project.name })} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(project); }}>⋯</button>
                    ${this.openMenuProjectId === project.id ? html`
                      <div popover="auto" class="action-menu-panel ui-menu ui-menu--grouped ui-nav-row-menu ui-popup-panel" data-ui-context="project-actions" id=${`project-menu-${encodeURIComponent(project.id)}`} @click=${(event: MouseEvent) => { event.stopPropagation(); }}>
                        <div class="ui-menu-group" data-menu-group="actions">
                          ${this.onMove === undefined ? null : html`
                            <button class="ui-button ui-menu-item" data-move ?disabled=${index === 0} @click=${() => { this.onMove?.(project, -1); }}>${messages.t("moveUp")}</button>
                            <button class="ui-button ui-menu-item" data-move ?disabled=${index === this.projects.length - 1} @click=${() => { this.onMove?.(project, 1); }}>${messages.t("moveDown")}</button>
                          `}
                          <button class="ui-button ui-menu-item" title=${messages.t("closeProject")} @click=${() => { this.close(project); }}>${messages.t("closeProject")}</button>
                        </div>
                        ${this.renderRootTrust(project)}
                        <div class="ui-menu-group" data-menu-group="details">
                          <dl class="workspace-menu-details ui-menu-details">
                            <div class="workspace-detail-row ui-menu-detail">
                              <dt>${messages.t("path")}</dt>
                              <dd title=${project.path}><bdi dir="ltr">${project.path}</bdi>${this.detailCopy.render(this.trustScope(project, this.machineId), project.path, messages.t("copyPath"))}</dd>
                            </div>
                          </dl>
                          ${renderCopyIdAction("project", project.id, this.detailCopy)}
                        </div>
                      </div>
                    ` : null}
                  </div>
                </div>
              `;
            })}
          </div>
        `}
      </section>
    `;
  }

  private handleProjectKeydown(event: KeyboardEvent, project: Project): void {
    this.reorder.consumeClick();
    handleSelectableRowKeyboard(event, {
      activate: () => this.onSelect?.(project),
      previousSection: this.onFocusPreviousSection === undefined ? undefined : () => { void this.onFocusPreviousSection?.(); },
      nextSection: this.onFocusNextSection === undefined ? undefined : () => { void this.onFocusNextSection?.(); },
      cancel: this.onCancelKeyboardNavigation === undefined ? undefined : () => { void this.onCancelKeyboardNavigation?.(); },
    });
  }

  private renderHeading() {
    if (!this.collapsible) return html`<span>${messages.t("projects")}</span>`;
    const selectedSummary = this.selected?.name ?? messages.t("noProject");
    const selectedTitle = this.selected?.path ?? selectedSummary;
    return html`<button class="ui-button ui-toolbar-title section-toggle ui-nav-section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} ${messages.t("projects")}</span>${this.collapsed ? html`<small class="section-selected" title=${selectedTitle}>${selectedSummary}</small>` : null}</span><small class="section-count" role=${this.selectionLoading ? "status" : nothing}>${this.selectionLoading ? messages.t("openingProject") : localization.number(this.projects.length)}</small></button>`;
  }

  private renderActivity(kind: ReturnType<typeof statusActivityKind>, unread: boolean) {
    const unreadLabel = unread ? messages.t("projectUnread") : undefined;
    return renderActionActivityIndicator(kind, kind === "terminal" ? messages.t("projectTerminal") : messages.t("projectActive"), unreadLabel);
  }

  private toggleMenu(project: Project) {
    if (this.openMenuProjectId === project.id) {
      this.openMenuProjectId = undefined;
      return;
    }
    this.openMenuProjectId = project.id;
    void this.loadRootTrust(project);
  }

  private renderRootTrust(project: Project) {
    return html`<div class="project-menu-trust ui-menu-group" data-menu-group="options">
      ${renderTrustMenuControl({
        id: `project-menu-${encodeURIComponent(project.id)}-trusted`,
        state: this.rootTrustByScope[this.trustScope(project, this.machineId)],
        label: messages.t("trustRoot"),
        busyLabel: messages.t("trustRootBusy"),
        onChange: (trusted) => { void this.setRootTrust(project, trusted); },
      })}
    </div>`;
  }

  private trustScope(project: Project, machineId: string): string {
    return JSON.stringify([machineId, project.id, project.path]);
  }

  private setRootTrustState(scope: string, state: RootTrustState): void {
    this.rootTrustByScope = { ...this.rootTrustByScope, [scope]: state };
  }

  private async loadRootTrust(project: Project): Promise<void> {
    const machineId = this.machineId;
    const scope = this.trustScope(project, machineId);
    const existing = this.rootTrustByScope[scope];
    if (existing?.loading === true || existing?.saving === true) return;
    this.setRootTrustState(scope, { loading: true });
    try {
      const workspaces = await workspacesApi.workspaces(project.id, machineId);
      // A provider's main workspace need not be the root. Never trust a
      // different folder merely because it is selected or marked as main.
      const root = workspaces.find((workspace) => workspace.projectId === project.id && workspace.path === project.path);
      if (root === undefined) throw new Error(messages.t("trustRootUnavailable"));
      const result = await trustApi.workspaceTrust(project.id, root.id, machineId);
      this.setRootTrustState(scope, { workspaceId: root.id, trusted: result.trusted });
    } catch (error) {
      this.setRootTrustState(scope, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async setRootTrust(project: Project, trusted: boolean): Promise<void> {
    const machineId = this.machineId;
    const scope = this.trustScope(project, machineId);
    const existing = this.rootTrustByScope[scope];
    if (existing?.workspaceId === undefined || existing.trusted === undefined || existing.loading === true || existing.saving === true) return;
    this.setRootTrustState(scope, { workspaceId: existing.workspaceId, trusted, saving: true });
    try {
      const result = await trustApi.setWorkspaceTrust(project.id, existing.workspaceId, trusted, machineId);
      this.setRootTrustState(scope, { workspaceId: existing.workspaceId, trusted: result.trusted });
    } catch (error) {
      this.setRootTrustState(scope, { ...existing, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private close(project: Project) {
    this.openMenuProjectId = undefined;
    if (confirm(messages.t("confirmClose", { name: project.name }))) this.onClose?.(project);
  }

  static override styles = [listStyles, sidebarListStyles];
}
