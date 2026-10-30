import { LocalizationController, localization } from "../localization/browser";
import { projectWorkspaceMessages as messages } from "../projectWorkspaceMessages";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { trustApi } from "../api";
import type { Workspace } from "../api";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { renderCopyIdAction } from "./copyIdAction";
import { writeClipboardText } from "../clipboard";
import type { WorkspaceLabelItem } from "../plugins/types";
import { canDeleteWorkspace, workspaceRemovalActionLabel } from "../workspaceDeletion";
import { createActionMenuController } from "./actionMenu";
import { hasStatusUnread, renderActionActivityIndicator, statusActivityKind } from "./activityBadge";
import type { KeyboardNavigableSection } from "./navigationFocus";
import { activateSelectableRow, focusSelectedOrFirstSelectableRow, handleSelectableRowKeyboard } from "./selectableRow";
import { listStyles } from "./shared";
import { sidebarListStyles } from "./sidebarListStyles";
import { renderWorkspaceLabelInlineItems } from "./workspaceLabel";

interface WorkspaceTrustState {
  loading?: boolean;
  saving?: boolean;
  trusted?: boolean;
  error?: string;
}

@customElement("workspace-list")
export class WorkspaceList extends LitElement implements KeyboardNavigableSection {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @property({ attribute: false }) workspaces: Workspace[] = [];
  @property({ attribute: false }) selected?: Workspace;
  /** Machine the listed workspaces belong to; targets the trust API. */
  @property({ attribute: false }) machineId = "local";
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ attribute: false }) workspaceLabelItems: (workspace: Workspace) => WorkspaceLabelItem[] = () => [];
  /** Status tree of the machine these workspaces belong to; absent means no indicators. */
  @property({ attribute: false }) statusSnapshot: MachineStatusSnapshot | undefined;
  @property({ attribute: false }) deletingWorkspaceIds: string[] = [];
  @property({ attribute: false }) onSelect?: (workspace: Workspace) => void;
  @property({ attribute: false }) onDelete?: (workspace: Workspace) => void;
  @property({ attribute: false }) onMove?: (workspace: Workspace, direction: -1 | 1) => void;
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @property({ attribute: false }) onFocusPreviousSection?: () => void | Promise<void>;
  @property({ attribute: false }) onFocusNextSection?: () => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;
  @state() private openMenuWorkspaceId: string | undefined;
  readonly actionMenu = createActionMenuController(this, () => {
    if (this.openMenuWorkspaceId === undefined) return undefined;
    const row = [...this.renderRoot.querySelectorAll<HTMLElement>("[data-workspace-id]")].find((item) => item.dataset["workspaceId"] === this.openMenuWorkspaceId);
    return row?.querySelector<HTMLElement>(".action-menu-toggle") ?? undefined;
  }, () => { this.openMenuWorkspaceId = undefined; });
  @state() private copiedDetailKey: string | undefined;
  @state() private trustByWorkspaceId: Record<string, WorkspaceTrustState> = {};

  private focusedControl: HTMLElement | undefined;
  private focusAfterReorder: HTMLElement | undefined;

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("workspaces")) this.focusAfterReorder = this.focusedControl;
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("workspaces") && this.focusAfterReorder?.isConnected === true) {
      const control = this.focusAfterReorder;
      const target = control instanceof HTMLButtonElement && control.disabled
        ? control.closest(".action-menu-panel")?.querySelector<HTMLElement>("button[data-move]:not(:disabled)")
        : control;
      target?.focus({ preventScroll: true });
    }
    this.focusAfterReorder = undefined;
    if (changed.has("workspaces") && this.openMenuWorkspaceId !== undefined && !this.workspaces.some((workspace) => workspace.id === this.openMenuWorkspaceId)) this.openMenuWorkspaceId = undefined;
    if (changed.has("collapsed") && this.collapsed) this.openMenuWorkspaceId = undefined;
    if (this.shouldRevealSelectedRow(changed)) this.scrollSelectedIntoView();
  }

  /**
   * Positive reveal triggers only: topology refreshes replace `workspaces`
   * with a new array for the same selection and must never re-scroll. Reveal
   * the selected row only when the selection moves to a different row (first
   * render with a selection included) or when the section expands.
   */
  private shouldRevealSelectedRow(changed: PropertyValues<this>): boolean {
    if (this.collapsed) return false;
    if (changed.has("collapsed")) return true;
    return changed.has("selected") && changed.get("selected")?.id !== this.selected?.id;
  }

  async focusSelectedOrFirst(): Promise<boolean> {
    await this.updateComplete;
    return focusSelectedOrFirstSelectableRow(this.renderRoot, { fallbackSelector: ".section-toggle" });
  }

  override render() {
    return html`
      <section data-ui-context="workspaces" data-collapsed=${String(this.collapsed)}>
        <h2 class="ui-toolbar">${this.renderHeading()}</h2>
        ${this.collapsed ? null : html`
          <div class="list-body ui-nav-list">
            ${repeat(this.workspaces, (workspace) => workspace.id, (workspace, index) => {
              const label = workspacePrimaryLabel(workspace);
              const items = this.workspaceLabelItems(workspace);
              const flags = this.statusSnapshot?.workspaces[workspace.id];
              const kind = statusActivityKind(flags);
              const unread = hasStatusUnread(flags);
              const current = this.selected?.id === workspace.id;
              return html`
                <div
                  class=${`action-row workspace-row ui-nav-row ${current ? "selected" : ""}`}
                  data-current=${String(current)}
                  aria-current=${current ? "true" : nothing}
                  data-activity=${kind ?? "idle"}
                  data-busy=${String(kind === "session" || kind === "sending" || this.isDeleting(workspace))}
                  data-unread=${String(unread)}
                  tabindex="0"
                  data-workspace-id=${workspace.id}
                  @focusin=${(event: FocusEvent) => { this.focusedControl = event.target instanceof HTMLElement ? event.target : undefined; }}
                  @focusout=${() => { this.focusedControl = undefined; }}
                  title=${label}
                  @click=${(event: MouseEvent) => { activateSelectableRow(event, () => this.onSelect?.(workspace)); }}
                  @keydown=${(event: KeyboardEvent) => { this.handleWorkspaceKeydown(event, workspace); }}
                >
                  <div class="action-main ui-nav-row-main">
                    ${this.renderWorkspaceMain(label, items, workspace, kind, unread)}
                  </div>
                  ${this.renderWorkspaceMenu(label, items, workspace, index)}
                </div>
              `;
            })}
          </div>
        `}
      </section>
    `;
  }

  private renderHeading() {
    if (!this.collapsible) return html`<span>${messages.t("workspaces")}</span>`;
    const selectedSummary = this.selected === undefined ? messages.t("noWorkspace") : messages.t("workspaceSummary", { label: workspacePrimaryLabel(this.selected), path: this.selected.path });
    const selectedTitle = this.selected?.path ?? selectedSummary;
    return html`<button class="ui-button ui-toolbar-title section-toggle ui-nav-section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} ${messages.t("workspaces")}</span>${this.collapsed ? html`<small class="section-selected" title=${selectedTitle}>${selectedSummary}</small>` : null}</span><small class="section-count">${localization.number(this.workspaces.length)}</small></button>`;
  }

  private renderActivity(kind: ReturnType<typeof statusActivityKind>, unread: boolean): TemplateResult | undefined {
    const unreadLabel = unread ? messages.t("workspaceUnread") : undefined;
    return renderActionActivityIndicator(kind, kind === "terminal" ? messages.t("workspaceTerminal") : messages.t("workspaceActive"), unreadLabel);
  }

  private renderWorkspaceMain(label: string, items: WorkspaceLabelItem[], workspace: Workspace, kind: ReturnType<typeof statusActivityKind>, unread: boolean): TemplateResult {
    return html`
      <span class="workspace-primary">
        <span class="workspace-primary-label ui-nav-row-label">${label}</span>
        ${this.isDeleting(workspace) ? html`<span class="workspace-status">${messages.t("deleting")}</span>` : null}
      </span>
      ${items.length === 0 ? null : html`
        <small class="workspace-secondary ui-nav-row-meta">
          <span class="workspace-label">${renderWorkspaceLabelInlineItems(items)}</span>
        </small>
      `}
      ${this.renderActivity(kind, unread)}
    `;
  }

  private renderWorkspaceMenu(label: string, items: WorkspaceLabelItem[], workspace: Workspace, index: number): TemplateResult {
    const open = this.openMenuWorkspaceId === workspace.id;
    const menuId = workspaceMenuId(workspace.id);
    return html`
      <div class="action-menu ui-nav-row-actions">
        <button
          class="ui-button ui-button--icon action-menu-toggle ui-nav-row-action ui-popup-trigger"
          title=${messages.t("workspaceActions")}
          aria-label=${messages.t("detailsFor", { label })}
          aria-expanded=${String(open)}
          aria-controls=${menuId}
          @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(workspace.id); }}
        >⋯</button>
        ${open ? html`
          <div popover="auto" class="action-menu-panel workspace-menu-panel ui-menu ui-nav-row-menu ui-popup-panel" data-ui-context="workspace-actions" id=${menuId} @click=${(event: MouseEvent) => { event.stopPropagation(); }}>
            ${this.renderWorkspaceActions(workspace, index)}
            ${this.renderWorkspaceDetails(label, items, workspace)}
          </div>
        ` : null}
      </div>
    `;
  }

  private renderWorkspaceActions(workspace: Workspace, index: number): TemplateResult {
    const deleting = this.isDeleting(workspace);
    const actionLabel = workspaceRemovalActionLabel(workspace) ?? messages.t("removeWorkspace");
    return html`
      <div class="workspace-menu-actions">
        ${this.onMove === undefined ? null : html`
          <button class="ui-button ui-menu-item" data-move ?disabled=${index === 0} @click=${() => { this.onMove?.(workspace, -1); }}>${messages.t("moveUp")}</button>
          <button class="ui-button ui-menu-item" data-move ?disabled=${index === this.workspaces.length - 1} @click=${() => { this.onMove?.(workspace, 1); }}>${messages.t("moveDown")}</button>
        `}
        ${this.renderTrustToggle(workspace)}
        ${canDeleteWorkspace(workspace) ? html`
          <button class="danger ui-button ui-menu-item" title=${deleting ? messages.t("removalProgress") : actionLabel} ?disabled=${deleting} @click=${() => { this.delete(workspace); }}>${deleting ? messages.t("removing") : actionLabel}</button>
        ` : null}
        ${renderCopyIdAction("workspace", workspace.id, () => { this.openMenuWorkspaceId = undefined; })}
      </div>
    `;
  }

  private renderTrustToggle(workspace: Workspace): TemplateResult {
    const trust = this.trustByWorkspaceId[workspace.id];
    const busy = trust?.loading === true || trust?.saving === true;
    const inputId = `${workspaceMenuId(workspace.id)}-trusted`;
    const helpId = `${inputId}-help`;
    const errorId = `${inputId}-error`;
    return html`
      <div class="workspace-menu-trust">
        <label class="action-menu-checkbox ui-menu-item" data-busy=${busy} for=${inputId}>
          <span>${busy ? messages.t("trustedBusy") : messages.t("trusted")}</span>
          <input
            id=${inputId}
            type="checkbox"
            aria-describedby=${trust?.error === undefined ? helpId : `${helpId} ${errorId}`}
            .checked=${trust?.trusted === true}
            ?disabled=${busy || trust?.trusted === undefined}
            @change=${(event: Event) => { if (event.target instanceof HTMLInputElement) void this.setTrust(workspace, event.target.checked); }}
          />
        </label>
        <div class="action-menu-description" id=${helpId}>
          <a href="https://pi.dev/docs/latest/security" target="_blank" rel="noreferrer">${messages.t("learnTrust")}</a>
        </div>
        ${trust?.error === undefined ? null : html`<div class="action-menu-description action-menu-error" id=${errorId} role="alert">${trust.error}</div>`}
      </div>
    `;
  }

  /** Fields worth carrying across a loading/saving transition, minus any prior error. */
  private trustBase(state: WorkspaceTrustState | undefined): WorkspaceTrustState {
    return {
      ...(state?.trusted === undefined ? {} : { trusted: state.trusted }),
    };
  }

  private setTrustState(workspaceId: string, state: WorkspaceTrustState): void {
    this.trustByWorkspaceId = { ...this.trustByWorkspaceId, [workspaceId]: state };
  }

  private async loadTrust(workspace: Workspace): Promise<void> {
    const existing = this.trustByWorkspaceId[workspace.id];
    if (existing?.loading === true || existing?.saving === true) return;
    this.setTrustState(workspace.id, { ...this.trustBase(existing), loading: true });
    try {
      const result = await trustApi.workspaceTrust(workspace.projectId, workspace.id, this.machineId);
      this.setTrustState(workspace.id, { trusted: result.trusted });
    } catch (error) {
      this.setTrustState(workspace.id, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async setTrust(workspace: Workspace, trusted: boolean): Promise<void> {
    const existing = this.trustByWorkspaceId[workspace.id];
    this.setTrustState(workspace.id, { trusted, saving: true });
    try {
      const result = await trustApi.setWorkspaceTrust(workspace.projectId, workspace.id, trusted, this.machineId);
      this.setTrustState(workspace.id, { trusted: result.trusted });
    } catch (error) {
      // Keep the prior checkbox value (revert the optimistic flip) and surface why.
      this.setTrustState(workspace.id, { ...this.trustBase(existing), error: error instanceof Error ? error.message : String(error) });
    }
  }

  private renderWorkspaceDetails(label: string, items: WorkspaceLabelItem[], workspace: Workspace): TemplateResult {
    return html`
      <dl class="workspace-menu-details">
        <div class="workspace-detail-row">
          <dt>${messages.t("workspace")}</dt>
          <dd>${label}${this.renderDetailCopyButton(`${workspace.id}:label`, workspace.label, messages.t("copyLabel"))}</dd>
        </div>
        <div class="workspace-detail-row">
          <dt>${messages.t("path")}</dt>
          <dd title=${workspace.path}><bdi dir="ltr">${workspace.path}</bdi>${this.renderDetailCopyButton(`${workspace.id}:path`, workspace.path, messages.t("copyPath"))}</dd>
        </div>
        ${items.length === 0 ? null : html`
          <div class="workspace-detail-row">
            <dt>${messages.t("details")}</dt>
            <dd><span class="workspace-label">${renderWorkspaceLabelInlineItems(items)}</span></dd>
          </div>
        `}
      </dl>
    `;
  }

  private renderDetailCopyButton(key: string, value: string, action: string): TemplateResult {
    const copied = this.copiedDetailKey === key;
    const label = copied ? messages.t("copied") : action;
    return html`
      <button type="button" class="ui-button ui-button--compact ui-button--icon detail-copy" title=${label} aria-label=${label} @click=${() => { void this.copyDetail(key, value); }}>
        <span aria-hidden="true">${copied ? "✓" : "⧉"}</span>
      </button>
    `;
  }

  private async copyDetail(key: string, value: string): Promise<void> {
    const copied = await writeClipboardText(value);
    if (!copied) return;
    this.copiedDetailKey = key;
    window.setTimeout(() => {
      if (this.copiedDetailKey === key) this.copiedDetailKey = undefined;
    }, 1200);
  }

  private delete(workspace: Workspace): void {
    if (this.isDeleting(workspace)) return;
    this.openMenuWorkspaceId = undefined;
    this.onDelete?.(workspace);
  }

  private isDeleting(workspace: Workspace): boolean {
    return this.deletingWorkspaceIds.includes(workspace.id);
  }

  private toggleMenu(workspaceId: string): void {
    if (this.openMenuWorkspaceId === workspaceId) {
      this.openMenuWorkspaceId = undefined;
      return;
    }
    this.openMenuWorkspaceId = workspaceId;
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace !== undefined) void this.loadTrust(workspace);
  }

  private handleWorkspaceKeydown(event: KeyboardEvent, workspace: Workspace): void {
    if (event.key === "Escape" && this.openMenuWorkspaceId === workspace.id) {
      event.preventDefault();
      event.stopPropagation();
      this.openMenuWorkspaceId = undefined;
      return;
    }
    handleSelectableRowKeyboard(event, {
      activate: () => this.onSelect?.(workspace),
      previousSection: this.onFocusPreviousSection === undefined ? undefined : () => { void this.onFocusPreviousSection?.(); },
      nextSection: this.onFocusNextSection === undefined ? undefined : () => { void this.onFocusNextSection?.(); },
      cancel: this.onCancelKeyboardNavigation === undefined ? undefined : () => { void this.onCancelKeyboardNavigation?.(); },
    });
  }

  private scrollSelectedIntoView(): void {
    this.renderRoot.querySelector<HTMLElement>(".action-row.selected")?.scrollIntoView({ block: "nearest" });
  }

  static override styles = [listStyles, sidebarListStyles];
}

function workspacePrimaryLabel(workspace: Workspace): string {
  return workspace.isMain ? messages.t("mainLabel", { label: workspace.label }) : workspace.label;
}

function workspaceMenuId(workspaceId: string): string {
  return `workspace-menu-${encodeURIComponent(workspaceId)}`;
}
