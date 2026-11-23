import { LocalizationController } from "../../localization/browser";
import { appShellMessages as m } from "../../appShellMessages";
import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { uiButtonStyles } from "../ui/controlStyles";

/** Explains the strip kept clear for the iPad Shortcuts bar and lets the user free it. */
@customElement("shortcuts-bar-reserve")
export class ShortcutsBarReserve extends LitElement {
  constructor() {
    super();
    new LocalizationController(this);
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) onRemove?: () => void;

  override render() {
    return html`
      <span>${m.t("shortcutsBarReserved")}</span>
      <button type="button" class="ui-button ui-button--compact" aria-label=${m.t("removeShortcutsBarReserveLabel")} @click=${this.onRemoveClick}>${m.t("removeShortcutsBarReserve")}</button>
    `;
  }

  private readonly onRemoveClick = (): void => {
    this.onRemove?.();
  };

  static override styles = [uiButtonStyles, css`
    :host { box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: 10px; padding: 0 12px; color: var(--pi-muted); font: 12px var(--pi-font, system-ui, sans-serif); }
    span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `];
}
