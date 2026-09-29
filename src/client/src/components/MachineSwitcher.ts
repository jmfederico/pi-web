import { LitElement, css, html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Machine, MachineHealth, MachineStatus } from "../api";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { browserGatewayDisplayUrl, machineIconUrl } from "../instanceIdentity";
import { actionMenuPanelStyle } from "./actionMenu";
import { hasStatusUnread, renderActivityIndicator, statusActivityKind } from "./activityBadge";
import { canRemoveMachine } from "./MachineList";
import type { KeyboardNavigableSection } from "./navigationFocus";

@customElement("machine-switcher")
export class MachineSwitcher extends LitElement implements KeyboardNavigableSection {
  @property({ attribute: false }) machines: Machine[] = [];
  @property({ attribute: false }) selected?: Machine;
  /** PWA display mode: the single-machine identity bubble only shows there. */
  @property({ type: Boolean }) locationIndicator = false;
  @property({ attribute: false }) statuses: Record<string, MachineHealth> = {};
  /** Per-machine status trees, keyed by machine id; a machine without one shows no indicator. */
  @property({ attribute: false }) statusSnapshots: Record<string, MachineStatusSnapshot> = {};
  @property({ attribute: false }) onSelect?: (machine: Machine) => void | Promise<void>;
  @property({ attribute: false }) onRemove?: (machine: Machine) => void | Promise<void>;
  @property({ attribute: false }) onFocusNextSection?: () => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;
  @state() private open = false;
  @state() private menuStyle = "";
  @state() private openActionsMachineId: string | undefined;
  @state() private actionMenuStyle = "";

  private readonly onDocumentClick = (event: MouseEvent) => {
    if (event.composedPath().includes(this)) return;
    this.open = false;
    this.openActionsMachineId = undefined;
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
    if (changed.has("machines") && this.open && this.selectedMachine() === undefined) this.open = false;
    if (changed.has("machines") && this.open && this.machines.length <= 1) this.open = false;
    if (changed.has("machines") && this.openActionsMachineId !== undefined && !this.machines.some((machine) => machine.id === this.openActionsMachineId)) this.openActionsMachineId = undefined;
  }

  async focusSelectedOrFirst(): Promise<boolean> {
    const button = this.switcherButton();
    if (button === null) return false;
    return await this.openMenuAndFocusOption(button);
  }

  override render() {
    const selected = this.selectedMachine();
    if (selected === undefined) return null;
    // A single machine offers nothing to select: in PWA mode it becomes a
    // static identity bubble with the machine's icon and URL; in browser mode
    // the browser chrome already identifies the instance, so nothing renders.
    if (this.machines.length <= 1) return this.locationIndicator ? this.renderMachineInfo(selected) : null;
    const status = machineStatus(selected, this.statuses);
    const label = selected.name;
    return html`
      <div class="machine-switcher">
        <button
          type="button"
          class="machine-switcher-button"
          title=${machineTitle(selected)}
          aria-label=${this.machineSwitcherAriaLabel(selected)}
          aria-expanded=${String(this.open)}
          @click=${(event: MouseEvent) => { this.toggleMenu(event.currentTarget); }}
          @keydown=${(event: KeyboardEvent) => { this.handleSwitcherButtonKeydown(event); }}
        >
          ${this.renderMachineIcon(selected)}
          ${this.renderActivity(selected)}
          <span class="machine-switcher-text">
            <span class="machine-switcher-kicker">Machine</span>
            <span class="machine-switcher-label">${label}</span>
          </span>
          <span class=${`machine-status ${status}`}>${machineStatusLabel(status)}</span>
          <span class="machine-chevron" aria-hidden="true">▾</span>
        </button>
        ${this.open ? html`
          <div class="machine-switcher-menu" style=${this.menuStyle} @click=${(event: MouseEvent) => { event.stopPropagation(); }}>
            ${this.machines.map((machine) => this.renderMachineOption(machine))}
          </div>
        ` : null}
      </div>
    `;
  }

