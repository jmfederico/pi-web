import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { piWebApi, type PiWebStatusResponse } from "../api";
import { LocalizationController } from "../localization/browser";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { restartMessages as m } from "../restartMessages";
import { uiDialogStyles, uiFormStyles } from "./ui/dialogStyles";
import { uiNoticeStyles } from "./ui/noticeStyles";
import "./ModalSurface";

type RestartTarget = "web" | "sessiond" | "both";
const commandKeys = { web: "restartWeb", sessiond: "restartSessiond", both: "restart" } as const;

/** Confirmation only. The existing maintenance terminal owns command execution and output. */
@customElement("restart-dialog")
export class RestartDialog extends LitElement {
  @property({ attribute: false }) loadCommands: () => Promise<PiWebStatusResponse["commands"]> = async () => (await piWebApi.piWebStatus("local")).commands;
  @property({ attribute: false }) onRun?: (command: string, title: string) => Promise<void>;
  @property() activity: "active" | "idle" | "unknown" = "unknown";
  @state() private visible = false;
  @state() private target: RestartTarget = "web";
  @state() private commands: PiWebStatusResponse["commands"] = {};
  @state() private loading = false;
  @state() private submitting = false;
  @state() private error = "";
  private loadSequence = 0;

  constructor() {
    super();
    new LocalizationController(this);
    stylesheetIntegrationCapability.createController(this);
  }

  override disconnectedCallback(): void {
    this.loadSequence += 1;
    super.disconnectedCallback();
  }

  show(): void {
    if (this.submitting) return;
    this.visible = true;
    this.target = "web";
    void this.load();
  }

  private async load(): Promise<void> {
    const sequence = ++this.loadSequence;
    this.loading = true;
    this.commands = {};
    this.error = "";
    try {
      const commands = await this.loadCommands();
      if (sequence === this.loadSequence) this.commands = commands;
    } catch (error) {
      if (sequence === this.loadSequence) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (sequence === this.loadSequence) this.loading = false;
    }
  }

  private close(): void {
    if (this.submitting) return;
    this.loadSequence += 1;
    this.visible = false;
  }

  private async confirm(): Promise<void> {
    const command = this.commands[commandKeys[this.target]];
    if (this.loading || this.submitting || command === undefined || this.onRun === undefined) return;
    this.submitting = true;
    this.error = "";
    try {
      await this.onRun(command, m.t(this.target));
      this.visible = false;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.submitting = false;
    }
  }

  override render() {
    if (!this.visible) return nothing;
    const command = this.commands[commandKeys[this.target]];
    return html`
      <modal-surface .label=${m.t("title")} .initialFocus=${"#restart-close"} .onClose=${() => { this.close(); }}>
        <header class="ui-dialog-header"><strong class="ui-dialog-title">${m.t("title")}</strong></header>
        <div class="ui-dialog-body ui-form-body">
          <p>${m.t("scope")}</p>
          <fieldset ?disabled=${this.loading || this.submitting} aria-describedby="restart-effect">
            <legend>${m.t("services")}</legend>
            ${(["web", "sessiond", "both"] as const).map((target) => html`
              <label class="ui-checkbox-field"><input type="radio" name="restart-target" value=${target}
                .checked=${this.target === target} ?disabled=${this.commands[commandKeys[target]] === undefined}
                @change=${() => { this.target = target; }}>${m.t(target)}</label>`)}
          </fieldset>
          <p id="restart-effect">${m.t(this.target === "web" ? "webEffect" : this.target === "sessiond" ? "daemonEffect" : "bothEffect")}</p>
          ${this.target !== "web" && this.activity !== "idle" ? html`<p id="restart-activity" class="ui-notice ui-notice--warning">${m.t(this.activity === "active" ? "active" : "unknownActivity")}</p>` : nothing}
          ${this.loading ? html`<p role="status">${m.t("loading")}</p>` : command === undefined ? html`<p>${m.t("unavailable")}</p>` : html`<code>${command}</code><p>${m.t("terminalHint")}</p>`}
          ${this.error === "" ? nothing : html`<p role="alert" class="ui-notice ui-notice--error">${this.error}</p>`}
        </div>
        <footer class="ui-dialog-footer">
          <button id="restart-close" class="ui-button" ?disabled=${this.submitting} @click=${() => { this.close(); }}>${m.t("cancel")}</button>
          ${this.error !== "" && !this.submitting ? html`<button class="ui-button" @click=${() => { void this.load(); }}>${m.t("retryAvailability")}</button>` : nothing}
          <button id="restart-confirm" class="ui-button ui-button--primary" ?disabled=${this.loading || this.submitting || command === undefined || this.onRun === undefined} @click=${() => { void this.confirm(); }}>${m.t(this.submitting ? "opening" : "confirm")}</button>
        </footer>
      </modal-surface>`;
  }

  static override styles = [uiDialogStyles, uiFormStyles, uiNoticeStyles, css`
    :host { display: contents; --ui-dialog-width: 560px; }
    p { margin: 0; }
    fieldset { margin: 0; padding: 0; border: 0; display: flex; flex-direction: column; gap: 12px; }
    legend { margin-block-end: 8px; }
    code { overflow-wrap: anywhere; white-space: pre-wrap; }
  `];
}
