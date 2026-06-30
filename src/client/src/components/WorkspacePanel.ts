import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { Workspace } from "../api";
import type { QualifiedContributionId, QualifiedWorkspacePanelContribution, WorkspacePanelContext } from "../plugins/types";
import { workspacePanelStyles } from "./shared";

export interface WorkspacePanelEmptyState {
  title: string;
  body?: string;
}

type WorkspacePanelBadge = string | number | TemplateResult | undefined;

const visiblePanelTabLimit = 5;
const pinnedWorkspaceTabsStorageKey = "pi-web.workspacePanel.pinnedTabs";

@customElement("workspace-panel")
export class WorkspacePanel extends LitElement {
  @property({ attribute: false }) workspace: Workspace | undefined;
  @property({ attribute: false }) panelContext: WorkspacePanelContext | undefined;
  @property({ attribute: false }) emptyState: WorkspacePanelEmptyState | undefined;
  @property() tool: QualifiedContributionId = "core:workspace.files";
  @property({ attribute: false }) panels: QualifiedWorkspacePanelContribution[] = [];
  @property({ type: Boolean }) hideToolTabs = false;
  @property({ attribute: false }) onSelectTool: (tool: QualifiedContributionId) => void = () => undefined;
  @query(".workspace-header-strip") private workspaceHeaderStrip?: HTMLElement | null;
  @state() private workspaceHeaderCanScrollLeft = false;
  @state() private workspaceHeaderCanScrollRight = false;
  @state() private pinnedPanelIds: readonly QualifiedContributionId[] = loadPinnedPanelIds();

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
    if (workspace === undefined) return this.renderEmptyState(this.emptyState ?? {
      title: "Select a workspace",
      body: "Choose a workspace to inspect files, Git, or terminals.",
    });
    const context = this.panelContext;
    if (context === undefined) return this.renderEmptyState({
      title: "Workspace tools unavailable",
      body: "Try selecting the workspace again.",
    });
    const visiblePanels = this.panels;
    const selectedPanel = visiblePanels.find((panel) => panel.id === this.tool) ?? visiblePanels[0];
    const visibleTabPanels = this.visibleTabPanels(visiblePanels);
    const visibleTabPanelIds = new Set(visibleTabPanels.map((panel) => panel.id));
    const overflowPanels = visiblePanels.filter((panel) => !visibleTabPanelIds.has(panel.id));
    const selectedOverflowPanel = overflowPanels.some((panel) => panel.id === selectedPanel?.id) ? selectedPanel : undefined;
    return html`
      ${this.hideToolTabs ? null : html`
        <header>
          <div class=${this.workspaceHeaderFrameClass()}>
            <div class="workspace-header-strip" @scroll=${this.onWorkspaceHeaderScroll}>
              <nav class="tabs workspace-tabs" aria-label="Workspace tabs">
                ${visibleTabPanels.map((panel) => this.renderPanelTab(panel, context, selectedPanel?.id === panel.id))}
              </nav>
              ${overflowPanels.length === 0 ? null : html`
                <label class="overflow-tab-select">
                  <span>More workspace tabs</span>
                  <select aria-label="More workspace tabs" .value=${selectedOverflowPanel?.id ?? ""} @change=${this.onOverflowToolSelectChange}>
                    <option value="" disabled>${selectedOverflowPanel === undefined ? `More (${String(overflowPanels.length)})` : this.panelOptionLabel(selectedOverflowPanel, selectedOverflowPanel.badge?.(context))}</option>
                    ${overflowPanels.map((panel) => {
                      const badge = panel.badge?.(context);
                      return html`<option value=${panel.id}>${this.panelOptionLabel(panel, badge)}</option>`;
                    })}
                  </select>
                </label>
              `}
            </div>
          </div>
        </header>
      `}
      ${selectedPanel === undefined ? this.renderEmptyState({
        title: "No workspace tools available",
        body: "No tools are available for this workspace.",
      }) : html`
        <div class="panel-content">
          ${selectedPanel.render(context)}
        </div>
      `}
    `;
  }

  private onOverflowToolSelectChange = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLSelectElement)) return;
    const tool = qualifiedContributionId(target.value);
    if (tool === undefined) return;
    this.pinPanel(tool);
    this.onSelectTool(tool);
  };

  private renderPanelTab(panel: QualifiedWorkspacePanelContribution, context: WorkspacePanelContext, selected: boolean): TemplateResult {
    const badge = panel.badge?.(context);
    const ariaLabel = this.panelTabAriaLabel(panel, badge);
    return html`
      <button class=${this.panelTabClass(panel, selected)} title=${ariaLabel} aria-label=${ariaLabel} aria-pressed=${String(selected)} @click=${() => { this.onSelectTool(panel.id); }}>
        ${this.renderPanelTabContent(panel, badge)}
      </button>
    `;
  }

  private visibleTabPanels(panels: QualifiedWorkspacePanelContribution[]): QualifiedWorkspacePanelContribution[] {
    const byId = new Map(panels.map((panel) => [panel.id, panel]));
    const chosen: QualifiedWorkspacePanelContribution[] = [];
    const seen = new Set<QualifiedContributionId>();
    const add = (panel: QualifiedWorkspacePanelContribution | undefined): void => {
      if (panel === undefined || seen.has(panel.id) || chosen.length >= visiblePanelTabLimit) return;
      chosen.push(panel);
      seen.add(panel.id);
    };
    for (const id of this.pinnedPanelIds) add(byId.get(id));
    for (const panel of panels) add(panel);
    return chosen;
  }

  private pinPanel(panelId: QualifiedContributionId): void {
    const currentPinned = this.visibleTabPanels(this.panels).map((panel) => panel.id);
    if (currentPinned.includes(panelId)) return;
    const nextPinned = currentPinned.length < visiblePanelTabLimit
      ? [...currentPinned, panelId]
      : [...currentPinned.slice(0, visiblePanelTabLimit - 1), panelId];
    this.pinnedPanelIds = nextPinned;
    savePinnedPanelIds(nextPinned);
  }

  private panelTabClass(panel: QualifiedWorkspacePanelContribution, selected: boolean): string {
    return [
      ...(panel.icon === undefined ? [] : ["icon-tab"]),
      ...(selected ? ["selected"] : []),
    ].join(" ");
  }

  private panelTabAriaLabel(panel: QualifiedWorkspacePanelContribution, badge: WorkspacePanelBadge): string {
    if (typeof badge !== "string" && typeof badge !== "number") return panel.title;
    const trimmedBadge = String(badge).trim();
    return trimmedBadge === "" ? panel.title : `${panel.title}, ${trimmedBadge}`;
  }

  private renderPanelTabContent(panel: QualifiedWorkspacePanelContribution, badge: WorkspacePanelBadge): TemplateResult {
    return html`
      ${panel.icon === undefined ? null : html`<span class="tab-custom-icon" aria-hidden="true">${panel.icon}</span>`}
      <span class="tab-label">${panel.title}</span>
      ${this.isEmptyBadge(badge) ? null : html`<span class="tab-badge">${badge}</span>`}
    `;
  }

  private panelOptionLabel(panel: QualifiedWorkspacePanelContribution, badge: WorkspacePanelBadge): string {
    if (typeof badge !== "string" && typeof badge !== "number") return panel.title;
    const trimmedBadge = String(badge).trim();
    return trimmedBadge === "" ? panel.title : `${panel.title} (${trimmedBadge})`;
  }

  private isEmptyBadge(badge: WorkspacePanelBadge): boolean {
    return badge === undefined || badge === "";
  }

  private renderEmptyState(state: WorkspacePanelEmptyState): TemplateResult {
    return html`
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
    const canScrollLeft = strip !== undefined && strip.scrollLeft > 1;
    const canScrollRight = strip !== undefined && maxScrollLeft - strip.scrollLeft > 1;
    if (this.workspaceHeaderCanScrollLeft !== canScrollLeft) this.workspaceHeaderCanScrollLeft = canScrollLeft;
    if (this.workspaceHeaderCanScrollRight !== canScrollRight) this.workspaceHeaderCanScrollRight = canScrollRight;
  }

  private workspaceHeaderStripElement(): HTMLElement | undefined {
    const strip = this.workspaceHeaderStrip;
    return strip instanceof HTMLElement ? strip : undefined;
  }

  static override styles = workspacePanelStyles;
}

function qualifiedContributionId(value: string): QualifiedContributionId | undefined {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator >= value.length - 1) return undefined;
  const pluginId = value.slice(0, separator);
  const localId = value.slice(separator + 1);
  return `${pluginId}:${localId}`;
}

function loadPinnedPanelIds(): QualifiedContributionId[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(pinnedWorkspaceTabsStorageKey);
    if (raw === null) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => typeof item === "string" ? qualifiedContributionId(item) ?? [] : []);
  } catch {
    return [];
  }
}

function savePinnedPanelIds(panelIds: readonly QualifiedContributionId[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(pinnedWorkspaceTabsStorageKey, JSON.stringify(panelIds));
  } catch {
    // Ignore storage failures; tabs still update for this render cycle.
  }
}
