import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { CommandOption } from "../api";
import { fuzzySearch } from "../utils/fuzzySearch";
import { scrollWhenSelected } from "./scrollWhenSelected";
import { commandPickerStyles } from "./shared";

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
      <div class="backdrop" @mousedown=${() => this.onCancel?.()}>
        <section @mousedown=${(event: MouseEvent) => { event.stopPropagation(); }}>
          <header>
            <strong>${this.title}</strong>
            <button @click=${() => this.onCancel?.()}>×</button>
          </header>
          ${this.searchable ? html`<input placeholder="Search" .value=${this.query} @input=${(event: Event) => { this.handleSearchInput(event); }} @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}>` : null}
          <div class="options" @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }} tabindex="0">
            ${options.map((option, index) => html`
              <button class=${index === this.selectedIndex ? "selected" : ""} ${scrollWhenSelected(index === this.selectedIndex, option.value)} @click=${() => this.onPick?.(option.value)}>
                <span>${option.label}</span>
                ${option.description !== undefined && option.description !== "" ? html`<small>${option.description}</small>` : null}
              </button>
            `)}
            ${options.length === 0 ? html`<div class="empty">No matching options</div>` : null}
          </div>
        </section>
      </div>
    `;
  }

  override firstUpdated() {
    this.selectInitialValue();
    this.renderRoot.querySelector<HTMLElement>(this.searchable ? "input" : ".options")?.focus();
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
    const query = this.query.trim();
    if (query === "") return this.options;
    return fuzzySearch(query, this.options.map((o) => ({ text: `${o.label} ${o.description ?? ""} ${o.value}`, item: o }))).map((r) => r.item);
  }

  private handleKeyDown(event: KeyboardEvent) {
    const options = this.filteredOptions();
    if (event.key === "Escape") {
      event.preventDefault();
      this.onCancel?.();
    } else if (event.key === "ArrowDown") {
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

  static override styles = commandPickerStyles;
}
