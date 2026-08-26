import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { QualifiedContributionId, QualifiedWorkspacePanelContribution, WorkspacePanelContext } from "../../plugins/types";
import "../ModalSurface";

const PIN_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6Z"></path><path d="M12 15v5"></path></svg>`;
const PIN_ICON_FILLED = html`<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6Z"></path><path d="M12 15v5" stroke-linecap="round"></path></svg>`;

/**
 * Bottom sheet that lists every workspace tool for the current workspace and is
 * the mobile navigation menu. Tapping a row opens that tool; the pin toggle on
 * each row adds or removes it from the one-tap tool bar. Pinned tools are
 * grouped first so the bar's contents are obvious at a glance.
 */
@customElement("app-tools-sheet")
export class AppToolsSheet extends LitElement {
  @property({ attribute: false }) panels: QualifiedWorkspacePanelContribution[] = [];
  @property({ attribute: false }) pinnedIds: QualifiedContributionId[] = [];
  @property({ attribute: false }) panelContext?: WorkspacePanelContext;
  @property({ attribute: false }) selected?: QualifiedContributionId;
  @property({ attribute: false }) onSelect?: (id: QualifiedContributionId) => void;
  @property({ attribute: false }) onTogglePin?: (id: QualifiedContributionId) => void;
  @property({ attribute: false }) onClose?: () => void;

  override render() {
    const pinnedSet = new Set(this.pinnedIds);
    const pinned = this.pinnedIds
      .map((id) => this.panels.find((panel) => panel.id === id))
      .filter((panel): panel is QualifiedWorkspacePanelContribution => panel !== undefined);
    const rest = this.panels.filter((panel) => !pinnedSet.has(panel.id));
    return html`
      <modal-surface .onClose=${() => this.onClose?.()} .label=${"Go to"}>
        <header>
          <div class="titles">
            <h2>Go to</h2>
            <p>Tap to open · pin to keep it one tap away</p>
          </div>
          <button type="button" class="close" title="Close" aria-label="Close" @click=${() => this.onClose?.()}>×</button>
        </header>
        <div class="list">
          ${pinned.length === 0 ? nothing : html`
            <p class="group">Pinned · one tap</p>
            ${pinned.map((panel) => this.renderRow(panel, true))}
          `}
          ${rest.length === 0 ? nothing : html`
            <p class="group">${pinned.length === 0 ? "Tools" : "More tools"}</p>
            ${rest.map((panel) => this.renderRow(panel, false))}
          `}
        </div>
      </modal-surface>
    `;
  }

  private renderRow(panel: QualifiedWorkspacePanelContribution, pinned: boolean): TemplateResult {
    const isSelected = this.selected === panel.id;
    const badge = this.panelContext === undefined ? undefined : panel.badge?.(this.panelContext);
    return html`
      <div class=${`row${isSelected ? " current" : ""}`}>
        <button type="button" class="open" @click=${() => this.onSelect?.(panel.id)}>
          <span class="row-icon" aria-hidden="true">${panel.icon ?? nothing}</span>
          <span class="row-title">${panel.title}</span>
          ${badge === undefined || badge === "" ? null : html`<span class="row-badge">${badge}</span>`}
          ${isSelected ? html`<span class="row-open">Open</span>` : null}
        </button>
        <button
          type="button"
          class=${`pin${pinned ? " pinned" : ""}`}
          aria-pressed=${String(pinned)}
          title=${pinned ? "Unpin from tool bar" : "Pin to tool bar"}
          aria-label=${pinned ? `Unpin ${panel.title}` : `Pin ${panel.title}`}
          @click=${() => this.onTogglePin?.(panel.id)}
        >${pinned ? PIN_ICON_FILLED : PIN_ICON}</button>
      </div>
    `;
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 21; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    modal-surface {
      --modal-surface-place-items: end center;
      --modal-surface-backdrop-padding: 0;
      --modal-surface-width: 100%;
      --modal-surface-max-width: 640px;
      --modal-surface-max-height: min(80dvh, 640px);
      --modal-surface-radius: 18px 18px 0 0;
      --modal-surface-border: 1px solid var(--pi-border);
    }
    header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 8px; padding: 16px 16px 12px; border-bottom: 1px solid var(--pi-border-muted); }
    .titles { min-width: 0; }
    h2 { margin: 0; font-size: 17px; font-weight: 700; }
    header p { margin: 3px 0 0; font-size: 12.5px; color: var(--pi-dim); }
    .close { border: 0; background: transparent; color: var(--pi-muted); font-size: 24px; line-height: 1; padding: 0 6px; cursor: pointer; }
    .close:hover { color: var(--pi-text); }
    .list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 6px 10px calc(12px + env(safe-area-inset-bottom, 0)); }
    .group { margin: 12px 8px 4px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--pi-dim); }
    .row { display: flex; align-items: center; gap: 4px; }
    .open { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 13px; border: 0; background: transparent; color: var(--pi-text); font: inherit; font-size: 15px; text-align: left; padding: 11px 8px; border-radius: 10px; cursor: pointer; }
    .open:hover { background: var(--pi-surface-hover); }
    .row-icon { flex: 0 0 auto; width: 34px; height: 34px; display: grid; place-items: center; border-radius: 9px; background: var(--pi-surface); color: var(--pi-muted); }
    .row.current .row-icon { background: var(--pi-selection-bg); color: var(--pi-accent); }
    .row-icon svg { width: 18px; height: 18px; }
    .row-title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .row-badge { flex: 0 0 auto; min-width: 16px; border-radius: 999px; background: var(--pi-success-surface); color: var(--pi-success); border: 1px solid var(--pi-success-border); padding: 0 5px; font-size: 11px; line-height: 15px; text-align: center; }
    .row-open { margin-left: auto; flex: 0 0 auto; font-size: 11px; font-weight: 600; color: var(--pi-accent); }
    .pin { flex: 0 0 auto; width: 40px; height: 40px; display: grid; place-items: center; border: 1px solid transparent; border-radius: 10px; background: transparent; color: var(--pi-dim); cursor: pointer; }
    .pin:hover { background: var(--pi-surface-hover); color: var(--pi-text); }
    .pin:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .pin.pinned { color: var(--pi-accent); }
    .pin svg { width: 19px; height: 19px; }
  `;
}
