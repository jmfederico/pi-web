import { localization, LocalizationController } from "../localization/browser";
import { machineMessages as messages } from "../machineMessages";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Machine, MachineHealth } from "../api";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { renderCopyIdAction } from "./copyIdAction";
import { createActionMenuController } from "./actionMenu";
import { hasStatusUnread, renderActionActivityIndicator, statusActivityKind } from "./activityBadge";
import type { KeyboardNavigableSection } from "./navigationFocus";
import { activateSelectableRow, focusSelectedOrFirstSelectableRow, handleSelectableRowKeyboard } from "./selectableRow";
import { listStyles } from "./shared";
import { sidebarListStyles } from "./sidebarListStyles";

@customElement("machine-list")
export class MachineList extends LitElement implements KeyboardNavigableSection {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @property({ attribute: false }) machines: Machine[] = [];
  @property({ attribute: false }) selected?: Machine;
  @property({ attribute: false }) statuses: Record<string, MachineHealth> = {};
  /** Per-machine status trees, keyed by machine id; a machine without one shows no indicator. */
  @property({ attribute: false }) statusSnapshots: Record<string, MachineStatusSnapshot> = {};
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ attribute: false }) onSelect?: (machine: Machine) => void;
  @property({ attribute: false }) onEdit?: (machine: Machine) => void;
  @property({ attribute: false }) onRemove?: (machine: Machine) => void | Promise<void>;
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @property({ attribute: false }) onFocusNextSection?: () => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;
  @state() private openMenuMachineId: string | undefined;
  readonly actionMenu = createActionMenuController(this, () => {
    const row = [...this.renderRoot.querySelectorAll<HTMLElement>("[data-machine-id]")].find((item) => item.dataset["machineId"] === this.openMenuMachineId);
    return row?.querySelector<HTMLElement>(".action-menu-toggle") ?? undefined;
  }, () => { this.openMenuMachineId = undefined; });

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("machines") && this.openMenuMachineId !== undefined && !this.machines.some((machine) => machine.id === this.openMenuMachineId)) this.openMenuMachineId = undefined;
    if (changed.has("collapsed") && this.collapsed) this.openMenuMachineId = undefined;
  }

  async focusSelectedOrFirst(): Promise<boolean> {
    await this.updateComplete;
    return focusSelectedOrFirstSelectableRow(this.renderRoot, { fallbackSelector: ".section-toggle" });
  }

  override render() {
    return html`
      <section>
        <h2 class="ui-toolbar">${this.renderHeading()}</h2>
        ${this.collapsed ? null : html`
          <div class="list-body">
            ${this.machines.map((machine) => this.renderMachine(machine))}
          </div>
        `}
      </section>
    `;
  }

  private renderMachine(machine: Machine) {
    const status = this.statuses[machine.id]?.status ?? machine.status ?? "unknown";
    const statusLabel = messages.t(status);
    return html`
      <div
        class=${`action-row machine-row ${this.selected?.id === machine.id ? "selected" : ""} `}
        tabindex="0"
        title=${machine.baseUrl ?? machine.name}
        data-machine-id=${machine.id}
        @click=${(event: MouseEvent) => { activateSelectableRow(event, () => this.onSelect?.(machine)); }}
        @keydown=${(event: KeyboardEvent) => { this.handleMachineKeydown(event, machine); }}
      >
        <div class="action-main">
          <span class="action-name machine-primary"><span class="machine-primary-label"><bdi>${machine.name}</bdi></span></span><small>${messages.t("subtitle", { location: machine.kind === "local" ? messages.t("local") : machine.baseUrl ?? messages.t("remote"), status: statusLabel })}</small>
          ${this.renderActivity(machine)}
        </div>
        ${this.renderMachineMenu(machine)}
      </div>
    `;
  }

  private renderActivity(machine: Machine) {
    const flags = this.statusSnapshots[machine.id]?.machine;
    const status = this.statuses[machine.id]?.status ?? machine.status;
    // Unread survives offline: an offline machine keeps its last-known unread
    // state (stale-but-present still counts), so only the work dot is gated.
    const kind = status === "offline" || status === "error" ? undefined : statusActivityKind(flags);
    const unreadLabel = hasStatusUnread(flags) ? messages.t("unread") : undefined;
    return renderActionActivityIndicator(kind, kind === "terminal" ? messages.t("terminal") : messages.t("active"), unreadLabel);
  }

  private renderMachineMenu(machine: Machine) {
    const open = this.openMenuMachineId === machine.id;
    const menuId = machineMenuId(machine.id);
    return html`
      <div class="action-menu">
        <button
          class="ui-button ui-button--icon action-menu-toggle ui-popup-trigger"
          title=${messages.t("actions")}
          aria-label=${messages.t("actionsFor", { name: machine.name })}
          aria-expanded=${String(open)}
          aria-controls=${menuId}
          @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(machine.id); }}
        >⋯</button>
        ${open ? html`
          <div popover="auto" class="action-menu-panel machine-menu-panel ui-menu ui-popup-panel" data-ui-context="machine-actions" id=${menuId} @click=${(event: MouseEvent) => { event.stopPropagation(); }}>
            ${!canRemoveMachine(machine) || this.onEdit === undefined ? null : html`<button class="ui-button ui-menu-item" @click=${() => { this.openMenuMachineId = undefined; this.onEdit?.(machine); }}>${messages.t("edit")}</button>`}
            ${!canRemoveMachine(machine) || this.onRemove === undefined ? null : html`<button class="danger ui-button ui-menu-item" title=${messages.t("removeNamed", { name: machine.name })} @click=${() => { this.removeMachine(machine); }}>${messages.t("remove")}</button>`}
            ${renderCopyIdAction("machine", machine.id, () => { this.openMenuMachineId = undefined; })}
          </div>
        ` : null}
      </div>
    `;
  }

  private renderHeading() {
    if (!this.collapsible) return html`<span>${messages.t("machines")}</span>`;
    const selectedSummary = this.selected?.name ?? messages.t("noSelection");
    const selectedTitle = this.selected?.baseUrl ?? selectedSummary;
    return html`<button class="ui-button ui-toolbar-title section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} ${messages.t("machines")}</span>${this.collapsed ? html`<small class="section-selected" title=${selectedTitle}>${selectedSummary}</small>` : null}</span><small class="section-count">${localization.number(this.machines.length)}</small></button>`;
  }

  private toggleMenu(machineId: string): void {
    if (this.openMenuMachineId === machineId) {
      this.openMenuMachineId = undefined;
      return;
    }
    this.openMenuMachineId = machineId;
  }

  private removeMachine(machine: Machine): void {
    this.openMenuMachineId = undefined;
    void this.onRemove?.(machine);
  }

  private handleMachineKeydown(event: KeyboardEvent, machine: Machine): void {
    if (event.key === "Escape" && this.openMenuMachineId === machine.id) {
      event.preventDefault();
      event.stopPropagation();
      this.openMenuMachineId = undefined;
      return;
    }
    handleSelectableRowKeyboard(event, {
      activate: () => this.onSelect?.(machine),
      nextSection: this.onFocusNextSection === undefined ? undefined : () => { void this.onFocusNextSection?.(); },
      cancel: this.onCancelKeyboardNavigation === undefined ? undefined : () => { void this.onCancelKeyboardNavigation?.(); },
    });
  }

  static override styles = [
    listStyles,
    sidebarListStyles,
    css`
      .machine-primary { display: flex; align-items: baseline; gap: 6px; }
      .machine-primary-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    `,
  ];
}

export function canRemoveMachine(machine: Machine): boolean {
  return machine.kind === "remote";
}

function machineMenuId(machineId: string): string {
  return `machine-menu-${encodeURIComponent(machineId)}`;
}
