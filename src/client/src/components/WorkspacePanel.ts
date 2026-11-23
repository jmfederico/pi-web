import { LocalizationController, localization } from "../localization/browser";
import { horizontalScrollEdges } from "./appShell/scrollEdges";
import { appShellMessages as m } from "../appShellMessages";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { Workspace } from "../api";
import type { QualifiedContributionId } from "../plugins/types";
import { renderNavigationMenuIcon } from "./tabIcons";
import { workspacePanelStyles } from "./shared";
import { orderedNavigationTabs, pinnedNavigationTabs } from "../navigationPreferences";
import { renderPanelToggleButton } from "./appShell/panelToggleButton";

export interface WorkspacePanelEmptyState {
  title: string;
  body?: string;
}

type WorkspacePanelBadge = string | number | TemplateResult | undefined;

/** Host-bound display callbacks keep application and workspace contracts separate. */
export interface WorkspaceToolPanel {
  id: QualifiedContributionId;
  title: string;
  icon?: TemplateResult;
  order?: number;
  badge?: () => WorkspacePanelBadge;
  render: () => TemplateResult;
}

@customElement("workspace-panel")
export class WorkspacePanel extends LitElement {
  constructor() {
    super();
    new LocalizationController(this);
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) workspace: Workspace | undefined;
  @property({ attribute: false }) emptyState: WorkspacePanelEmptyState | undefined;
  @property() error = "";
  @property() tool: QualifiedContributionId | undefined;
  @property({ attribute: false }) panels: WorkspaceToolPanel[] = [];
  @property({ type: Boolean }) hideToolTabs = false;
  @property({ attribute: false }) pinnedIds: string[] = [];
  @property({ attribute: false }) orderedIds: string[] = [];
  @property({ attribute: false }) onShowNavigation?: () => void;
  @property({ attribute: false }) onTogglePanel?: () => void;
  @property({ attribute: false }) onSelectTool: (tool: QualifiedContributionId) => void = () => undefined;
  @query(".workspace-header-strip") private workspaceHeaderStrip?: HTMLElement | null;
  @state() private workspaceHeaderCanScrollLeft = false;
  @state() private workspaceHeaderCanScrollRight = false;

  private observedWorkspaceHeaderStrip: HTMLElement | undefined;
  private workspaceHeaderResizeObserver: ResizeObserver | undefined;
  private readonly onWorkspaceHeaderScroll = () => {
    this.updateWorkspaceHeaderScrollState();
  };

  override firstUpdated(): void {
    this.observeWorkspaceHeaderStrip();
    this.updateWorkspaceHeaderScrollState();
  }

  override updated(): void {
    this.observeWorkspaceHeaderStrip();
    this.updateWorkspaceHeaderScrollState();
  }

  override disconnectedCallback(): void {
    this.workspaceHeaderResizeObserver?.disconnect();
    this.workspaceHeaderResizeObserver = undefined;
    this.observedWorkspaceHeaderStrip = undefined;
    super.disconnectedCallback();
  }

  override render() {
    const workspace = this.workspace;
    if (workspace === undefined && this.panels.length === 0) return this.renderEmptyState(this.error !== "" ? { title: this.error } : this.emptyState ?? {
      title: m.t("selectWorkspace"),
      body: m.t("chooseWorkspace"),
    }, true);
    const visiblePanels = this.panels;
    // An unresolved route may leave a valid remembered tool, but its content is not displayed.
    const selectedPanel = this.error !== "" ? undefined
      : this.tool === undefined ? visiblePanels[0] : visiblePanels.find((panel) => panel.id === this.tool);
    const pinnedPanels = pinnedNavigationTabs(orderedNavigationTabs(visiblePanels, this.orderedIds), this.pinnedIds);
    return html`
      ${this.hideToolTabs ? null : html`
        <header>
          <div class=${this.workspaceHeaderFrameClass()}>
            <div class="workspace-header-strip" @scroll=${this.onWorkspaceHeaderScroll}>
              <div class="tabs ui-tabs ui-tabs--primary">
                ${repeat(pinnedPanels, (panel) => panel.id, (panel) => {
                  const selected = selectedPanel?.id === panel.id;
                  const badge = panel.badge?.();
                  const ariaLabel = this.panelTabAriaLabel(panel, badge);
                  return html`
                    <button class=${this.panelTabClass(panel, selected)} title=${ariaLabel} aria-label=${ariaLabel} aria-pressed=${String(selected)} @click=${() => { this.onSelectTool(panel.id); }}>
                      ${this.renderPanelTabContent(panel, badge)}
                    </button>
                  `;
                })}
              </div>
              ${this.renderNavigationButton(selectedPanel !== undefined && !pinnedPanels.some((panel) => panel.id === selectedPanel.id))}
            </div>
          </div>
          ${renderPanelToggleButton("workspace", false, this.onTogglePanel)}
        </header>
      `}
      ${this.error !== "" ? this.renderEmptyState({ title: this.error }) : selectedPanel === undefined ? this.renderEmptyState({
        title: this.tool === undefined ? m.t("noTools") : m.t("unavailablePanel", { id: this.tool }),
      }) : html`
        <div class="panel-content">
          ${selectedPanel.render()}
        </div>
      `}
    `;
  }

