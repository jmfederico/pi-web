import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { QualifiedContributionId, QualifiedWorkspacePanelContribution, WorkspacePanelContext } from "../../plugins/types";

const MORE_ICON = html`<svg class="more-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="19" cy="12" r="2"></circle></svg>`;

/**
 * Mobile-only second bar of pinned workspace tools. Each pinned tool is one tap
 * away; the trailing "more" button opens the tools sheet, where every tool is
 * reachable and pinning is managed. When nothing is pinned the host renders no
 * bar at all and shows the sheet's menu button in the context bar instead.
 */
@customElement("app-mobile-tool-bar")
export class AppMobileToolBar extends LitElement {
  @property({ attribute: false }) panels: QualifiedWorkspacePanelContribution[] = [];
  @property({ attribute: false }) panelContext?: WorkspacePanelContext;
  @property({ attribute: false }) selected?: QualifiedContributionId;
  @property({ attribute: false }) onSelect?: (id: QualifiedContributionId) => void;
  @property({ attribute: false }) onOpenMenu?: () => void;

  override render() {
    if (this.panels.length === 0) return nothing;
    return html`
      <nav class="tool-bar" aria-label="Workspace tools">
        <div class="strip">
          ${this.panels.map((panel) => this.renderTool(panel))}
        </div>
        <button type="button" class="more" title="More tools" aria-label="More tools" @click=${() => this.onOpenMenu?.()}>
          ${MORE_ICON}
        </button>
      </nav>
    `;
  }

  private renderTool(panel: QualifiedWorkspacePanelContribution): TemplateResult {
    const selected = this.selected === panel.id;
    const badge = this.panelContext === undefined ? undefined : panel.badge?.(this.panelContext);
    const badgeText = badgeLabel(badge);
    const ariaLabel = badgeText === undefined ? panel.title : `${panel.title}, ${badgeText}`;
    return html`
      <button type="button" class=${`tool${selected ? " selected" : ""}`} title=${panel.title} aria-label=${ariaLabel} aria-pressed=${String(selected)} @click=${() => this.onSelect?.(panel.id)}>
        ${panel.icon === undefined ? null : html`<span class="tool-icon" aria-hidden="true">${panel.icon}</span>`}
        <span class="tool-label">${panel.title}</span>
        ${badge === undefined || badge === "" ? null : html`<span class="tool-badge">${badge}</span>`}
      </button>
    `;
  }

  static override styles = css`
    :host { display: block; flex: 0 0 auto; }
    .tool-bar { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 6px 8px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); }
    .strip { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: none; }
    .strip::-webkit-scrollbar { display: none; }
    .tool { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--pi-muted); font: inherit; font-size: 13px; font-weight: 500; padding: 7px 11px; cursor: pointer; white-space: nowrap; }
    .tool:hover { background: var(--pi-surface-hover); color: var(--pi-text); }
    .tool:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .tool.selected { background: var(--pi-selection-bg); color: var(--pi-accent); }
    .tool-icon { flex: 0 0 auto; width: 17px; height: 17px; display: inline-grid; place-items: center; color: currentColor; pointer-events: none; }
    .tool-icon svg { width: 17px; height: 17px; pointer-events: none; }
    .tool-label { min-width: 0; }
    .tool-badge { flex: 0 0 auto; display: inline-block; min-width: 16px; border-radius: 999px; background: var(--pi-success-surface); color: var(--pi-success); border: 1px solid var(--pi-success-border); padding: 0 5px; font-size: 11px; line-height: 15px; text-align: center; }
    .more { flex: 0 0 auto; box-sizing: border-box; width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-surface); color: var(--pi-muted); padding: 0; cursor: pointer; }
    .more:hover, .more:focus-visible { border-color: var(--pi-accent); color: var(--pi-text); }
    .more-icon { width: 18px; height: 18px; fill: currentColor; pointer-events: none; }
  `;
}

function badgeLabel(badge: string | number | TemplateResult | undefined): string | undefined {
  if (typeof badge !== "string" && typeof badge !== "number") return undefined;
  const text = String(badge).trim();
  return text === "" ? undefined : text;
}
