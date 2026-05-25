import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Machine, MachineHealth } from "../api";
import { activateSelectableRow, activateSelectableRowFromKeyboard } from "./selectableRow";
import { listStyles } from "./shared";

@customElement("machine-list")
export class MachineList extends LitElement {
  @property({ attribute: false }) machines: Machine[] = [];
  @property({ attribute: false }) selected?: Machine;
  @property({ attribute: false }) statuses: Record<string, MachineHealth> = {};
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ attribute: false }) onSelect?: (machine: Machine) => void;
  @property({ attribute: false }) onToggleCollapsed?: () => void;

  override render() {
    return html`
      <section>
        <h2>${this.renderHeading()}</h2>
        ${this.collapsed ? null : this.machines.map((machine) => {
          const status = this.statuses[machine.id]?.status ?? machine.status ?? "unknown";
          const statusLabel = status === "online" ? "online" : status === "offline" ? "offline" : status === "error" ? "error" : "unknown";
          return html`
            <div
              class=${`action-row ${this.selected?.id === machine.id ? "selected" : ""}`}
              tabindex="0"
              title=${machine.baseUrl ?? machine.name}
              @click=${(event: MouseEvent) => { activateSelectableRow(event, () => this.onSelect?.(machine)); }}
              @keydown=${(event: KeyboardEvent) => { activateSelectableRowFromKeyboard(event, () => this.onSelect?.(machine)); }}
            >
              <div class="action-main">
                <span class="action-name">${machine.name}</span><small>${machine.kind === "local" ? "Local Pi Web" : machine.baseUrl ?? "Remote Pi Web"} · ${statusLabel}</small>
              </div>
            </div>
          `;
        })}
      </section>
    `;
  }

  private renderHeading() {
    if (!this.collapsible) return "Machines";
    const selectedSummary = this.selected?.name ?? "No machine selected";
    const selectedTitle = this.selected?.baseUrl ?? selectedSummary;
    return html`<button class="section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} Machines</span><small class="section-selected" title=${selectedTitle}>${selectedSummary}</small></span><small class="section-count">${this.machines.length}</small></button>`;
  }

  static override styles = listStyles;
}
