import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AppAction } from "../actions";
import { formatShortcut } from "../keyboardShortcuts";
import { keyboardEventOriginatesFromNativeActivationControl } from "./keyboardEventTarget";
import "./ModalSurface";
import { scrollWhenSelected } from "./scrollWhenSelected";
import { uiDialogStyles, uiSelectionStyles } from "./ui/dialogStyles";

@customElement("action-palette")
export class ActionPalette extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) actions: AppAction[] = [];
  @property({ attribute: false }) onRun?: (action: AppAction) => void;
  @property({ attribute: false }) onCancel?: () => void;
  @state() private queryText = "";
  @state() private selectedIndex = 0;

  override render() {
    const actions = this.filteredActions();
    return html`
      <modal-surface
        .onClose=${() => this.onCancel?.()}
        .initialFocus=${"input"}
        .label=${"Action palette"}
        @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}
      >
        <header class="ui-dialog-header">
          <input class="ui-dialog-search" aria-label="Search actions"
            .value=${this.queryText}
            placeholder="Search actions..."
            @input=${(event: Event) => {
              if (event.target instanceof HTMLInputElement) {
                this.queryText = event.target.value;
                this.selectedIndex = 0;
              }
            }}
          >
          <button class="ui-button ui-button--icon" title="Close" aria-label="Close" @click=${() => this.onCancel?.()}>×</button>
        </header>
        <div class="options ui-selection-list">
          ${actions.length === 0 ? html`<div class="empty ui-dialog-empty">No actions found.</div>` : actions.map((action, index) => {
            const hasDescription = action.description !== undefined && action.description !== "";
            const group = action.group !== undefined && action.group !== ""
              ? html`<small class="group ui-selection-detail">${action.group}</small>` : nothing;
            return html`
            <button
              class=${`ui-button ui-selection-option ${index === this.selectedIndex ? "selected" : ""} ${action.enabled === false ? "disabled" : ""}`}
              ?disabled=${action.enabled === false}
              title=${action.disabledReason ?? action.title}
              aria-current=${index === this.selectedIndex ? "true" : nothing}
              ${scrollWhenSelected(index === this.selectedIndex, action.id)}
              @focus=${() => { this.selectedIndex = index; }}
              @click=${() => { this.run(action); }}
            >
              <span class="heading">
                <strong>${action.title}</strong>
                ${hasDescription ? nothing : group}
                ${action.shortcut !== undefined ? html`<kbd>${formatShortcut(action.shortcut)}</kbd>` : nothing}
              </span>
              ${hasDescription ? html`<span class="details ui-selection-detail"><small class="description">${action.description}</small>${group}</span>` : nothing}
              ${action.enabled === false && action.disabledReason !== undefined ? html`<small class="disabled-reason ui-selection-detail">${action.disabledReason}</small>` : nothing}
            </button>
          `;
          })}
        </div>
      </modal-surface>
    `;
  }

  protected override updated(changed: PropertyValues) {
    if (!changed.has("actions") && !changed.has("queryText")) return;
    const maxIndex = Math.max(0, this.filteredActions().length - 1);
    if (this.selectedIndex > maxIndex) this.selectedIndex = maxIndex;
  }

  private filteredActions(): AppAction[] {
    return filterActionPaletteActions(this.actions, this.queryText);
  }

  // Escape and backdrop presses are owned by the modal surface (routed to
  // `onCancel`). Search-input keys retain the action-list navigation idiom,
  // while focused native buttons keep their own semantics.
  private handleKeyDown(event: KeyboardEvent) {
    if (keyboardEventOriginatesFromNativeActivationControl(event)) return;
    const actions = this.filteredActions();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (actions.length > 0) this.selectedIndex = (this.selectedIndex + 1) % actions.length;
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (actions.length > 0) this.selectedIndex = (this.selectedIndex - 1 + actions.length) % actions.length;
    } else if (event.key === "Enter") {
      event.preventDefault();
      const action = actions[this.selectedIndex];
      if (action !== undefined) this.run(action);
    }
  }

  private run(action: AppAction) {
    if (action.enabled === false) return;
    this.onRun?.(action);
  }

  static override styles = [uiDialogStyles, uiSelectionStyles, css`
    .heading, .details { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; min-width: 0; }
    strong { flex: 1 1 12ch; min-width: 0; }
    .description { flex: 1 1 24ch; min-width: 0; font: inherit; }
    .disabled-reason { color: var(--pi-warning); }
    .group { flex: 0 1 auto; min-width: 0; max-width: 100%; margin: 0 0 0 auto; text-align: right; font-size: 12px; }
    kbd { flex: 0 1 auto; max-width: 100%; margin-inline-start: auto; align-self: center; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-muted); padding: 2px 6px; font: 12px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); white-space: normal; }
  `];
}

export function filterActionPaletteActions(actions: readonly AppAction[], queryText: string): AppAction[] {
  const query = queryText.trim().toLowerCase();
  return actions
    .filter((action) => action.enabled !== false || action.disabledReason !== undefined)
    .filter((action) => {
      if (query === "") return true;
      const haystack = [action.title, action.description ?? "", action.disabledReason ?? "", action.group ?? "", action.shortcut ?? ""].join(" ").toLowerCase();
      return haystack.includes(query);
    });
}
