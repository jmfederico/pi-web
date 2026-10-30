import { LocalizationController } from "../localization/browser";
import { machineMessages as messages } from "../machineMessages";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Machine, MachineHealth, MachineStatus } from "../api";
import { rollUpStatusFlags, type MachineStatusSnapshot } from "../../../shared/machineStatus";
import { browserGatewayDisplayUrl, machineIconUrl } from "../instanceIdentity";
import { AnchoredPopupController } from "./anchoredPopup";
import { hasStatusUnread, renderActivityIndicator, statusActivityKind } from "./activityBadge";
import { canRemoveMachine } from "./MachineList";
import type { KeyboardNavigableSection } from "./navigationFocus";
import { uiButtonStyles, uiMenuStyles } from "./ui/controlStyles";

@customElement("machine-switcher")
export class MachineSwitcher extends LitElement implements KeyboardNavigableSection {
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
  @property({ attribute: false }) onSelect?: (machine: Machine) => void | Promise<void>;
  @property({ attribute: false }) onEdit?: (machine: Machine) => void;
  @property({ attribute: false }) onRemove?: (machine: Machine) => void | Promise<void>;
  @property({ attribute: false }) onFocusNextSection?: () => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;
  @state() private open = false;
  @state() private openActionsMachineId: string | undefined;
  readonly popup = new AnchoredPopupController(this, () => {
    const anchor = this.switcherButton();
    const panel = this.renderRoot.querySelector<HTMLElement>(".machine-switcher-menu");
    return this.open && anchor && panel ? {
      anchor, panel, onClose: () => { this.open = false; this.openActionsMachineId = undefined; },
      options: { placement: "below-start", padding: 8, width: 280 },
    } : undefined;
  });
  readonly actionsPopup = new AnchoredPopupController(this, () => {
    const panel = this.renderRoot.querySelector<HTMLElement>(".machine-option-actions-panel");
    const anchor = panel?.parentElement?.querySelector<HTMLElement>(".machine-option-actions-toggle");
    return anchor && panel ? { anchor, panel, onClose: () => { this.openActionsMachineId = undefined; }, options: { minWidth: 120 } } : undefined;
  });

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("machines") && this.open && this.selectedMachine() === undefined) this.open = false;
    if (changed.has("machines") && this.open && this.machines.length <= 1) this.open = false;
    if (changed.has("machines") && this.openActionsMachineId !== undefined && !this.machines.some((machine) => machine.id === this.openActionsMachineId)) this.openActionsMachineId = undefined;
  }

  async focusSelectedOrFirst(): Promise<boolean> {
    const button = this.switcherButton();
    if (button === null) return false;
    return await this.openMenuAndFocusOption();
  }

  override render() {
    const selected = this.selectedMachine();
    if (this.machines.length <= 1) return this.renderMachineInfo(selected ?? { id: "local", name: "PI-WEB", kind: "local", createdAt: "", updatedAt: "" });
    if (selected === undefined) return null;
    const status = machineStatus(selected, this.statuses);
    const label = selected.name;
    return html`
      <div class="machine-switcher">
        <button
          type="button"
          class=${`machine-switcher-button ui-popup-trigger ${status === "offline" || status === "error" ? "disconnected" : ""}`}
          title=${messages.t("identity", { name: selected.name, location: machineSubtitle(selected), status: machineStatusLabel(status) })}
          aria-label=${this.machineSwitcherAriaLabel(selected)}
          aria-expanded=${String(this.open)}
          aria-controls="machine-switcher-menu"
          @click=${() => { this.toggleMenu(); }}
          @keydown=${(event: KeyboardEvent) => { this.handleSwitcherButtonKeydown(event); }}
        >
          ${this.renderMachineIcon(selected)}
          ${this.renderActivity(selected)}
          <span class="machine-switcher-text">
            <span class="machine-switcher-kicker">${messages.t("machine")}</span>
            <span class="machine-switcher-label"><bdi>${label}</bdi></span>
          </span>
          ${this.renderOtherMachinesActivity(selected)}
          <span class="machine-chevron" aria-hidden="true">▾</span>
        </button>
        ${this.open ? html`
          <div popover="auto" id="machine-switcher-menu" class="machine-switcher-menu ui-menu ui-popup-panel" data-ui-context="machine-picker" @click=${(event: MouseEvent) => { event.stopPropagation(); }}>
            ${this.machines.map((machine) => this.renderMachineOption(machine))}
          </div>
        ` : null}
      </div>
    `;
  }

  private renderMachineOption(machine: Machine): TemplateResult {
    const selected = this.selectedMachine()?.id === machine.id;
    const status = machineStatus(machine, this.statuses);
    const hasActions = canRemoveMachine(machine) && (this.onRemove !== undefined || this.onEdit !== undefined);
    const actionsOpen = this.openActionsMachineId === machine.id;
    const actionsId = `machine-option-actions-${encodeURIComponent(machine.id)}`;
    return html`
      <div class=${`machine-option ${selected ? "selected" : ""} ${hasActions ? "" : "no-actions"}`}>
        <button
          type="button"
          class="ui-button ui-menu-item machine-option-main"
          title=${machineTitle(machine)}
          data-machine-id=${machine.id}
          data-current=${String(selected)}
          aria-current=${selected ? "true" : nothing}
          @click=${() => { this.select(machine); }}
          @keydown=${(event: KeyboardEvent) => { this.handleMachineOptionKeydown(event); }}
        >
          <span class="machine-option-name">${this.renderMachineIcon(machine)}${this.renderActivity(machine)}<span><bdi>${machine.name}</bdi></span></span>
          <small>${messages.t("subtitle", { location: machineSubtitle(machine), status: machineStatusLabel(status) })}</small>
        </button>
        ${hasActions ? html`
          <div class="machine-option-actions">
            <button
              type="button"
              class="ui-button ui-button--icon machine-option-actions-toggle ui-popup-trigger"
              title=${messages.t("actions")}
              aria-label=${messages.t("actionsFor", { name: machine.name })}
              aria-expanded=${String(actionsOpen)}
              aria-controls=${actionsId}
              @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleActionsMenu(machine.id); }}
            >⋯</button>
            ${actionsOpen ? html`
              <div popover="auto" id=${actionsId} class="machine-option-actions-panel ui-menu ui-popup-panel" data-ui-context="machine-actions" @click=${(event: MouseEvent) => { event.stopPropagation(); }}>
                ${this.onEdit === undefined ? null : html`<button class="ui-button ui-menu-item" @click=${() => { this.open = false; this.openActionsMachineId = undefined; this.onEdit?.(machine); }}>${messages.t("edit")}</button>`}
                ${this.onRemove === undefined ? null : html`<button class="danger ui-button ui-menu-item" title=${messages.t("removeNamed", { name: machine.name })} @click=${() => { this.removeMachine(machine); }}>${messages.t("remove")}</button>`}
              </div>
            ` : null}
          </div>
        ` : null}
      </div>
    `;
  }

  private renderMachineInfo(machine: Machine): TemplateResult {
    const status = machineStatus(machine, this.statuses);
    return html`
      <div class=${`machine-info ${status === "offline" || status === "error" ? "disconnected" : ""}`} title=${messages.t("identity", { name: machine.name, location: machineSubtitle(machine), status: machineStatusLabel(status) })}>
        ${this.renderMachineIcon(machine)}
        ${this.renderActivity(machine)}
        <span class="machine-switcher-text">
          <span class="machine-switcher-label"><bdi>${machine.name}</bdi></span>
        </span>
      </div>
    `;
  }

  private renderMachineIcon(machine: Machine): TemplateResult {
    const status = machineStatus(machine, this.statuses);
    const dimmed = status === "offline" || status === "error";
    return html`<img class=${dimmed ? "machine-icon dimmed" : "machine-icon"} src=${machineIconUrl(machine)} alt="" @error=${this.hideBrokenIcon} />`;
  }

  private readonly hideBrokenIcon = (event: Event): void => {
    // A remote that is unreachable or predates identity assets loses its icon
    // rather than showing a broken image.
    if (event.currentTarget instanceof HTMLImageElement) event.currentTarget.style.display = "none";
  };

  private renderActivity(machine: Machine): TemplateResult | undefined {
    const flags = this.statusSnapshots[machine.id]?.machine;
    const status = machineStatus(machine, this.statuses);
    // Unread survives offline: an offline machine keeps its last-known unread
    // state (stale-but-present still counts), so only the work dot is gated.
    const kind = status === "offline" || status === "error" ? undefined : statusActivityKind(flags);
    const unreadLabel = hasStatusUnread(flags) ? messages.t("unread") : undefined;
    return renderActivityIndicator(kind, kind === "terminal" ? messages.t("terminal") : messages.t("active"), unreadLabel);
  }

  private renderOtherMachinesActivity(selected: Machine): TemplateResult | undefined {
    const others = this.machines.filter((machine) => machine.id !== selected.id);
    // Offline machines retain unread attention, but their stale work flags
    // must not imply that work is still running.
    const activeFlags = rollUpStatusFlags(others
      .filter((machine) => !["offline", "error"].includes(machineStatus(machine, this.statuses)))
      .map((machine) => this.statusSnapshots[machine.id]?.machine ?? {}));
    const unread = others.some((machine) => hasStatusUnread(this.statusSnapshots[machine.id]?.machine));
    const kind = statusActivityKind(activeFlags);
    const indicator = renderActivityIndicator(kind,
      kind === "terminal" ? messages.t("otherTerminal") : messages.t("otherActive"),
      unread ? messages.t("otherUnread") : undefined);
    return indicator === undefined ? undefined : html`<span class="other-machines-activity">${indicator}</span>`;
  }

  private selectedMachine(): Machine | undefined {
    return this.selected ?? this.machines.find((machine) => machine.id === "local") ?? this.machines[0];
  }

  private machineSwitcherAriaLabel(machine: Machine): string {
    return messages.t("switch", { name: machine.name, status: machineStatusLabel(machineStatus(machine, this.statuses)) });
  }

  private switcherButton(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>(".machine-switcher-button");
  }

  private handleSwitcherButtonKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      void this.openMenuAndFocusOption();
      return;
    }
    if (event.key === "ArrowRight" && this.onFocusNextSection !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      void this.onFocusNextSection();
      return;
    }
    if (event.key === "Escape" && this.onCancelKeyboardNavigation !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      void this.onCancelKeyboardNavigation();
    }
  }

  private handleMachineOptionKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowUp") {
      this.focusRelativeMachineOption(event.currentTarget, -1, event);
      return;
    }
    if (event.key === "ArrowDown") {
      this.focusRelativeMachineOption(event.currentTarget, 1, event);
      return;
    }
    if (event.key === "Home") {
      this.focusIndexedMachineOption(0, event);
      return;
    }
    if (event.key === "End") {
      this.focusIndexedMachineOption(-1, event);
      return;
    }
    if (event.key === "ArrowRight" && this.onFocusNextSection !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      this.open = false;
      void this.onFocusNextSection();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.open = false;
      void this.updateComplete.then(() => { this.focusSwitcherButton(); });
    }
  }

  private toggleMenu(): void {
    this.open = !this.open;
    this.openActionsMachineId = undefined;
  }

  private focusSwitcherButton(): boolean {
    const button = this.switcherButton();
    if (button === null) return false;
    button.focus();
    return true;
  }

  private async openMenuAndFocusOption(): Promise<boolean> {
    this.open = true;
    this.openActionsMachineId = undefined;
    await this.updateComplete;
    return this.focusSelectedMachineOption();
  }

  private focusSelectedMachineOption(): boolean {
    const selected = this.renderRoot.querySelector<HTMLElement>(".machine-option.selected .machine-option-main");
    const first = this.machineOptionButtons()[0];
    const target = selected ?? first;
    if (target === undefined) return false;
    target.focus();
    target.scrollIntoView({ block: "nearest" });
    return true;
  }

  private focusRelativeMachineOption(target: EventTarget | null, delta: number, event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const buttons = this.machineOptionButtons();
    if (buttons.length === 0 || !(target instanceof HTMLElement)) return;
    const index = buttons.indexOf(target);
    if (index < 0) return;
    this.focusMachineOptionAt(index + delta);
  }

  private focusIndexedMachineOption(index: number, event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.focusMachineOptionAt(index < 0 ? this.machineOptionButtons().length - 1 : index);
  }

  private focusMachineOptionAt(index: number): void {
    const buttons = this.machineOptionButtons();
    const target = buttons[Math.min(Math.max(index, 0), buttons.length - 1)];
    target?.focus();
    target?.scrollIntoView({ block: "nearest" });
  }

  private machineOptionButtons(): HTMLElement[] {
    return Array.from(this.renderRoot.querySelectorAll<HTMLElement>(".machine-option-main"));
  }

  private toggleActionsMenu(machineId: string): void {
    if (this.openActionsMachineId === machineId) {
      this.openActionsMachineId = undefined;
      return;
    }
    this.openActionsMachineId = machineId;
  }

  private select(machine: Machine): void {
    this.open = false;
    this.openActionsMachineId = undefined;
    void this.onSelect?.(machine);
  }

  private removeMachine(machine: Machine): void {
    this.open = false;
    this.openActionsMachineId = undefined;
    void this.onRemove?.(machine);
  }

  static override styles = [uiButtonStyles, uiMenuStyles, css`
    @layer pi-web-base {
    :host { min-width: 0; display: flex; container: machine-selector / inline-size; }
    .machine-switcher { flex: 1 1 auto; min-width: 0; display: flex; }
    .machine-switcher-button { box-sizing: border-box; width: 100%; min-width: 0; min-height: 44px; display: flex; align-items: center; gap: 6px; border: 0; border-radius: 0; background: transparent; color: var(--pi-text); padding: 6px 10px; cursor: pointer; text-align: start; }
    .machine-switcher-button:hover, .machine-switcher-button:focus-visible { background: var(--pi-surface-hover); }
    .machine-switcher-button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    .machine-switcher-text { flex: 1 1 auto; min-width: 0; display: grid; gap: 1px; }
    .machine-switcher-kicker { color: var(--pi-muted); font-size: 10px; line-height: 1; text-transform: uppercase; letter-spacing: .02em; }
    .machine-switcher-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; line-height: 1.2; }
    .disconnected .machine-switcher-text { opacity: .55; }
    .other-machines-activity { flex: 0 0 auto; display: inline-flex; align-items: center; }
    .machine-chevron { flex: 0 0 auto; color: var(--pi-muted); font-size: 11px; }
    @container machine-selector (max-width: 220px) {
      .machine-switcher-kicker { display: none; }
    }
    .activity-indicator { flex: 0 0 auto; display: inline-block; width: 7px; height: 7px; background: var(--pi-success); animation: pulse 1s ease-in-out infinite; }
    .activity-indicator.session { border-radius: 50%; background: var(--pi-success); }
    .activity-indicator.intervention-required { box-sizing: border-box; border: 1.5px solid var(--pi-warning); border-radius: 50%; background: transparent; animation: none; }
    .activity-indicator.terminal { border-radius: 2px; background: var(--pi-accent); }
    .activity-indicator.sending { border-radius: 50%; background: var(--pi-warning); }
    .activity-indicator.unread { border-radius: 50%; background: var(--pi-accent); animation: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--pi-accent) 20%, transparent); }
    .unread-ring { flex: 0 0 auto; box-sizing: border-box; display: inline-grid; place-items: center; width: 9px; height: 9px; border: 1.5px solid var(--pi-accent); border-radius: 50%; }
    .unread-ring .activity-indicator { width: 5px; height: 5px; }
    .machine-icon { flex: 0 0 auto; width: 16px; height: 16px; }
    .machine-icon.dimmed { filter: grayscale(1); opacity: .45; }
    .machine-option-main .machine-icon { width: 14px; height: 14px; }
    .machine-info { box-sizing: border-box; width: 100%; min-width: 0; min-height: 44px; display: flex; align-items: center; gap: 6px; border: 0; border-radius: 0; background: transparent; color: var(--pi-text); padding: 6px 10px; }
    .machine-option { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: stretch; }
    .machine-option + .machine-option { border-top: 1px solid var(--pi-border-muted); }
    .machine-option.no-actions { grid-template-columns: minmax(0, 1fr); }
    .machine-option-main { min-width: 0; display: grid; gap: 2px; }
    .machine-option-name { min-width: 0; display: flex; align-items: center; gap: 6px; }
    .machine-option-name span:last-child { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
    .machine-option-main small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-muted); }
    .machine-option-actions { position: relative; align-self: stretch; }
    .machine-option-actions-toggle { height: 100%; }
    .machine-option.selected .machine-option-main { background: var(--pi-selection-bg); }
    @keyframes pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
    }
  `];
}

function machineStatus(machine: Machine, statuses: Record<string, MachineHealth>): MachineStatus {
  return statuses[machine.id]?.status ?? machine.status ?? "unknown";
}

function machineStatusLabel(status: MachineStatus): string {
  return messages.t(status);
}

function machineTitle(machine: Machine): string {
  return machine.baseUrl ?? machine.name;
}

/** The local machine identifies itself by the serving gateway's URL. */
function machineSubtitle(machine: Machine): string {
  if (machine.kind === "local") return browserGatewayDisplayUrl();
  return machine.baseUrl ?? messages.t("remote");
}
