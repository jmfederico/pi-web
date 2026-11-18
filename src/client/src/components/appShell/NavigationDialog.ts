import { LocalizationController, localization } from "../../localization/browser";
import { appShellMessages as m } from "../../appShellMessages";
import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { ListReorderController } from "../listReorderController";
import type { DropPosition } from "../listReorder";
import { listReorderStyles } from "../ui/listReorderStyles";
import { uiDialogStyles, uiSelectionStyles } from "../ui/dialogStyles";
import { uiToolbarStyles } from "../ui/controlStyles";
import { scrollWhenSelected } from "../scrollWhenSelected";
import { isNavigationPinned, toggleNavigationPin, orderedNavigationTabs, moveNavigationTab, type NavigationPreferences } from "../../navigationPreferences";
import type { AppMobileMainTab } from "./AppMobileMainTabs";
import "../ModalSurface";

@customElement("navigation-dialog")
export class NavigationDialog extends LitElement {
  constructor() {
    super();
    new LocalizationController(this);
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) tabs: AppMobileMainTab[] = [];
  // Layout/search visibility must not narrow pin edits or saved ordering.
  @property({ attribute: false }) pinUniverse?: readonly string[];
  @property({ attribute: false }) preferences: NavigationPreferences = { pinnedIds: [], mobileCollapsed: false };
  @property({ attribute: false }) selectedTab?: AppMobileMainTab["id"];
  @property({ attribute: false }) onSelect?: (id: AppMobileMainTab["id"]) => void;
  @property({ attribute: false }) onPreferencesChange?: (preferences: NavigationPreferences) => void;
  @property({ attribute: false }) onClose?: () => void;

  @state() private query = "";
  @state() private selectedIndex = 0;
  @state() private moveAnnouncement = "";
  private pendingFocus: { id: string; selector: string; orderedIds: string[] } | undefined;
  private readonly reorder: ListReorderController<AppMobileMainTab> = new ListReorderController<AppMobileMainTab>(this, {
    items: () => this.filteredTabs(),
    enabled: () => this.canReorder(),
    handleSelector: ".reorder-handle",
    listSelector: ".options",
    label: (tab: AppMobileMainTab) => tab.label,
    onStart: () => { this.moveAnnouncement = ""; },
    onDrop: (tab, neighbor, position) => { this.move(tab, neighbor, position); },
  });

  private canReorder(): boolean {
    return this.query.trim() === "" && this.tabs.length > 1 && this.onPreferencesChange !== undefined;
  }

  private move(tab: AppMobileMainTab, neighbor: AppMobileMainTab, position: DropPosition, selector?: string): void {
    if (!this.canReorder()) return;
    const orderedIds = moveNavigationTab(tab.id, neighbor.id, position, this.preferences.orderedIds, this.pinUniverse ?? this.tabs.map((item) => item.id));
    const index = orderedNavigationTabs(this.tabs, orderedIds).findIndex((item) => item.id === tab.id);
    this.selectedIndex = index;
    this.moveAnnouncement = m.t("destinationMoved", { label: tab.label, index: index + 1, count: this.tabs.length });
    if (selector !== undefined) this.pendingFocus = { id: tab.id, selector, orderedIds };
    this.onPreferencesChange?.({ ...this.preferences, orderedIds });
  }

  private resetOrder(): void {
    this.reorder.cancel();
    this.pendingFocus = undefined;
    const preferences = { ...this.preferences };
    delete preferences.orderedIds;
    this.onPreferencesChange?.(preferences);
    this.moveAnnouncement = m.t("orderReset");
  }

  private moveBy(tab: AppMobileMainTab, delta: -1 | 1, selector: string): void {
    const tabs = this.filteredTabs();
    const neighbor = tabs[tabs.findIndex((item) => item.id === tab.id) + delta];
    if (neighbor !== undefined) this.move(tab, neighbor, delta === -1 ? "before" : "after", selector);
  }

  protected override updated(): void {
    const pending = this.pendingFocus;
    if (pending === undefined || this.preferences.orderedIds !== pending.orderedIds) return;
    this.pendingFocus = undefined;
    const row = [...this.renderRoot.querySelectorAll<HTMLElement>("[data-reorder-id]")].find((item) => item.dataset["reorderId"] === pending.id);
    const button = row?.querySelector<HTMLButtonElement>(pending.selector);
    // A boundary move disables that arrow. Keep focus on this destination's handle.
    const target = button?.disabled === true ? row?.querySelector<HTMLButtonElement>(".reorder-handle") : button;
    target?.focus();
    target?.scrollIntoView({ block: "nearest" });
  }

