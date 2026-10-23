import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { CommandOption } from "../api";
import { keyboardEventOriginatesFromNativeActivationControl } from "./keyboardEventTarget";
import "./ModalSurface";
import { defaultPin, defaultPinHelp, defaultPinStyles } from "./DefaultPin";
import { scrollWhenSelected } from "./scrollWhenSelected";
import { uiDialogStyles, uiSelectionStyles } from "./ui/dialogStyles";

@customElement("command-picker")
export class CommandPicker extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property() override title = "Select";
  @property({ type: Boolean }) searchable = false;
  @property({ attribute: false }) options: CommandOption[] = [];
  @property({ attribute: false }) selectedValue?: string;
  @property({ attribute: false }) onPick?: (value: string) => void;
  @property({ attribute: false }) onCancel?: () => void;
  @property({ attribute: false }) defaultValue?: string;
  /** Host applies the default and reports save errors. */
  @property({ attribute: false }) onSetDefault?: (value: string) => Promise<unknown>;
  @property({ type: Boolean }) defaultsLoading = false;
  @state() private defaultPending = false;
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
        <header class="ui-dialog-header">
          <strong class="ui-dialog-title">${this.title}</strong>
          <button class="ui-button ui-button--icon" aria-label="Close" @click=${() => this.onCancel?.()}>×</button>
        </header>
        ${this.searchable ? html`<div class="ui-dialog-search-row"><input class="ui-dialog-search" placeholder="Search" .value=${this.query} @input=${(event: Event) => { this.handleSearchInput(event); }}></div>` : null}
        ${this.onSetDefault ? defaultPinHelp : nothing}
        <div class="options ui-selection-list" tabindex="0">
          ${options.map((option, index) => {
            const pick = html`<button
              class=${`ui-button ui-selection-option ${index === this.selectedIndex ? "selected" : ""}`}
              aria-current=${index === this.selectedIndex ? "true" : nothing}
              ${scrollWhenSelected(index === this.selectedIndex, option.value)}
              @focus=${() => { this.selectedIndex = index; }}
              @click=${() => this.onPick?.(option.value)}
            >
              <span>${option.label}</span>
              ${option.description !== undefined && option.description !== "" ? html`<small class="ui-selection-detail">${option.description}</small>` : null}
            </button>`;
            return this.onSetDefault ? html`<div class="default-row ui-selection-row">${pick}${defaultPin(option.label, option.value === this.defaultValue, this.defaultsLoading || this.defaultPending, () => { void this.setDefault(option.value); })}</div>` : pick;
          })}
          ${options.length === 0 ? html`<div class="empty ui-dialog-empty">No matching options</div>` : null}
        </div>
      </modal-surface>
    `;
  }

  private async setDefault(value: string): Promise<void> {
    if (!this.onSetDefault || this.defaultsLoading || this.defaultPending) return;
    this.defaultPending = true;
    try {
      await this.onSetDefault(value);
    } catch (error: unknown) {
      // Hosts own user-facing errors; keep unexpected callback rejections observable.
      console.warn("Failed to set default option", error);
    } finally {
      this.defaultPending = false;
    }
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

  static override styles = [uiDialogStyles, uiSelectionStyles, defaultPinStyles];
}
