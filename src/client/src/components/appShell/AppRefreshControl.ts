import { renderHeroIcon } from "../heroicons";
import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("app-refresh-control")
export class AppRefreshControl extends LitElement {
  @property({ attribute: false }) onReload?: () => void;

  override render() {
    const label = "Full page reload";
    return html`
      <button
        class="app-refresh-button"
        title=${label}
        aria-label=${label}
        @click=${this.onReloadClick}
      >${this.renderRefreshIcon()}</button>
    `;
  }

  private renderRefreshIcon() {
    return html`
      ${renderHeroIcon("arrow-path", "app-refresh-icon")}
    `;
  }

  private readonly onReloadClick = (event: MouseEvent): void => {
    event.stopPropagation();
    this.onReload?.();
  };

  static override styles = css`
    :host { position: relative; z-index: 1; display: flex; align-items: center; pointer-events: auto; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
    :host, :host * { -webkit-user-select: none; user-select: none; }
    .app-refresh-button { box-sizing: border-box; width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-surface); color: var(--pi-text); padding: 0; line-height: 1; cursor: pointer; touch-action: manipulation; -webkit-touch-callout: none; }
    .app-refresh-icon { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
  `;
}
