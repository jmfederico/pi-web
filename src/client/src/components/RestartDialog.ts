import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { RestartResult, RestartServices } from "../../../plugin-api";
import { restartCommand, type RestartCommands, type RestartConfirmation } from "../controllers/restartController";
import { LocalizationController } from "../localization/browser";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { restartMessages as m } from "../restartMessages";
import { uiDialogStyles, uiFormStyles } from "./ui/dialogStyles";
import { uiNoticeStyles } from "./ui/noticeStyles";
import "./ModalSurface";

/** Confirmation only. The existing maintenance terminal owns command execution and output. */
@customElement("restart-dialog")
export class RestartDialog extends LitElement {
  @property({ attribute: false }) activityForMachine: (machineId: string) => "active" | "idle" | "unknown" = () => "unknown";
  @state() private request: RestartConfirmation | undefined;
  @state() private target: RestartServices = "web";
  @state() private commands: RestartCommands = {};
  private resolveRequest: ((result: RestartResult) => void) | undefined;
  private rejectRequest: ((error: unknown) => void) | undefined;
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
    // Removing the UI cannot cancel a terminal launch already in progress.
    if (!this.submitting) this.finish("cancelled");
    super.disconnectedCallback();
  }

  show(request: RestartConfirmation): Promise<RestartResult> {
    if (this.submitting) return Promise.reject(new Error(m.t("pending")));
    this.finish("cancelled");
    this.request = request;
    this.target = request.services;
    const result = new Promise<RestartResult>((resolve, reject) => {
      this.resolveRequest = resolve;
      this.rejectRequest = reject;
    });
    void this.load();
    return result;
  }

  private finish(result: RestartResult): void {
    this.resolveRequest?.(result);
    this.clearRequest();
  }

  private clearRequest(): void {
    this.loadSequence += 1;
    this.request = undefined;
    this.resolveRequest = undefined;
    this.rejectRequest = undefined;
  }

  private async load(): Promise<void> {
    const request = this.request;
    if (request === undefined) return;
    const sequence = ++this.loadSequence;
    this.loading = true;
    this.commands = {};
    this.error = "";
    try {
      const commands = await request.loadCommands();
      if (sequence === this.loadSequence) this.commands = commands;
    } catch (error) {
      if (sequence === this.loadSequence) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (sequence === this.loadSequence) this.loading = false;
    }
  }

  private close(): void {
    if (this.submitting) return;
    this.finish("cancelled");
  }

  private async confirm(): Promise<void> {
    const request = this.request;
    if (this.loading || this.submitting || restartCommand(this.commands, this.target) === undefined || request === undefined) return;
    this.submitting = true;
    this.error = "";
    try {
      await request.run(this.target, this.commands);
      this.finish("launched");
    } catch (error) {
      if (!this.isConnected) {
        this.rejectRequest?.(error);
        this.clearRequest();
      } else {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.submitting = false;
    }
  }

  override render() {
    const request = this.request;
    if (request === undefined) return nothing;
    const activity = this.activityForMachine(request.machine.id);
    const command = restartCommand(this.commands, this.target);
    return html`
      <modal-surface .label=${m.t("title")} .initialFocus=${"#restart-close"} .onClose=${() => { this.close(); }}>
        <header class="ui-dialog-header"><strong class="ui-dialog-title">${m.t("title")}</strong></header>
        <div class="ui-dialog-body ui-form-body">
          <p>${m.t("scope", { machine: request.machine.name })}</p>
          <fieldset ?disabled=${this.loading || this.submitting} aria-describedby="restart-effect">
            <legend>${m.t("services")}</legend>
            ${(["web", "sessiond", "both"] as const).map((target) => html`
              <label class="ui-checkbox-field"><input type="radio" name="restart-target" value=${target}
                .checked=${this.target === target} ?disabled=${restartCommand(this.commands, target) === undefined}
                @change=${() => { this.target = target; }}>${m.t(target)}</label>`)}
          </fieldset>
          <p id="restart-effect">${m.t(this.target === "web" ? "webEffect" : this.target === "sessiond" ? "daemonEffect" : "bothEffect")}</p>
          ${this.target !== "web" && activity !== "idle" ? html`<p id="restart-activity" class="ui-notice ui-notice--warning">${m.t(activity === "active" ? "active" : "unknownActivity")}</p>` : nothing}
          ${this.loading ? html`<p role="status">${m.t("loading")}</p>` : command === undefined ? html`<p>${m.t("unavailable")}</p>` : html`<code>${command}</code><p>${m.t("terminalHint")}</p>`}
          ${this.error === "" ? nothing : html`<p role="alert" class="ui-notice ui-notice--error">${this.error}</p>`}
        </div>
        <footer class="ui-dialog-footer">
          <button id="restart-close" class="ui-button" ?disabled=${this.submitting} @click=${() => { this.close(); }}>${m.t("cancel")}</button>
          ${this.error !== "" && !this.submitting ? html`<button class="ui-button" @click=${() => { void this.load(); }}>${m.t("retryAvailability")}</button>` : nothing}
          <button id="restart-confirm" class="ui-button ui-button--primary" ?disabled=${this.loading || this.submitting || command === undefined} @click=${() => { void this.confirm(); }}>${m.t(this.submitting ? "opening" : "confirm")}</button>
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
