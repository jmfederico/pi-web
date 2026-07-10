import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { AppAction } from "../actions";
import { fuzzySearch } from "../utils/fuzzySearch";
import { formatShortcut } from "../keyboardShortcuts";
import { scrollWhenSelected } from "./scrollWhenSelected";
import { actionPaletteStyles } from "./shared";

@customElement("action-palette")
export class ActionPalette extends LitElement {
  @property({ attribute: false }) actions: AppAction[] = [];
  @property({ attribute: false }) onRun?: (action: AppAction) => void;
  @property({ attribute: false }) onCancel?: () => void;
  @query("input") private input?: HTMLInputElement;
  @state() private queryText = "";
  @state() private selectedIndex = 0;

  override render() {
    const actions = this.filteredActions();
    return html`
      <div class="backdrop" @mousedown=${() => this.onCancel?.()}>
        <section @mousedown=${(event: MouseEvent) => { event.stopPropagation(); }} @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}>
          <header>
            <input
              .value=${this.queryText}
              placeholder="Search actions..."
              @input=${(event: Event) => {
                if (event.target instanceof HTMLInputElement) {
                  this.queryText = event.target.value;
                  this.selectedIndex = 0;
                }
              }}
            >
            <button title="Close" @click=${() => this.onCancel?.()}>×</button>
          </header>
          <div class="options">
            ${actions.length === 0 ? html`<div class="empty">No actions found.</div>` : actions.map((action, index) => html`
              <button class=${`${index === this.selectedIndex ? "selected" : ""} ${action.enabled === false ? "disabled" : ""}`} ?disabled=${action.enabled === false} title=${action.disabledReason ?? action.title} ${scrollWhenSelected(index === this.selectedIndex, action.id)} @click=${() => { this.run(action); }}>
                <span class="main">
                  <strong>${action.title}</strong>
                  ${action.description !== undefined && action.description !== "" ? html`<small>${action.description}</small>` : null}
                  ${action.enabled === false && action.disabledReason !== undefined ? html`<small class="disabled-reason">${action.disabledReason}</small>` : null}
                </span>
                ${action.shortcut !== undefined ? html`<kbd>${formatShortcut(action.shortcut)}</kbd>` : null}
                ${action.group !== undefined && action.group !== "" ? html`<small class="group">${action.group}</small>` : null}
              </button>
            `)}
          </div>
        </section>
      </div>
    `;
  }

  override firstUpdated() {
    this.input?.focus();
  }

  protected override updated(changed: PropertyValues) {
    if (!changed.has("actions") && !changed.has("queryText")) return;
    const maxIndex = Math.max(0, this.filteredActions().length - 1);
    if (this.selectedIndex > maxIndex) this.selectedIndex = maxIndex;
  }

  private filteredActions(): AppAction[] {
    return filterActionPaletteActions(this.actions, this.queryText);
  }

  private handleKeyDown(event: KeyboardEvent) {
    const actions = this.filteredActions();
    if (event.key === "Escape") {
      event.preventDefault();
      this.onCancel?.();
    } else if (event.key === "ArrowDown") {
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

  static override styles = actionPaletteStyles;
}

export function filterActionPaletteActions(actions: readonly AppAction[], queryText: string): AppAction[] {
  const query = queryText.trim();
  const eligible = actions.filter((action) => action.enabled !== false || action.disabledReason !== undefined);
  if (query === "") return [...eligible];
  return fuzzySearch(query, eligible.map((a) => ({
    text: [a.title, a.description ?? "", a.disabledReason ?? "", a.group ?? "", a.shortcut ?? ""].join(" "),
    item: a,
  }))).map((r) => r.item);
}
