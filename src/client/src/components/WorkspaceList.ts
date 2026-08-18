import { LitElement, css, html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { trustApi } from "../api";
import type { Workspace } from "../api";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { writeClipboardText } from "../clipboard";
import type { WorkspaceLabelItem } from "../plugins/types";
import { canDeleteWorkspace } from "../workspaceDeletion";
import { actionMenuPanelStyle } from "./actionMenu";
import { hasStatusUnread, renderActionActivityIndicator, statusActivityKind } from "./activityBadge";
import type { KeyboardNavigableSection } from "./navigationFocus";
import { activateSelectableRow, focusSelectedOrFirstSelectableRow, handleSelectableRowKeyboard } from "./selectableRow";
import { listStyles } from "./shared";
import { renderWorkspaceLabelInlineItems } from "./workspaceLabel";

interface WorkspaceTrustState {
  loading?: boolean;
  saving?: boolean;
  trusted?: boolean;
  error?: string;
}

@customElement("workspace-list")
export class WorkspaceList extends LitElement implements KeyboardNavigableSection {
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
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @property({ attribute: false }) onFocusPreviousSection?: () => void | Promise<void>;
  @property({ attribute: false }) onFocusNextSection?: () => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;
  @state() private openMenuWorkspaceId: string | undefined;
  @state() private menuStyle = "";
  @state() private copiedDetailKey: string | undefined;
  @state() private trustByWorkspaceId: Record<string, WorkspaceTrustState> = {};

  private readonly onDocumentClick = (event: MouseEvent) => {
    if (event.composedPath().includes(this)) return;
    this.openMenuWorkspaceId = undefined;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onDocumentClick);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.onDocumentClick);
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
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
      <section>
        <h2>${this.renderHeading()}</h2>
        ${this.collapsed ? null : html`
          <div class="list-body">
            ${this.workspaces.map((workspace) => {
              const label = workspacePrimaryLabel(workspace);
              const items = this.workspaceLabelItems(workspace);
              return html`
                <div
                  class=${`action-row workspace-row ${this.selected?.id === workspace.id ? "selected" : ""}`}
                  tabindex="0"
                  title=${label}
                  @click=${(event: MouseEvent) => { activateSelectableRow(event, () => this.onSelect?.(workspace)); }}
                  @keydown=${(event: KeyboardEvent) => { this.handleWorkspaceKeydown(event, workspace); }}
                >
                  <div class="action-main">
                    ${this.renderWorkspaceMain(label, items, workspace)}
                  </div>
                  ${this.renderWorkspaceMenu(label, items, workspace)}
                </div>
              `;
            })}
          </div>
        `}
      </section>
    `;
  }

  private renderHeading() {
    if (!this.collapsible) return html`<span>Workspaces</span>`;
    const selectedSummary = this.selected === undefined ? "No workspace selected" : `${this.selected.label}${this.selected.isMain ? " · main" : ""} · ${this.selected.path}`;
    const selectedTitle = this.selected?.path ?? selectedSummary;
    return html`<button class="section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} Workspaces</span>${this.collapsed ? html`<small class="section-selected" title=${selectedTitle}>${selectedSummary}</small>` : null}</span><small class="section-count">${this.workspaces.length}</small></button>`;
  }

  private renderActivity(workspace: Workspace): TemplateResult | undefined {
    const flags = this.statusSnapshot?.workspaces[workspace.id];
    const kind = statusActivityKind(flags);
    const unreadLabel = hasStatusUnread(flags) ? "Unread sessions in this workspace" : undefined;
    return renderActionActivityIndicator(kind, kind === "terminal" ? "Workspace terminal active" : "Workspace active", unreadLabel);
  }

  private renderWorkspaceMain(label: string, items: WorkspaceLabelItem[], workspace: Workspace): TemplateResult {
    return html`
      <span class="workspace-primary">
        <span class="workspace-primary-label">${label}</span>
        ${this.isDeleting(workspace) ? html`<span class="workspace-status">Deleting…</span>` : null}
      </span>
      ${items.length === 0 ? null : html`
        <small class="workspace-secondary">
          <span class="workspace-label">${renderWorkspaceLabelInlineItems(items)}</span>
        </small>
      `}
      ${this.renderActivity(workspace)}
    `;
  }

  private renderWorkspaceMenu(label: string, items: WorkspaceLabelItem[], workspace: Workspace): TemplateResult {
    const open = this.openMenuWorkspaceId === workspace.id;
    const menuId = workspaceMenuId(workspace.id);
    return html`
      <div class="action-menu">
        <button
          class="action-menu-toggle"
          title="Workspace actions and details"
          aria-label=${`Actions and details for ${label}`}
          aria-expanded=${String(open)}
          aria-controls=${menuId}
          @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(workspace.id, event.currentTarget); }}
        >⋯</button>
        ${open ? html`
          <div class="action-menu-panel workspace-menu-panel" id=${menuId} style=${this.menuStyle} @click=${(event: MouseEvent) => { event.stopPropagation(); }}>
            ${this.renderWorkspaceActions(workspace)}
            ${this.renderWorkspaceDetails(label, items, workspace)}
          </div>
        ` : null}
      </div>
    `;
  }

  private renderWorkspaceActions(workspace: Workspace): TemplateResult {
    const deleting = this.isDeleting(workspace);
    const actionLabel = workspace.removal?.actionLabel ?? "Remove workspace";
    return html`
      <div class="workspace-menu-actions">
        ${this.renderTrustToggle(workspace)}
        ${canDeleteWorkspace(workspace) ? html`
          <button class="danger" title=${deleting ? "Workspace removal in progress" : actionLabel} ?disabled=${deleting} @click=${() => { this.delete(workspace); }}>${deleting ? "Removing…" : actionLabel}</button>
        ` : null}
      </div>
    `;
  }

  private renderTrustToggle(workspace: Workspace): TemplateResult {
    const trust = this.trustByWorkspaceId[workspace.id];
    const busy = trust?.loading === true || trust?.saving === true;
    const inputId = `${workspaceMenuId(workspace.id)}-trusted`;
    return html`
      <div class="workspace-menu-trust">
        <div class="workspace-menu-trust-row">
          <label for=${inputId}>
            <input
              id=${inputId}
              type="checkbox"
              .checked=${trust?.trusted === true}
              ?disabled=${busy || trust?.trusted === undefined}
              @change=${(event: Event) => { if (event.target instanceof HTMLInputElement) void this.setTrust(workspace, event.target.checked); }}
            />
            <span>Trusted${busy ? "…" : ""}</span>
          </label>
          <a class="workspace-trust-link" href="https://pi.dev/docs/latest/security" target="_blank" rel="noreferrer">Learn about project trust</a>
        </div>
        ${trust?.error === undefined ? null : html`<small class="workspace-trust-error">${trust.error}</small>`}
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
    this.setTrustState(workspace.id, { ...this.trustBase(existing), saving: true });
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
          <dt>Workspace</dt>
          <dd>${label}${this.renderDetailCopyButton(`${workspace.id}:label`, workspace.label, "Copy workspace label")}</dd>
        </div>
        <div class="workspace-detail-row">
          <dt>Path</dt>
          <dd title=${workspace.path}>${workspace.path}${this.renderDetailCopyButton(`${workspace.id}:path`, workspace.path, "Copy path")}</dd>
        </div>
        ${items.length === 0 ? null : html`
          <div class="workspace-detail-row">
            <dt>Details</dt>
            <dd><span class="workspace-label">${renderWorkspaceLabelInlineItems(items)}</span></dd>
          </div>
        `}
      </dl>
    `;
  }

  private renderDetailCopyButton(key: string, value: string, action: string): TemplateResult {
    const copied = this.copiedDetailKey === key;
    const label = copied ? "Copied" : action;
    return html`
      <button type="button" class="detail-copy" title=${label} aria-label=${label} @click=${() => { void this.copyDetail(key, value); }}>
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

  private toggleMenu(workspaceId: string, target: EventTarget | null): void {
    if (this.openMenuWorkspaceId === workspaceId) {
      this.openMenuWorkspaceId = undefined;
      return;
    }
    this.menuStyle = actionMenuPanelStyle(target, { constrainTo: "viewport" });
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

  static override styles = [listStyles, css`
    .workspace-menu-trust { display: flex; flex-direction: column; gap: 3px; padding: 4px 2px; }
    .workspace-menu-trust-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .workspace-menu-trust label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
    .workspace-menu-trust input { cursor: pointer; }
    .workspace-trust-link { color: var(--pi-accent); font-size: 12px; text-align: right; white-space: nowrap; }
    .workspace-trust-error { color: var(--pi-danger, #c0392b); line-height: 1.3; }
  `];
}

function workspacePrimaryLabel(workspace: Workspace): string {
  return `${workspace.label}${workspace.isMain ? " · main" : ""}`;
}

function workspaceMenuId(workspaceId: string): string {
  return `workspace-menu-${workspaceId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}