  private renderMachineOption(machine: Machine): TemplateResult {
    const selected = this.selected?.id === machine.id;
    const status = machineStatus(machine, this.statuses);
    const hasActions = canRemoveMachine(machine) && this.onRemove !== undefined;
    const actionsOpen = this.openActionsMachineId === machine.id;
    return html`
      <div class=${`machine-option ${selected ? "selected" : ""} ${hasActions ? "" : "no-actions"}`}>
        <button
          type="button"
          class="machine-option-main"
          title=${machineTitle(machine)}
          data-machine-id=${machine.id}
          @click=${() => { this.select(machine); }}
          @keydown=${(event: KeyboardEvent) => { this.handleMachineOptionKeydown(event); }}
        >
          <span class="machine-option-name">${this.renderMachineIcon(machine)}${this.renderActivity(machine)}<span>${machine.name}</span></span>
          <small>${machineSubtitle(machine)} · ${machineStatusLabel(status)}</small>
        </button>
        ${hasActions ? html`
          <div class="machine-option-actions">
            <button
              type="button"
              class="machine-option-actions-toggle"
              title="Machine actions"
              aria-label=${`Actions for ${machine.name}`}
              aria-expanded=${String(actionsOpen)}
              @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleActionsMenu(machine.id, event.currentTarget); }}
            >⋯</button>
            ${actionsOpen ? html`
              <div class="machine-option-actions-panel" style=${this.actionMenuStyle} @click=${(event: MouseEvent) => { event.stopPropagation(); }}>
                <button class="danger" title=${`Remove ${machine.name}`} @click=${() => { this.removeMachine(machine); }}>Remove</button>
              </div>
            ` : null}
          </div>
        ` : null}
      </div>
    `;
  }

  private renderMachineInfo(machine: Machine): TemplateResult {
    return html`
      <div class="machine-info" title=${machineSubtitle(machine)}>
        ${this.renderMachineIcon(machine)}
        ${this.renderActivity(machine)}
        <span class="machine-info-url">${machineSubtitle(machine)}</span>
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
    const unreadLabel = hasStatusUnread(flags) ? "Unread sessions on this machine" : undefined;
    return renderActivityIndicator(kind, kind === "terminal" ? "Machine terminal active" : "Machine active", unreadLabel);
  }

  private selectedMachine(): Machine | undefined {
    return this.selected ?? this.machines.find((machine) => machine.id === "local") ?? this.machines[0];
  }

  private machineSwitcherAriaLabel(machine: Machine): string {
    return `Machine: ${machine.name}. Switch machine.`;
  }

  private switcherButton(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>(".machine-switcher-button");
  }

  private handleSwitcherButtonKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      void this.openMenuAndFocusOption(event.currentTarget);
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

  private toggleMenu(target: EventTarget | null): void {
    this.menuStyle = machineSwitcherMenuStyle(target);
    this.open = !this.open;
    this.openActionsMachineId = undefined;
  }

  private focusSwitcherButton(): boolean {
    const button = this.switcherButton();
    if (button === null) return false;
    button.focus();
    return true;
  }

  private async openMenuAndFocusOption(target: EventTarget | null): Promise<boolean> {
    this.menuStyle = machineSwitcherMenuStyle(target);
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

  private toggleActionsMenu(machineId: string, target: EventTarget | null): void {
    if (this.openActionsMachineId === machineId) {
      this.openActionsMachineId = undefined;
      return;
    }
    this.actionMenuStyle = actionMenuPanelStyle(target, { constrainTo: "viewport" });
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

  static override styles = css`
    :host { min-width: 0; display: block; }
    .machine-switcher { min-width: 0; }
    .machine-switcher-button { box-sizing: border-box; width: 100%; min-width: 0; display: flex; align-items: center; gap: 6px; border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-surface); color: var(--pi-text); padding: 5px 8px; cursor: pointer; text-align: left; }
    .machine-switcher-button:hover, .machine-switcher-button:focus-visible { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .machine-switcher-text { flex: 1 1 auto; min-width: 0; display: grid; gap: 1px; }
    .machine-switcher-kicker { color: var(--pi-muted); font-size: 10px; line-height: 1; text-transform: uppercase; letter-spacing: .02em; }
    .machine-switcher-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; line-height: 1.2; }
    .machine-status { flex: 0 0 auto; color: var(--pi-muted); font-size: 11px; }
    .machine-status.online { color: var(--pi-success); }
    .machine-status.offline, .machine-status.error { color: var(--pi-danger); }
    .machine-chevron { flex: 0 0 auto; color: var(--pi-muted); font-size: 11px; }
    .activity-indicator { flex: 0 0 auto; display: inline-block; width: 7px; height: 7px; background: var(--pi-success); animation: pulse 1s ease-in-out infinite; }
    .activity-indicator.session { border-radius: 50%; background: var(--pi-success); }
    .activity-indicator.terminal { border-radius: 2px; background: var(--pi-accent); }
    .activity-indicator.sending { border-radius: 50%; background: var(--pi-warning); }
    .activity-indicator.unread { border-radius: 50%; background: var(--pi-accent); animation: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--pi-accent) 20%, transparent); }
    .unread-ring { flex: 0 0 auto; box-sizing: border-box; display: inline-grid; place-items: center; width: 9px; height: 9px; border: 1.5px solid var(--pi-accent); border-radius: 50%; }
    .unread-ring .activity-indicator { width: 5px; height: 5px; }
    .machine-icon { flex: 0 0 auto; width: 16px; height: 16px; }
    .machine-icon.dimmed { filter: grayscale(1); opacity: .45; }
    .machine-option-main .machine-icon { width: 14px; height: 14px; }
    .machine-info { box-sizing: border-box; width: 100%; min-width: 0; display: flex; align-items: center; gap: 6px; border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-surface); color: var(--pi-text); padding: 5px 8px; }
    .machine-info-url { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
    .machine-switcher-menu { position: fixed; z-index: 10000; box-sizing: border-box; min-width: min(280px, calc(100vw - 16px)); overflow: auto; padding: 4px; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); box-shadow: 0 8px 24px var(--pi-shadow); }
    .machine-option { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px; align-items: stretch; margin: 2px 0; }
    .machine-option.no-actions { grid-template-columns: minmax(0, 1fr); }
    .machine-option-main, .machine-option-actions-toggle, .machine-option-actions-panel button { border: 0; border-radius: 7px; background: transparent; color: var(--pi-text); cursor: pointer; }
    .machine-option-main { min-width: 0; display: grid; gap: 2px; padding: 7px 8px; text-align: left; }
    .machine-option-name { min-width: 0; display: flex; align-items: center; gap: 6px; }
    .machine-option-name span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .machine-option-main small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-muted); }
    .machine-option-actions { position: relative; align-self: stretch; }
    .machine-option-actions-toggle { display: grid; place-items: center; height: 100%; min-width: 32px; padding: 0; color: var(--pi-muted); }
    .machine-option-actions-panel { position: fixed; z-index: 10001; box-sizing: border-box; min-width: min(120px, calc(100vw - 16px)); overflow: auto; padding: 4px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); box-shadow: 0 8px 24px var(--pi-shadow); }
    .machine-option-actions-panel button { display: block; width: 100%; padding: 7px 9px; text-align: left; white-space: nowrap; }
    .machine-option-actions-panel button.danger { color: var(--pi-danger); }
    .machine-option-main:hover, .machine-option-main:focus-visible, .machine-option-actions-toggle:hover, .machine-option-actions-toggle:focus-visible, .machine-option.selected .machine-option-main { background: var(--pi-selection-bg); }
    .machine-option-actions-panel button:hover, .machine-option-actions-panel button:focus-visible { background: var(--pi-selection-bg); }
    .machine-option-actions-panel button.danger:hover, .machine-option-actions-panel button.danger:focus-visible { background: color-mix(in srgb, var(--pi-danger) 14%, transparent); }
    @keyframes pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
  `;
}

function machineStatus(machine: Machine, statuses: Record<string, MachineHealth>): MachineStatus {
  return statuses[machine.id]?.status ?? machine.status ?? "unknown";
}

function machineStatusLabel(status: MachineStatus): string {
  return status === "online" ? "online" : status === "offline" ? "offline" : status === "error" ? "error" : "unknown";
}

function machineTitle(machine: Machine): string {
  return machine.baseUrl ?? machine.name;
}

/** The local machine identifies itself by the serving gateway's URL. */
function machineSubtitle(machine: Machine): string {
  if (machine.kind === "local") return browserGatewayDisplayUrl();
  return machine.baseUrl ?? "Remote Pi Web";
}

function machineSwitcherMenuStyle(target: EventTarget | null): string {
  if (typeof HTMLElement === "undefined" || typeof window === "undefined" || !(target instanceof HTMLElement)) return "";
  const trigger = target.getBoundingClientRect();
  const viewportPadding = 8;
  const menuWidth = Math.min(280, Math.max(0, window.innerWidth - viewportPadding * 2));
  const left = Math.min(Math.max(viewportPadding, trigger.left), Math.max(viewportPadding, window.innerWidth - viewportPadding - menuWidth));
  const availableBelow = Math.max(0, window.innerHeight - trigger.bottom - viewportPadding);
  return [`top: ${px(trigger.bottom)};`, `left: ${px(left)};`, `width: ${px(menuWidth)};`, `max-height: ${px(availableBelow)};`].join(" ");
}

function px(value: number): string {
  return `${String(Math.round(value))}px`;
}
