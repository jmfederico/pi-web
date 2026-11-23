import { css, html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LocalizationController, localization } from "../../localization/browser";
import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { uiButtonStyles } from "../ui/controlStyles";
import { uiNoticeStyles } from "../ui/noticeStyles";
import source from "./settingsRestart.messages";

const messages = localization.registerMessages("core.settingsRestart", source);

/** Presentation only: SettingsDialog owns the captured target and launch state. */
@customElement("settings-restart-action")
export class SettingsRestartAction extends LitElement {
  constructor() {
    super();
    new LocalizationController(this);
    stylesheetIntegrationCapability.createController(this);
  }

  @property() targetLabel = "";
  @property() services: "web" | "sessiond" = "sessiond";
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) pending = false;
  @property() error = "";
  @property({ attribute: false }) onRestart?: () => Promise<void>;

  override render(): TemplateResult {
    return html`
      <div class="ui-notice warning">
        <p id="restart-warning">${messages.t(this.services === "web" ? "webWarning" : "sessiondWarning", { target: this.targetLabel })}</p>
        <button type="button" class="ui-button ui-button--action danger" aria-describedby="restart-warning"
          ?disabled=${this.disabled || this.pending} @click=${() => { void this.onRestart?.(); }}
        >${messages.t(this.pending ? "starting" : this.services)}</button>
      </div>
      ${this.error === "" ? null : html`<p class="ui-notice error" role="alert">${messages.t("failure", { error: this.error })}</p>`}
    `;
  }

  static override styles = [uiButtonStyles, uiNoticeStyles, css`
    :host { display: block; overflow-wrap: anywhere; }
    p { margin: 0; }
    button { margin-block-start: 8px; }
    .error { margin-block-start: 8px; }
  `];
}
