import { LitElement, css, html, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { AppState } from "../../appState";
import { renderAppTabIcon, type AppTabBuiltinIcon } from "../tabIcons";

export type AppMobileMainTabBuiltinIcon = AppTabBuiltinIcon;
export type AppMobileMainTabIcon = AppMobileMainTabBuiltinIcon | TemplateResult;

export interface AppMobileMainTab {
  id: AppState["mainView"];
  label: string;
  icon?: AppMobileMainTabIcon;
  badge?: unknown;
  badgeLabel?: string | undefined;
  badgeTone?: "unread" | undefined;
  className?: string | undefined;
}

@customElement("app-mobile-main-tabs")
export class AppMobileMainTabs extends LitElement {
  @property({ attribute: false }) tabs: AppMobileMainTab[] = [];
  @property({ attribute: false }) selectedView: AppState["mainView"] = "chat";
  @property({ attribute: false }) onSelect?: (view: AppState["mainView"]) => void;
  @query(".mobile-tabs") private mobileTabs?: HTMLElement | null;
  @state() private canScrollLeft = false;
  @state() private canScrollRight = false;
  private observedMobileTabs: HTMLElement | undefined;
  private mobileTabsResizeObserver: ResizeObserver | undefined;

  override disconnectedCallback(): void {
    this.mobileTabsResizeObserver?.disconnect();
    this.mobileTabsResizeObserver = undefined;
    this.observedMobileTabs = undefined;
    super.disconnectedCallback();
  }

  override firstUpdated(): void {
    this.observeMobileTabs();
    this.updateScrollState();
  }

  override updated(): void {
    this.observeMobileTabs();
    this.updateScrollState();
  }

  override render() {
    const fallbackLabels = this.fallbackLabels();
    return html`
      <div class=${this.frameClass()}>
        <div class="mobile-tabs" @scroll=${this.onMobileTabsScroll}>
          ${this.tabs.map((tab) => {
            const selected = this.selectedView === tab.id;
            return html`
              <button class=${this.tabClass(tab)} title=${tab.label} aria-label=${this.tabAriaLabel(tab)} aria-pressed=${String(selected)} @click=${() => { this.onSelect?.(tab.id); }}>
                ${this.renderTabMark(tab, fallbackLabels)}
                <span class="tab-label">${tab.label}</span>
                ${this.renderBadge(tab.badge, tab.badgeTone)}
              </button>
            `;
          })}
        </div>
      </div>
    `;
  }

  private frameClass(): string {
    return `mobile-tabs-frame${this.canScrollLeft ? " can-scroll-left" : ""}${this.canScrollRight ? " can-scroll-right" : ""}`;
  }

  private tabClass(tab: AppMobileMainTab): string {
    return [
      ...(tab.className === undefined ? [] : [tab.className]),
      ...(this.selectedView === tab.id ? ["selected"] : []),
    ].join(" ");
  }

  private tabAriaLabel(tab: AppMobileMainTab): string {
    const badge = tab.badgeLabel ?? (typeof tab.badge === "string" || typeof tab.badge === "number" ? String(tab.badge).trim() : "");
    return badge === "" ? tab.label : `${tab.label}, ${badge}`;
  }

  private renderBadge(badge: unknown, tone: AppMobileMainTab["badgeTone"]) {
    if (badge === undefined || badge === "") return null;
    return html`<span class=${`tab-badge${tone === undefined ? "" : ` ${tone}`}`}>${badge}</span>`;
  }

  private renderTabMark(tab: AppMobileMainTab, fallbackLabels: Map<AppState["mainView"], string>) {
    return tab.icon === undefined
      ? html`<span class="tab-fallback" aria-hidden="true">${fallbackLabels.get(tab.id) ?? this.initialsLabel(tab.label)}</span>`
      : renderAppTabIcon(tab.icon);
  }

  private fallbackLabels(): Map<AppState["mainView"], string> {
    const fallbackTabs = this.tabs.filter((tab) => tab.icon === undefined);
    const counts = new Map<string, number>();
    for (const tab of fallbackTabs) {
      const initials = this.initialsLabel(tab.label);
      counts.set(initials, (counts.get(initials) ?? 0) + 1);
    }

    const labels = new Map<AppState["mainView"], string>();
    for (const tab of fallbackTabs) {
      const initials = this.initialsLabel(tab.label);
      labels.set(tab.id, (counts.get(initials) ?? 0) > 1 ? this.fullFallbackLabel(tab.label) : initials);
    }
    return labels;
  }

  private initialsLabel(label: string): string {
    const words = label.match(/[\p{L}\p{N}]+/gu) ?? [];
    const initials = words.map((word) => Array.from(word)[0] ?? "").join("").toLocaleUpperCase();
    return initials === "" ? "?" : initials;
  }

  private fullFallbackLabel(label: string): string {
    const trimmed = label.trim();
    return trimmed === "" ? "?" : trimmed;
  }

  private observeMobileTabs(): void {
    const mobileTabs = this.mobileTabsElement();
    if (this.observedMobileTabs === mobileTabs) return;
    this.mobileTabsResizeObserver?.disconnect();
    this.observedMobileTabs = mobileTabs;
    this.mobileTabsResizeObserver = undefined;
    if (mobileTabs === undefined || typeof ResizeObserver === "undefined") return;
    this.mobileTabsResizeObserver = new ResizeObserver(() => {
      this.updateScrollState();
    });
    this.mobileTabsResizeObserver.observe(mobileTabs);
  }

  private updateScrollState(): void {
    const mobileTabs = this.mobileTabsElement();
    const maxScrollLeft = mobileTabs === undefined ? 0 : Math.max(0, mobileTabs.scrollWidth - mobileTabs.clientWidth);
    const canScrollLeft = mobileTabs !== undefined && mobileTabs.scrollLeft > 1;
    const canScrollRight = mobileTabs !== undefined && maxScrollLeft - mobileTabs.scrollLeft > 1;
    if (this.canScrollLeft !== canScrollLeft) this.canScrollLeft = canScrollLeft;
    if (this.canScrollRight !== canScrollRight) this.canScrollRight = canScrollRight;
  }

  private mobileTabsElement(): HTMLElement | undefined {
    const mobileTabs = this.mobileTabs;
    return mobileTabs instanceof HTMLElement ? mobileTabs : undefined;
  }

  private readonly onMobileTabsScroll = () => {
    this.updateScrollState();
  };

  static override styles = css`
    :host { flex: 0 0 auto; min-width: 0; }
    .mobile-tabs-frame { position: relative; display: flex; flex: 0 0 auto; min-width: 0; border-bottom: 1px solid var(--pi-border); background: var(--pi-bg); }
    .mobile-tabs-frame::before, .mobile-tabs-frame::after { content: ""; position: absolute; top: 0; bottom: 0; z-index: 2; width: 20px; opacity: 0; pointer-events: none; transition: opacity .15s ease; }
    .mobile-tabs-frame::before { left: 0; background: linear-gradient(90deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
    .mobile-tabs-frame::after { right: 0; background: linear-gradient(270deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
    .mobile-tabs-frame.can-scroll-left::before, .mobile-tabs-frame.can-scroll-right::after { opacity: 1; }
    .mobile-tabs { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 8px; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: thin; }
    .mobile-tabs button { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .mobile-tabs .navigation-tab { display: none; }
    .mobile-tabs button.selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .tab-icon { flex: 0 0 auto; width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
    .tab-custom-icon { flex: 0 0 auto; width: 18px; height: 18px; display: inline-grid; place-items: center; color: currentColor; pointer-events: none; }
    .tab-custom-icon svg { width: 18px; height: 18px; pointer-events: none; }
    .tab-fallback { display: none; font-weight: 650; letter-spacing: .01em; pointer-events: none; }
    .tab-label { min-width: 0; }
    .tab-badge { flex: 0 0 auto; display: inline-block; min-width: 14px; margin-left: 0; border: 1px solid var(--pi-success-border); border-radius: 999px; background: var(--pi-success-surface); color: var(--pi-success); padding: 0 5px; font-size: 11px; line-height: 16px; text-align: center; }
    .tab-badge.unread { border-color: var(--pi-accent-border); background: var(--pi-selection-bg); color: var(--pi-accent); }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
    @media (max-width: 760px) {
      .mobile-tabs { gap: 4px; padding: 6px 8px; }
      .mobile-tabs button { min-width: 44px; height: 44px; justify-content: center; gap: 4px; padding: 0 8px; }
      .mobile-tabs .navigation-tab { display: inline-flex; }
      .tab-fallback { display: inline-block; }
      .tab-label { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; }
      .tab-badge { min-width: 13px; padding: 0 4px; font-size: 10px; line-height: 13px; }
    }
  `;
}
