import { LocalizationController } from "../../localization/browser";
import { chatTranscriptMessages as messages } from "../../chatTranscriptMessages";
import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { css, html, LitElement } from "lit";
import { AnchoredPopupController } from "../anchoredPopup";
import { customElement, query, state } from "lit/decorators.js";
import { uiButtonStyles } from "../ui/controlStyles";

/** Expands parent-owned actions toward inline-start without changing transcript layout. */
@customElement("pi-message-actions-menu")
export class MessageActionsMenu extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @query("button") private trigger!: HTMLButtonElement;
  @query("[popover]") private panel!: HTMLDivElement;

  @state() private expanded = false;
  readonly popup = new AnchoredPopupController(this, () => this.expanded ? {
    anchor: this.trigger, panel: this.panel,
    onClose: () => { this.expanded = false; this.removeAttribute("open"); },
    options: { placement: "inline-start-end", padding: 8 },
  } : undefined);

  override disconnectedCallback() {
    this.expanded = false;
    this.removeAttribute("open");
    if (this.hasUpdated) this.trigger.setAttribute("aria-expanded", "false");
    super.disconnectedCallback();
  }

  close() {
    if (!this.expanded) return;
    this.popup.close();
    this.trigger.focus();
  }

  private toggle() {
    this.expanded = !this.expanded;
    this.toggleAttribute("open", this.expanded);
  }

  override render() {
    return html`
      <button type="button" class="ui-button ui-button--small ui-button--icon ui-popup-trigger"
        aria-label=${messages.t("actions")} aria-expanded=${String(this.expanded)} aria-controls="actions"
        @click=${() => { this.toggle(); }}><span aria-hidden="true">⋯</span></button>
      <div id="actions" class="ui-popup-panel" data-ui-context="message-actions" popover="auto"><slot></slot></div>
    `;
  }

  static override styles = [uiButtonStyles, css`
    @layer pi-web-base {
    :host { display: inline-flex; }
    .ui-button:hover:not(:disabled) { background: color-mix(in srgb, var(--pi-text) 8%, transparent); }
    [popover] {
      position: fixed;
      inset: auto;
      margin: 0;
      width: max-content;
      border: 0;
      padding: 0;
      background: transparent;
      overflow: auto;
      opacity: 1;
      transform: translateX(0);
      transition: opacity .14s ease, transform .14s ease;
    }
    @starting-style {
      [popover]:popover-open { opacity: 0; transform: translateX(12px); }
    }
    @media (prefers-reduced-motion: reduce) {
      [popover] { transition: none; }
    }
    }
  `];
}
