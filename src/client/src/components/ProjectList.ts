import { LocalizationController, localization } from "../localization/browser";
import { projectWorkspaceMessages as messages } from "../projectWorkspaceMessages";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { Project } from "../api";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { renderCopyIdAction } from "./copyIdAction";
import { createActionMenuController } from "./actionMenu";
import { hasStatusUnread, renderActionActivityIndicator, statusActivityKind } from "./activityBadge";
import type { KeyboardNavigableSection } from "./navigationFocus";
import { activateSelectableRow, focusSelectedOrFirstSelectableRow, handleSelectableRowKeyboard } from "./selectableRow";
import { listStyles } from "./shared";
import { sidebarListStyles } from "./sidebarListStyles";

@customElement("project-list")
export class ProjectList extends LitElement implements KeyboardNavigableSection {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) selected?: Project;
  @property({ type: Boolean }) selectionLoading = false;
  /** Status tree of the machine these projects belong to; absent means no indicators. */
  @property({ attribute: false }) statusSnapshot: MachineStatusSnapshot | undefined;
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ attribute: false }) onSelect?: (project: Project) => void;
  @property({ attribute: false }) onClose?: (project: Project) => void;
  @property({ attribute: false }) onMove?: (project: Project, direction: -1 | 1) => void;
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @property({ attribute: false }) onFocusPreviousSection?: () => void | Promise<void>;
  @property({ attribute: false }) onFocusNextSection?: () => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;
  @state() private openMenuProjectId: string | undefined;
  readonly actionMenu = createActionMenuController(this, () => {
    if (this.openMenuProjectId === undefined) return undefined;
    const row = [...this.renderRoot.querySelectorAll<HTMLElement>("[data-project-id]")].find((item) => item.dataset["projectId"] === this.openMenuProjectId);
    return row?.querySelector<HTMLElement>(".action-menu-toggle") ?? undefined;
  }, () => { this.openMenuProjectId = undefined; });

  private focusedControl: HTMLElement | undefined;
  private focusAfterReorder: HTMLElement | undefined;

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("projects")) this.focusAfterReorder = this.focusedControl;
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
                  class=${`action-row ui-nav-row ${current ? "selected" : ""}`}
                  data-current=${String(current)}
                  aria-current=${current ? "true" : nothing}
                  data-activity=${kind ?? "idle"}
                  data-busy=${String(kind === "session" || kind === "sending")}
                  data-unread=${String(unread)}
                  tabindex="0"
                  data-project-id=${project.id}
                  @focusin=${(event: FocusEvent) => { this.focusedControl = event.target instanceof HTMLElement ? event.target : undefined; }}
                  @focusout=${() => { this.focusedControl = undefined; }}
                  title=${project.path}
                  @click=${(event: MouseEvent) => { activateSelectableRow(event, () => this.onSelect?.(project)); }}
                  @keydown=${(event: KeyboardEvent) => { this.handleProjectKeydown(event, project); }}
                >
                  <div class="action-main ui-nav-row-main">
                    <span class="workspace-primary"><span class="workspace-primary-label ui-nav-row-label"><bdi>${project.name}</bdi></span></span><small class="ui-nav-row-meta"><bdi dir="ltr">${project.path}</bdi></small>
                    ${this.renderActivity(kind, unread)}
                  </div>
                  <div class="action-menu ui-nav-row-actions">
                    <button class="ui-button ui-button--icon action-menu-toggle ui-nav-row-action ui-popup-trigger" aria-expanded=${String(this.openMenuProjectId === project.id)} aria-controls=${`project-menu-${encodeURIComponent(project.id)}`} title=${messages.t("projectActions")} aria-label=${messages.t("actionsFor", { name: project.name })} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(project.id); }}>⋯</button>
                    ${this.openMenuProjectId === project.id ? html`
                      <div popover="auto" class="action-menu-panel ui-menu ui-nav-row-menu ui-popup-panel" data-ui-context="project-actions" id=${`project-menu-${encodeURIComponent(project.id)}`} @click=${(event: MouseEvent) => { event.stopPropagation(); }}>
                        ${this.onMove === undefined ? null : html`
                          <button class="ui-button ui-menu-item" data-move ?disabled=${index === 0} @click=${() => { this.onMove?.(project, -1); }}>${messages.t("moveUp")}</button>
                          <button class="ui-button ui-menu-item" data-move ?disabled=${index === this.projects.length - 1} @click=${() => { this.onMove?.(project, 1); }}>${messages.t("moveDown")}</button>
                        `}
                        <button class="ui-button ui-menu-item" title=${messages.t("closeProject")} @click=${() => { this.close(project); }}>${messages.t("close")}</button>
                        ${renderCopyIdAction("project", project.id, () => { this.openMenuProjectId = undefined; })}
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

  private toggleMenu(projectId: string) {
    if (this.openMenuProjectId === projectId) {
      this.openMenuProjectId = undefined;
      return;
    }
    this.openMenuProjectId = projectId;
  }

  private close(project: Project) {
    this.openMenuProjectId = undefined;
    if (confirm(messages.t("confirmClose", { name: project.name }))) this.onClose?.(project);
  }

  static override styles = [listStyles, sidebarListStyles];
}
