import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { CommandOption } from "../api";
import { keyboardEventOriginatesFromNativeActivationControl } from "./keyboardEventTarget";
import "./ModalSurface";
import { scrollWhenSelected } from "./scrollWhenSelected";

@customElement("command-picker")
export class CommandPicker extends LitElement {
  @property() override title = "Select";
  @property({ type: Boolean }) searchable = false;
  @property({ attribute: false }) options: CommandOption[] = [];
  @property({ attribute: false }) selectedValue?: string;
  @property({ attribute: false }) onPick?: (value: string) => void;
  @property({ attribute: false }) onCancel?: () => void;
  @state() private selectedIndex = 0;
  @state() private query = "";

  override render() {
    const options = this.filteredOptions();
    return html`
      <modal-surface
        .onClose=${() => this.onCancel?.()}
        .initialFocus=${this.searchable ? "input" : ".options"}
        .label=${this.title}
        @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}
      >
        <header>
          <strong>${this.title}</strong>
          <button aria-label="Close" @click=${() => this.onCancel?.()}>×</button>
        </header>
        ${this.searchable ? html`<input placeholder="Search" .value=${this.query} @input=${(event: Event) => { this.handleSearchInput(event); }}>` : null}
        <div class="options" tabindex="0">
          ${options.map((option, index) => html`
            <button
              class=${index === this.selectedIndex ? "selected" : ""}
              aria-current=${index === this.selectedIndex ? "true" : nothing}
              ${scrollWhenSelected(index === this.selectedIndex, option.value)}
              @focus=${() => { this.selectedIndex = index; }}
              @click=${() => this.onPick?.(option.value)}
            >
              <span>${option.label}</span>
              ${option.description !== undefined && option.description !== "" ? html`<small>${option.description}</small>` : null}
            </button>
          `)}
          ${options.length === 0 ? html`<div class="empty">No matching options</div>` : null}
        </div>
      </modal-surface>
    `;
  }

  override firstUpdated() {
    this.selectInitialValue();
  }

  private selectInitialValue(): void {
    if (this.selectedValue === undefined) return;
    const index = this.filteredOptions().findIndex((option) => option.value === this.selectedValue);
    if (index >= 0) this.selectedIndex = index;
  }

  private handleSearchInput(event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      this.query = event.target.value;
      this.selectedIndex = 0;
    }
  }

  private filteredOptions(): CommandOption[] {
    const query = this.query.trim().toLowerCase();
    if (query === "") return this.options;
    return this.options.filter((option) => `${option.label} ${option.description ?? ""} ${option.value}`.toLowerCase().includes(query));
  }

  // Escape and backdrop presses are owned by the modal surface (routed to
  // `onCancel`). Search and list-container keys retain the broadened option
  // navigation idiom, while focused native buttons keep their own semantics.
  private handleKeyDown(event: KeyboardEvent) {
    if (keyboardEventOriginatesFromNativeActivationControl(event)) return;
    const options = this.filteredOptions();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (options.length > 0) this.selectedIndex = (this.selectedIndex + 1) % options.length;
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length > 0) this.selectedIndex = (this.selectedIndex - 1 + options.length) % options.length;
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[this.selectedIndex];
      if (option) this.onPick?.(option.value);
    }
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 10; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    modal-surface { --modal-surface-width: min(720px, calc(100vw - 40px)); --modal-surface-max-height: min(640px, calc(100vh - 40px)); }
    header { display: flex; align-items: center; justify-content: space-between; padding: 12px; border-bottom: 1px solid var(--pi-border); }
    .options { min-height: 0; overflow: auto; outline: none; }
    button { border: 0; background: transparent; color: var(--pi-text); cursor: pointer; }
    header button { font-size: 20px; color: var(--pi-muted); }
    input { margin: 10px 12px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); font: var(--pi-control-font-size, 16px) var(--pi-control-font-family, system-ui, sans-serif); padding: 8px 10px; outline: none; }
    input:focus { border-color: var(--pi-accent); }
    .options button { display: block; width: 100%; padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted); text-align: left; }
    .options button.selected, .options button:hover { background: var(--pi-selection-bg); }
    small { display: block; margin-top: 4px; color: var(--pi-muted); }
    .empty { padding: 24px; color: var(--pi-muted); text-align: center; }
  `;
}
