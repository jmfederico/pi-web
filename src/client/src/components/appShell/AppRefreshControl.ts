import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("app-refresh-control")
export class AppRefreshControl extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

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
      <svg class="app-refresh-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M20 6v5h-5"></path>
        <path d="M4 18v-5h5"></path>
        <path d="M18.2 9A7 7 0 0 0 6.1 6.8L4 9"></path>
        <path d="M5.8 15a7 7 0 0 0 12.1 2.2L20 15"></path>
      </svg>
    `;
  }

  private readonly onReloadClick = (event: MouseEvent): void => {
    event.stopPropagation();
    this.onReload?.();
  };

  static override styles = css`
    :host { position: relative; z-index: 1; display: flex; align-items: stretch; min-height: 44px; pointer-events: auto; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
    :host, :host * { -webkit-user-select: none; user-select: none; }
    .app-refresh-button { box-sizing: border-box; width: 44px; min-height: 44px; height: 100%; align-self: stretch; display: grid; place-items: center; border: 0; border-radius: 0; background: transparent; color: var(--pi-text); padding: 0; line-height: 1; cursor: pointer; touch-action: manipulation; -webkit-touch-callout: none; }
    .app-refresh-button:hover { background: var(--pi-surface-hover); }
    .app-refresh-button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    .app-refresh-icon { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
  `;
}
