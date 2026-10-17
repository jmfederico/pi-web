import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { css, html, LitElement } from "lit";
import { customElement, query } from "lit/decorators.js";
import { uiButtonStyles } from "../ui/controlStyles";

/** Expands parent-owned actions to the left without changing transcript layout. */
@customElement("pi-message-actions-menu")
export class MessageActionsMenu extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @query("button") private trigger!: HTMLButtonElement;
  @query("[popover]") private panel!: HTMLDivElement;

  override disconnectedCallback() {
    this.removeViewportListeners();
    this.removeAttribute("open");
    if (this.hasUpdated) this.trigger.setAttribute("aria-expanded", "false");
    super.disconnectedCallback();
  }

  close() {
    if (!this.hasAttribute("open")) return;
    this.panel.hidePopover();
    this.trigger.focus();
  }

  private readonly positionPanel = () => {
    const margin = 8;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const trigger = this.trigger.getBoundingClientRect();
    this.panel.style.maxWidth = `${String(Math.max(0, trigger.left - margin))}px`;
    this.panel.style.maxHeight = `${String(Math.max(0, height - margin * 2))}px`;
    const panel = this.panel.getBoundingClientRect();
    this.panel.style.left = `${String(Math.max(margin, Math.min(trigger.left - panel.width, width - margin - panel.width)))}px`;
    this.panel.style.top = `${String(Math.max(margin, Math.min(trigger.bottom - panel.height, height - margin - panel.height)))}px`;
  };

  private addViewportListeners() {
    window.addEventListener("resize", this.positionPanel);
    window.addEventListener("scroll", this.positionPanel, true);
  }

  private removeViewportListeners() {
    window.removeEventListener("resize", this.positionPanel);
    window.removeEventListener("scroll", this.positionPanel, true);
  }

  private readonly handleToggle = (event: ToggleEvent) => {
    const open = event.newState === "open" && this.isConnected;
    this.toggleAttribute("open", open);
    this.trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      this.positionPanel();
      this.addViewportListeners();
    } else {
      this.removeViewportListeners();
    }
  };

  override render() {
    return html`
      <button type="button" class="ui-button ui-button--small ui-button--icon"
        aria-label="Message actions" aria-expanded="false" aria-controls="actions"
        popovertarget="actions"><span aria-hidden="true">⋯</span></button>
      <div id="actions" popover="auto" @toggle=${this.handleToggle}><slot></slot></div>
    `;
  }

  static override styles = [uiButtonStyles, css`
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
  `];
}
