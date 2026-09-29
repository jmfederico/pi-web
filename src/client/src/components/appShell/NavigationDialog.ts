import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { paletteStyles } from "../paletteStyles";
import { scrollWhenSelected } from "../scrollWhenSelected";
import { isNavigationPinned, toggleNavigationPin, type NavigationPreferences } from "../../navigationPreferences";
import type { AppMobileMainTab } from "./AppMobileMainTabs";
import "../ModalSurface";

@customElement("navigation-dialog")
export class NavigationDialog extends LitElement {
  @property({ attribute: false }) tabs: AppMobileMainTab[] = [];
  // Layout/search visibility must not narrow implicit-all pin edits.
  @property({ attribute: false }) pinUniverse?: readonly string[];
  @property({ attribute: false }) preferences: NavigationPreferences = { pinnedIds: [], mobileCollapsed: false };
  @property({ attribute: false }) selectedTab?: AppMobileMainTab["id"];
  @property({ attribute: false }) onSelect?: (id: AppMobileMainTab["id"]) => void;
  @property({ attribute: false }) onPreferencesChange?: (preferences: NavigationPreferences) => void;
  @property({ attribute: false }) onClose?: () => void;

  @state() private query = "";
  @state() private selectedIndex = 0;

  private filteredTabs() {
    const query = this.query.trim().toLowerCase();
    return this.tabs.filter((tab) => tab.label.toLowerCase().includes(query));
  }

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("selectedTab")) {
      this.selectedIndex = Math.max(0, this.filteredTabs().findIndex((tab) => tab.id === this.selectedTab));
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredTabs().length - 1));
  }

  private select(tab: AppMobileMainTab) {
    this.onSelect?.(tab.id);
    this.onClose?.();
  }

  override render() {
    const tabs = this.filteredTabs();
    return html`
      <modal-surface .label=${"Navigation"} .initialFocus=${"input"} .onClose=${this.onClose} @keydown=${this.navigateDestinations}>
        <header>
          <input aria-label="Search navigation" aria-describedby="navigation-selection" placeholder="Search navigation..." .value=${this.query} @input=${(event: Event) => {
            if (event.target instanceof HTMLInputElement) {
              this.query = event.target.value;
              this.selectedIndex = 0;
            }
          }}>
          <button aria-label="Close" title="Close" @click=${this.onClose}>×</button>
        </header>
        <span id="navigation-selection" class="sr-only" role="status" aria-live="polite" aria-atomic="true">${tabs.length === 0 ? "No destinations found." : `${tabs[this.selectedIndex]?.label ?? ""}, ${String(this.selectedIndex + 1)} of ${String(tabs.length)}`}</span>
        <h2>Navigation</h2>
        <p>Pin destinations to the tab bars. Removing the last pin shows all tabs.</p>
        <nav class="options" aria-label="Destinations">
          ${tabs.length === 0 ? html`<div class="empty">No destinations found.</div>` : nothing}
          ${tabs.map((tab, index) => html`
            <div class="destination">
              <button class=${`destination-button ${index === this.selectedIndex ? "selected" : ""}`} aria-current=${tab.id === this.selectedTab ? "page" : nothing} aria-pressed=${String(tab.id === this.selectedTab)} ${scrollWhenSelected(index === this.selectedIndex, tab.id)} @focus=${() => { this.selectedIndex = index; }} @click=${() => { this.select(tab); }}>${tab.label}</button>
              <button type="button" class="pin-button" aria-label=${`Pin ${tab.label}`} title=${isNavigationPinned(tab.id, this.preferences.pinnedIds) ? `Unpin ${tab.label}` : `Pin ${tab.label}`} aria-pressed=${String(isNavigationPinned(tab.id, this.preferences.pinnedIds))} @click=${() => {
                this.onPreferencesChange?.({ ...this.preferences, pinnedIds: toggleNavigationPin(tab.id, this.preferences.pinnedIds, this.pinUniverse ?? this.tabs.map((item) => item.id)) });
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill=${isNavigationPinned(tab.id, this.preferences.pinnedIds) ? "currentColor" : "none"} stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M8 3h8l-1 7 4 4v2H5v-2l4-4-1-7Z"></path><path d="M12 16v6"></path>
                </svg>
              </button>
            </div>
          `)}
        </nav>
        <footer>
          <button @click=${() => { this.onPreferencesChange?.({ ...this.preferences, pinnedIds: [] }); }}>Show all tabs</button>
          <div class="mobile-navigation" role="group" aria-label="Mobile navigation">
            <span>Mobile navigation</span>
            <div class="toggle-options">
              <button type="button" aria-pressed=${String(!this.preferences.mobileCollapsed)} @click=${() => {
                this.onPreferencesChange?.({ ...this.preferences, mobileCollapsed: false });
              }}>Expanded</button>
              <button type="button" aria-pressed=${String(this.preferences.mobileCollapsed)} @click=${() => {
                this.onPreferencesChange?.({ ...this.preferences, mobileCollapsed: true });
              }}>Collapsed</button>
            </div>
          </div>
        </footer>
      </modal-surface>
    `;
  }

  private readonly navigateDestinations = (event: KeyboardEvent): void => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      const tabs = this.filteredTabs();
      switch (event.key) {
        case "ArrowDown": this.selectedIndex = tabs.length > 0 ? (this.selectedIndex + 1) % tabs.length : 0; break;
        case "ArrowUp": this.selectedIndex = tabs.length > 0 ? (this.selectedIndex + tabs.length - 1) % tabs.length : 0; break;
        case "Home": this.selectedIndex = 0; break;
        case "End": this.selectedIndex = Math.max(0, tabs.length - 1); break;
        case "Enter": {
          const tab = tabs[this.selectedIndex];
          if (tab !== undefined) this.select(tab);
          break;
        }
        default: return;
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!(target instanceof HTMLButtonElement)) return;
    const selector = target.classList.contains("pin-button") ? ".pin-button" : ".destination-button";
    const buttons = [...this.renderRoot.querySelectorAll<HTMLButtonElement>(selector)];
    const index = buttons.indexOf(target);
    if (index < 0) return;
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = (index + 1) % buttons.length; break;
      case "ArrowUp": next = (index + buttons.length - 1) % buttons.length; break;
      case "Home": next = 0; break;
      case "End": next = buttons.length - 1; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    buttons[next]?.focus();
    buttons[next]?.scrollIntoView({ block: "nearest" });
  };

  static override styles = [paletteStyles, css`
    :host { z-index: 30; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    header, footer { flex: 0 0 auto; }
    .destination, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    h2 { margin: 0; padding: 12px 12px 4px; font-size: 14px; }
    p { margin: 0; padding: 0 12px 12px; color: var(--pi-muted); font-size: 12px; flex: 0 0 auto; }
    nav { overscroll-behavior: contain; }
    .destination { border-bottom: 1px solid var(--pi-border-muted); gap: 0; }
    .destination-button { flex: 1; min-width: 0; overflow-wrap: anywhere; text-align: left; padding: 10px 12px; font: inherit; font-weight: 600; }
    .destination-button.selected, .destination-button:hover { background: var(--pi-selection-bg); }
    .pin-button { display: inline-flex; align-items: center; justify-content: center; padding: 10px 12px; }
    .pin-button[aria-pressed="true"] svg { color: var(--pi-accent); }
    footer { padding: 12px; flex-wrap: wrap; border-top: 1px solid var(--pi-border); }
    .mobile-navigation { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px; }
    .toggle-options { display: inline-flex; gap: 4px; }
    .toggle-options button { font-size: inherit; padding: 5px 7px; }
    footer button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); padding: 7px 9px; }
    button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    footer button[aria-pressed="true"] { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
  `];
}
