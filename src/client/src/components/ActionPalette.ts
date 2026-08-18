import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AppAction } from "../actions";
import { formatShortcut } from "../keyboardShortcuts";
import { keyboardEventOriginatesFromNativeActivationControl } from "./keyboardEventTarget";
import "./ModalSurface";
import { scrollWhenSelected } from "./scrollWhenSelected";

@customElement("action-palette")
export class ActionPalette extends LitElement {
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
          <button title="Close" aria-label="Close" @click=${() => this.onCancel?.()}>×</button>
        </header>
        <div class="options">
          ${actions.length === 0 ? html`<div class="empty">No actions found.</div>` : actions.map((action, index) => html`
            <button
              class=${`${index === this.selectedIndex ? "selected" : ""} ${action.enabled === false ? "disabled" : ""}`}
              ?disabled=${action.enabled === false}
              title=${action.disabledReason ?? action.title}
              aria-current=${index === this.selectedIndex ? "true" : nothing}
              ${scrollWhenSelected(index === this.selectedIndex, action.id)}
              @focus=${() => { this.selectedIndex = index; }}
              @click=${() => { this.run(action); }}
            >
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

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 20; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    modal-surface { --palette-top: min(12dvh, 90px); --palette-bottom: max(20px, env(safe-area-inset-bottom)); --modal-surface-place-items: start center; --modal-surface-backdrop-padding: var(--palette-top) 20px var(--palette-bottom); --modal-surface-max-height: min(640px, calc(100dvh - var(--palette-top) - var(--palette-bottom))); }
    header { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 10px; border-bottom: 1px solid var(--pi-border); }
    input { min-width: 0; border: 0; outline: none; background: transparent; color: var(--pi-text); font: var(--pi-control-font-size, 16px) var(--pi-control-font-family, system-ui, sans-serif); padding: 8px; }
    input::placeholder { color: var(--pi-dim); }
    button { border: 0; background: transparent; color: var(--pi-text); cursor: pointer; }
    header button { color: var(--pi-muted); font-size: 22px; padding: 2px 8px; }
    .options { flex: 1 1 auto; min-height: 0; overflow: auto; }
    .options button { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 12px; width: 100%; padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted); text-align: left; }
    .options button.selected, .options button:hover:not(:disabled) { background: var(--pi-selection-bg); }
    .options button:disabled { cursor: not-allowed; opacity: .68; }
    .options button.disabled.selected { background: color-mix(in srgb, var(--pi-selection-bg) 55%, transparent); }
    .main { min-width: 0; }
    strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    small { display: block; color: var(--pi-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .disabled-reason { color: var(--pi-warning); }
    .group { grid-column: 1 / -1; font-size: 12px; }
    kbd { align-self: center; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-muted); padding: 2px 6px; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: nowrap; }
    .empty { padding: 24px; color: var(--pi-muted); text-align: center; }
  `;
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