  private filteredTabs() {
    const query = this.query.trim().toLocaleLowerCase(localization.language);
    return orderedNavigationTabs(this.tabs, this.preferences.orderedIds).filter((tab) => tab.label.toLocaleLowerCase(localization.language).includes(query));
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    const previousTabs = changed.get("tabs");
    const previousPreferences = changed.get("preferences");
    if ((previousTabs !== undefined && previousTabs.map((tab) => tab.id).join("\0") !== this.tabs.map((tab) => tab.id).join("\0"))
      || (previousPreferences !== undefined && previousPreferences.orderedIds !== this.preferences.orderedIds)) this.reorder.cancel();
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
      <modal-surface .label=${m.t("navigation")} .initialFocus=${"input"} .onClose=${this.onClose} @keydown=${this.navigateDestinations}>
        <header class="ui-dialog-header">
          <input class="ui-dialog-search" aria-label=${m.t("search")} aria-describedby="navigation-selection" placeholder=${m.t("searchPlaceholder")} .value=${this.query} @input=${(event: Event) => {
            if (event.target instanceof HTMLInputElement) {
              this.reorder.cancel();
              this.query = event.target.value;
              this.selectedIndex = 0;
            }
          }}>
          <button class="ui-button ui-button--icon" aria-label=${m.t("close")} title=${m.t("close")} @click=${this.onClose}>×</button>
        </header>
        <span id="navigation-selection" class="sr-only" role="status" aria-live="polite" aria-atomic="true">${tabs.length === 0 ? m.t("noDestinations") : m.t("destinationPosition", { label: tabs[this.selectedIndex]?.label ?? "", index: this.selectedIndex + 1, count: tabs.length })}</span>
        <h2 class="ui-dialog-title">${m.t("navigation")}</h2>
        <p>${m.t("pinHint")}</p>
        <p id="reorder-hint">${m.t(this.query.trim() === "" ? "reorderHint" : "reorderSearchHint")}</p>
        <span id="reorder-keyboard-hint" class="sr-only">${m.t("reorderKeyboardHint")}</span>
        <span class="list-reorder-status" role="status" aria-live="polite" aria-atomic="true">${this.moveAnnouncement || this.reorder.announcement}</span>
        <nav class="options ui-selection-list" aria-label=${m.t("destinations")} @click=${(event: MouseEvent) => {
          if (this.reorder.consumeClick()) { event.preventDefault(); event.stopImmediatePropagation(); }
        }}>
          ${tabs.length === 0 ? html`<div class="empty ui-dialog-empty">${m.t("noDestinations")}</div>` : nothing}
          ${repeat(tabs, (tab) => tab.id, (tab, index) => html`
            <div class=${`destination ui-selection-row ${this.reorder.rowClass(tab.id)}`} data-reorder-id=${tab.id}
              @pointerdown=${(event: PointerEvent) => { this.reorder.begin(event, tab); }}
              @lostpointercapture=${(event: PointerEvent) => { this.reorder.handleLostPointerCapture(event); }}>
              <button type="button" class="reorder-handle ui-button ui-button--icon" ?disabled=${!this.canReorder()}
                aria-label=${m.t("reorder", { label: tab.label })} title=${m.t("reorder", { label: tab.label })} aria-describedby="reorder-hint reorder-keyboard-hint" aria-keyshortcuts="ArrowUp ArrowDown"
                @keydown=${(event: KeyboardEvent) => {
                  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
                  event.preventDefault(); event.stopPropagation();
                  this.moveBy(tab, event.key === "ArrowUp" ? -1 : 1, ".reorder-handle");
                }}>
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="8" cy="5" r="1.5"/><circle cx="16" cy="5" r="1.5"/><circle cx="8" cy="12" r="1.5"/><circle cx="16" cy="12" r="1.5"/><circle cx="8" cy="19" r="1.5"/><circle cx="16" cy="19" r="1.5"/></svg>
              </button>
              <button class=${`destination-button ui-button ui-selection-option ${index === this.selectedIndex ? "selected" : ""}`} aria-current=${tab.id === this.selectedTab ? "page" : nothing} aria-pressed=${String(tab.id === this.selectedTab)} ${scrollWhenSelected(index === this.selectedIndex, tab.id)} @focus=${() => { this.selectedIndex = index; }} @click=${() => { this.select(tab); }}>${tab.label}</button>
              <button type="button" class="move-up ui-button ui-button--icon" ?disabled=${!this.canReorder() || index === 0}
                aria-label=${m.t("moveUp", { label: tab.label })} title=${m.t("moveUp", { label: tab.label })}
                @click=${() => { this.moveBy(tab, -1, ".move-up"); }}><span aria-hidden="true">↑</span></button>
              <button type="button" class="move-down ui-button ui-button--icon" ?disabled=${!this.canReorder() || index === tabs.length - 1}
                aria-label=${m.t("moveDown", { label: tab.label })} title=${m.t("moveDown", { label: tab.label })}
                @click=${() => { this.moveBy(tab, 1, ".move-down"); }}><span aria-hidden="true">↓</span></button>
              <button type="button" class="pin-button ui-button ui-button--icon" aria-label=${m.t("pin", { label: tab.label })} title=${m.t(isNavigationPinned(tab.id, this.preferences.pinnedIds) ? "unpin" : "pin", { label: tab.label })} aria-pressed=${String(isNavigationPinned(tab.id, this.preferences.pinnedIds))} @click=${() => {
                this.onPreferencesChange?.({ ...this.preferences, pinnedIds: toggleNavigationPin(tab.id, this.preferences.pinnedIds, this.pinUniverse ?? this.tabs.map((item) => item.id)) });
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill=${isNavigationPinned(tab.id, this.preferences.pinnedIds) ? "currentColor" : "none"} stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M8 3h8l-1 7 4 4v2H5v-2l4-4-1-7Z"></path><path d="M12 16v6"></path>
                </svg>
              </button>
            </div>
          `)}
        </nav>
        <footer class="ui-dialog-footer">
          <div class="tab-actions">
            <button class="ui-button" @click=${() => { this.onPreferencesChange?.({ ...this.preferences, pinnedIds: [] }); }}>${m.t("showAll")}</button>
            <button class="ui-button" ?disabled=${this.onPreferencesChange === undefined} @click=${() => { this.resetOrder(); }}>${m.t("resetOrder")}</button>
          </div>
          <div class="mobile-navigation" role="group" aria-label=${m.t("mobileNavigation")}>
            <span>${m.t("mobileNavigation")}</span>
            <div class="toggle-options ui-toolbar ui-toolbar--borderless">
              <button type="button" class="ui-button" aria-pressed=${String(!this.preferences.mobileCollapsed)} @click=${() => {
                this.onPreferencesChange?.({ ...this.preferences, mobileCollapsed: false });
              }}>${m.t("expanded")}</button>
              <button type="button" class="ui-button" aria-pressed=${String(this.preferences.mobileCollapsed)} @click=${() => {
                this.onPreferencesChange?.({ ...this.preferences, mobileCollapsed: true });
              }}>${m.t("collapsed")}</button>
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

  static override styles = [uiDialogStyles, uiSelectionStyles, uiToolbarStyles, listReorderStyles, css`
    @layer pi-web-base {
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    footer { justify-content: space-between; flex-wrap: wrap; }
    .tab-actions { display: flex; flex-wrap: wrap; }
    h2 { align-self: stretch; padding: 12px 16px 4px; }
    p { margin: 0; padding: 0 12px 12px; color: var(--pi-muted); font-size: 12px; flex: 0 0 auto; }
    nav { overscroll-behavior: contain; }
    .destination { position: relative; }
    .destination.list-drag-preview { position: fixed; }
    .destination-button { overflow-wrap: anywhere; font-weight: 600; padding-inline: 8px; }
    .reorder-handle:not(:disabled) { cursor: grab; }
    .reorder-handle, .reorder-handle * { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
    .reorder-handle, .move-up, .move-down { color: var(--pi-muted); }
    .pin-button[aria-pressed="true"] svg { color: var(--pi-accent); }
    .mobile-navigation { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px; }
    }
  `];
}