  private panelTabClass(panel: WorkspaceToolPanel, selected: boolean): string {
    return [
      "ui-button", "ui-tab",
      ...(panel.icon === undefined ? [] : ["icon-tab"]),
      ...(selected ? ["selected"] : []),
    ].join(" ");
  }

  private panelTabAriaLabel(panel: WorkspaceToolPanel, badge: WorkspacePanelBadge): string {
    if (typeof badge !== "string" && typeof badge !== "number") return panel.title;
    const trimmedBadge = (typeof badge === "number" ? localization.number(badge) : badge).trim();
    return trimmedBadge === "" ? panel.title : m.t("badge", { label: panel.title, badge: trimmedBadge });
  }

  private renderPanelTabContent(panel: WorkspaceToolPanel, badge: WorkspacePanelBadge): TemplateResult {
    return html`
      ${panel.icon === undefined ? null : html`<span class="tab-custom-icon" aria-hidden="true">${panel.icon}</span>`}
      <span class="tab-label">${panel.title}</span>
      ${this.isEmptyBadge(badge) ? null : html`<span class="tab-badge">${typeof badge === "number" ? localization.number(badge) : badge}</span>`}
    `;
  }

  private isEmptyBadge(badge: WorkspacePanelBadge): boolean {
    return badge === undefined || badge === "";
  }

  private renderNavigationButton(hiddenActiveDestination = false) {
    return this.onShowNavigation === undefined ? null : html`<button type="button" class=${`ui-button ui-button--icon navigation-menu-button${hiddenActiveDestination ? " selected" : ""}`} data-navigation-trigger title=${m.t("navigation")} aria-label=${m.t("navigation")} aria-haspopup="dialog" @click=${this.onShowNavigation}>${renderNavigationMenuIcon()}</button>`;
  }

  private renderEmptyState(state: WorkspacePanelEmptyState, showNavigation = false): TemplateResult {
    return html`
      ${showNavigation && !this.hideToolTabs ? html`<header>${this.renderNavigationButton()}${renderPanelToggleButton("workspace", false, this.onTogglePanel)}</header>` : null}
      <section class="empty-state" role="status">
        <h2>${state.title}</h2>
        ${state.body === undefined ? null : html`<p>${state.body}</p>`}
      </section>
    `;
  }

  private workspaceHeaderFrameClass(): string {
    return `workspace-header-scroll-frame${this.workspaceHeaderCanScrollLeft ? " can-scroll-left" : ""}${this.workspaceHeaderCanScrollRight ? " can-scroll-right" : ""}`;
  }

  private observeWorkspaceHeaderStrip(): void {
    const strip = this.workspaceHeaderStripElement();
    if (this.observedWorkspaceHeaderStrip === strip) return;
    this.workspaceHeaderResizeObserver?.disconnect();
    this.observedWorkspaceHeaderStrip = strip;
    this.workspaceHeaderResizeObserver = undefined;
    if (strip === undefined || typeof ResizeObserver === "undefined") return;
    this.workspaceHeaderResizeObserver = new ResizeObserver(() => {
      this.updateWorkspaceHeaderScrollState();
    });
    this.workspaceHeaderResizeObserver.observe(strip);
  }

  private updateWorkspaceHeaderScrollState(): void {
    const strip = this.workspaceHeaderStripElement();
    const maxScrollLeft = strip === undefined ? 0 : Math.max(0, strip.scrollWidth - strip.clientWidth);
    const edges = horizontalScrollEdges(strip?.scrollLeft ?? 0, maxScrollLeft, localization.direction);
    const canScrollLeft = strip !== undefined && edges.left;
    const canScrollRight = strip !== undefined && edges.right;
    if (this.workspaceHeaderCanScrollLeft !== canScrollLeft) this.workspaceHeaderCanScrollLeft = canScrollLeft;
    if (this.workspaceHeaderCanScrollRight !== canScrollRight) this.workspaceHeaderCanScrollRight = canScrollRight;
  }

  private workspaceHeaderStripElement(): HTMLElement | undefined {
    const strip = this.workspaceHeaderStrip;
    return strip instanceof HTMLElement ? strip : undefined;
  }

  static override styles = workspacePanelStyles;
}
