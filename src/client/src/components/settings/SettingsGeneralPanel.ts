import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER, DEFAULT_WORKSPACE_UPLOADS_FOLDER, type PiWebConfigEnvOverrides, type PiWebConfigResponse, type PiWebConfigValues } from "../../api";
import { uiButtonStyles } from "../ui/controlStyles";
import { uiFormStyles } from "../ui/formStyles";
import { uiSettingsStyles } from "../ui/settingsStyles";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";
import {
  emptyGatewayServerConfigDraft,
  emptyMachineAccessConfigDraft,
  gatewayServerConfigFromDraft,
  gatewayServerDraftFromConfig,
  machineAccessConfigPatchFromDraft,
  machineAccessDraftFromConfig,
  reconcileConfigDraft,
  type GatewayServerConfigDraft,
  type MachineAccessConfigDraft,
} from "./settingsConfigDraft";

function generalDescription(targetLabel: string): TemplateResult {
  return html`Gateway settings apply to this server. File access and uploads apply to ${targetLabel}.`;
}

@customElement("settings-general-panel")
export class SettingsGeneralPanel extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) configResponse: PiWebConfigResponse | undefined;
  @property({ attribute: false }) machineConfigResponse: PiWebConfigResponse | undefined;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) machineLoading = false;
  @property({ type: Boolean }) saving = false;
  @property() error = "";
  @property() machineError = "";
  @property() savedMessage = "";
  @property() targetLabel = "selected machine";
  @property() targetId = "local";
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onReloadMachine?: () => void | Promise<void>;
  @property({ attribute: false }) onSave?: (config: PiWebConfigValues) => void | Promise<void>;
  @property({ attribute: false }) onSaveMachineConfig?: (config: PiWebConfigValues) => void | Promise<void>;
  @state() private gatewayDraft: GatewayServerConfigDraft = emptyGatewayServerConfigDraft();
  @state() private machineDraft: MachineAccessConfigDraft = emptyMachineAccessConfigDraft();
  @state() private gatewayLocalError = "";
  @state() private machineLocalError = "";

  private gatewayBaseline = emptyGatewayServerConfigDraft();
  private machineBaseline = emptyMachineAccessConfigDraft();
  private gatewaySubmission: { draft: GatewayServerConfigDraft; expected: GatewayServerConfigDraft } | undefined;
  private machineSubmission: { draft: MachineAccessConfigDraft; expected: MachineAccessConfigDraft } | undefined;

  get hasUnsavedMachineChanges(): boolean {
    return !draftsEqual(this.machineDraft, this.machineBaseline);
  }

  discardMachineChanges(): void {
    this.machineDraft = { ...this.machineBaseline };
    this.machineLocalError = "";
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("configResponse") && this.configResponse !== undefined) {
      const incoming = gatewayServerDraftFromConfig(this.configResponse.config);
      const submission = this.gatewaySubmission;
      const acknowledged = submission !== undefined && draftsEqual(incoming, submission.expected);
      this.gatewayDraft = reconcileConfigDraft(this.gatewayDraft, acknowledged ? submission.draft : this.gatewayBaseline, incoming);
      this.gatewayBaseline = incoming;
      if (acknowledged) this.gatewaySubmission = undefined;
    }
    // Never rebase one machine's edits onto another, including cached panels
    // whose unavailable transition occurred while they were disconnected.
    if (changed.has("targetId") || changed.has("targetLabel") || (changed.has("machineConfigResponse") && this.machineConfigResponse === undefined)) {
      this.machineDraft = emptyMachineAccessConfigDraft();
      this.machineBaseline = emptyMachineAccessConfigDraft();
      this.machineSubmission = undefined;
      this.machineLocalError = "";
    }
    if ((changed.has("machineConfigResponse") || changed.has("targetId") || changed.has("targetLabel")) && this.machineConfigResponse !== undefined) {
      const incoming = machineAccessDraftFromConfig(this.machineConfigResponse.config);
      const submission = this.machineSubmission;
      const acknowledged = submission !== undefined && draftsEqual(incoming, submission.expected);
      this.machineDraft = reconcileConfigDraft(this.machineDraft, acknowledged ? submission.draft : this.machineBaseline, incoming);
      this.machineBaseline = incoming;
      if (acknowledged) this.machineSubmission = undefined;
    }
  }

  override render(): TemplateResult {
    return html`
      <settings-panel-frame
        heading="General configuration"
        .description=${generalDescription(this.targetLabel)}
        actionLabel="Refresh settings"
        .actionDisabled=${this.loading || this.machineLoading || this.saving}
        .notices=${this.panelNotices()}
        .onAction=${() => { this.reloadAll(); }}
      >
        <div class="settings-sections ui-settings-list">
          <slot name="appearance"></slot>
          ${this.renderGatewayServerSettings()}
          ${this.renderSelectedMachineAccessSettings()}
        </div>
      </settings-panel-frame>
    `;
  }

  private renderGatewayServerSettings(): TemplateResult {
    const config = this.configResponse;
    return html`
      <section class="settings-card ui-settings-section" aria-label="Gateway server settings">
        <div class="card-heading ui-settings-heading">
          <h3>Gateway server</h3>
          <p>Save host, port, and allowed hosts on this gateway. Restart the web service to apply host or port changes.</p>
        </div>
        ${config === undefined ? html`<div class="loading-card">${this.loading ? "Loading gateway configuration…" : "Gateway settings are unavailable. Choose Refresh settings to try again."}</div>` : html`
          <div class="config-path-card ui-settings-path">
            <span>Gateway config file</span>
            <code>${config.path}</code>
            <small>${config.exists ? "Existing file" : "This file will be created on save"}</small>
          </div>
          <form class="config-form ui-settings-fields" @submit=${(event: Event) => { void this.saveGatewayConfig(event); }}>
            <label class="field ui-form-field">
              <span class="field-heading">
                <span>Host</span>
                ${this.renderOverrideBadge("host")}
              </span>
              <input class="ui-input" .value=${this.gatewayDraft.host} placeholder="127.0.0.1" autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateGatewayDraft({ host: inputValue(event) }); }}>
              <small>Address the web server should bind to. Leave empty to use PI WEB's default.</small>
            </label>

            <label class="field ui-form-field">
              <span class="field-heading">
                <span>Port</span>
                ${this.renderOverrideBadge("port")}
              </span>
              <input class="ui-input" .value=${this.gatewayDraft.port} inputmode="numeric" pattern="[0-9]*" placeholder="8504" autocomplete="off" @input=${(event: Event) => { this.updateGatewayDraft({ port: inputValue(event) }); }}>
              <small>TCP port from 1 to 65535. Leave empty to use PI WEB's default.</small>
            </label>

            <div class="field ui-form-field">
              <span class="field-heading">
                <label for="allowed-hosts-mode">Allowed hosts</label>
                ${this.renderOverrideBadge("allowedHosts")}
              </span>
              <select class="ui-input" id="allowed-hosts-mode" aria-describedby="allowed-hosts-help" .value=${this.gatewayDraft.allowedHostsMode} @change=${(event: Event) => { this.updateGatewayDraft({ allowedHostsMode: selectValue(event) === "all" ? "all" : "list" }); }}>
                <option value="list">Only listed hosts</option>
                <option value="all">Allow every host</option>
              </select>
              <label for="allowed-hosts-list">Host list</label>
              <textarea class="ui-input" id="allowed-hosts-list" aria-describedby="allowed-hosts-help" .value=${this.gatewayDraft.allowedHostsText} ?disabled=${this.gatewayDraft.allowedHostsMode === "all"} rows="4" placeholder="example.local&#10;192.168.1.20" spellcheck="false" @input=${(event: Event) => { this.updateGatewayDraft({ allowedHostsText: textAreaValue(event) }); }}></textarea>
              <small id="allowed-hosts-help">Enter one host per line. “Allow every host” disables the host restriction.</small>
            </div>

            ${this.renderGatewayEffectiveConfig()}

            <footer class="form-actions ui-settings-actions">
              ${draftsEqual(this.gatewayDraft, this.gatewayBaseline) ? null : html`<small>Unsaved changes</small>`}
              <button class="primary ui-button ui-button--action ui-button--primary" ?disabled=${this.loading || this.saving}>${this.saving ? "Saving…" : "Save gateway server config"}</button>
            </footer>
          </form>
        `}
      </section>
    `;
  }

  private renderSelectedMachineAccessSettings(): TemplateResult {
    const config = this.machineConfigResponse;
    return html`
      <section class="settings-card ui-settings-section" aria-label="Selected machine file access and upload settings">
        <div class="card-heading ui-settings-heading">
          <h3>Selected machine file access and uploads</h3>
          <p>Save file access and upload defaults on ${this.targetLabel}.</p>
        </div>
        ${this.renderMachineMessages()}
        ${config === undefined ? html`<div class="loading-card">${this.machineLoading ? "Loading selected-machine file access config…" : "File access settings are unavailable. Choose Refresh settings to try again."}</div>` : html`
          <div class="config-path-card ui-settings-path">
            <span>Selected machine config file</span>
            <code>${config.path}</code>
            <small>${config.exists ? "Existing file" : "This file will be created on save"}</small>
          </div>
          <form class="config-form ui-settings-fields" @submit=${(event: Event) => { void this.saveMachineAccessConfig(event); }}>
            <label class="field ui-form-field">
              <span class="field-heading">
                <span>External filesystem roots</span>
              </span>
              <textarea class="ui-input" .value=${this.machineDraft.allowedPathsText} rows="4" placeholder="~/SDKs&#10;/opt/reference" spellcheck="false" @input=${(event: Event) => { this.updateMachineDraft({ allowedPathsText: textAreaValue(event) }); }}></textarea>
              <small>Allowlist for absolute <code>@</code> completions and file explorer reads outside a workspace on ${this.targetLabel}. Enter one absolute path, Windows absolute path, or <code>~</code>-prefixed path per line. Leave empty to deny external paths by default.</small>
            </label>

            <label class="field ui-form-field">
              <span class="field-heading">
                <span>Default upload folder</span>
              </span>
              <input class="ui-input" .value=${this.machineDraft.uploadDefaultFolder} placeholder=${DEFAULT_WORKSPACE_UPLOADS_FOLDER} autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateMachineDraft({ uploadDefaultFolder: inputValue(event) }); }}>
              <small>Workspace-relative folder for manual file uploads on ${this.targetLabel}. Leave empty to use PI WEB's default <code>${DEFAULT_WORKSPACE_UPLOADS_FOLDER}</code>.</small>
            </label>

            <label class="field ui-form-field">
              <span class="field-heading">
                <span>Default attachments folder</span>
              </span>
              <input class="ui-input" .value=${this.machineDraft.attachmentDefaultFolder} placeholder=${DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER} autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateMachineDraft({ attachmentDefaultFolder: inputValue(event) }); }}>
              <small>Workspace-relative folder for prompt attachments saved into the workspace on ${this.targetLabel}. Leave empty to use PI WEB's default <code>${DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER}</code>.</small>
            </label>

            ${this.renderMachineEffectiveConfig()}

            <footer class="form-actions ui-settings-actions">
              ${draftsEqual(this.machineDraft, this.machineBaseline) ? null : html`<small>Unsaved changes</small>`}
              <button class="primary ui-button ui-button--action ui-button--primary" ?disabled=${this.machineLoading || this.saving}>${this.saving ? "Saving…" : "Save file/upload config"}</button>
            </footer>
          </form>
        `}
      </section>
    `;
  }

  private panelNotices(): readonly SettingsNotice[] {
    const notices: SettingsNotice[] = [];
    const gatewayError = this.gatewayLocalError || this.error;
    if (gatewayError !== "") notices.push({ type: "error", title: "Configuration", content: gatewayError });
    if (this.savedMessage !== "") notices.push({ type: "success", content: this.savedMessage });
    return notices;
  }

  private renderMachineMessages(): TemplateResult | null {
    const error = this.machineLocalError || this.machineError;
    if (error === "") return null;
    return html`<div class="message error-message ui-form-error" role="alert">${error}</div>`;
  }

  private renderOverrideBadge(key: keyof PiWebConfigEnvOverrides): TemplateResult | null {
    if (this.configResponse?.envOverrides[key] !== true) return null;
    return html`<span class="override-badge">environment override</span>`;
  }

  private renderGatewayEffectiveConfig(): TemplateResult {
    const effective = this.configResponse?.effectiveConfig ?? {};
    return html`
      <section class="effective-card ui-settings-summary" aria-label="Gateway settings after environment overrides">
        <h3>Gateway settings after overrides</h3>
        <p>Environment overrides take priority. Host and port apply after the web service restarts; these values do not verify the running address.</p>
        <dl>
          <div><dt>Host</dt><dd>${effective.host ?? html`<span class="muted">127.0.0.1 default</span>`}</dd></div>
          <div><dt>Port</dt><dd>${effective.port ?? html`<span class="muted">8504 default</span>`}</dd></div>
          <div><dt>Allowed hosts</dt><dd>${formatAllowedHosts(effective.allowedHosts)}</dd></div>
        </dl>
      </section>
    `;
  }

  private renderMachineEffectiveConfig(): TemplateResult {
    const effective = this.machineConfigResponse?.effectiveConfig ?? {};
    return html`
      <section class="effective-card ui-settings-summary" aria-label="Effective selected machine file access and upload summary">
        <h3>Effective selected-machine settings</h3>
        <dl>
          <div><dt>External roots</dt><dd>${formatAllowedPaths(effective.pathAccess?.allowedPaths)}</dd></div>
          <div><dt>Upload folder</dt><dd>${effective.uploads?.defaultFolder ?? html`<span class="muted">${DEFAULT_WORKSPACE_UPLOADS_FOLDER} default</span>`}</dd></div>
          <div><dt>Attachments folder</dt><dd>${effective.attachments?.defaultFolder ?? html`<span class="muted">${DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER} default</span>`}</dd></div>
        </dl>
      </section>
    `;
  }

  private reloadAll(): void {
    void this.onReload?.();
    void this.onReloadMachine?.();
  }

  private async saveGatewayConfig(event: Event): Promise<void> {
    event.preventDefault();
    if (this.configResponse === undefined || this.loading || this.saving || this.onSave === undefined) return;
    this.gatewayLocalError = "";
    try {
      const config = gatewayServerConfigFromDraft(this.gatewayDraft, this.configResponse.config);
      const submission = { draft: this.gatewayDraft, expected: gatewayServerDraftFromConfig(config) };
      this.gatewaySubmission = submission;
      try {
        await this.onSave(config);
        await this.updateComplete;
      } finally {
        if (this.gatewaySubmission === submission) this.gatewaySubmission = undefined;
      }
    } catch (error) {
      this.gatewayLocalError = errorMessage(error);
    }
  }

  private async saveMachineAccessConfig(event: Event): Promise<void> {
    event.preventDefault();
    if (this.machineConfigResponse === undefined || this.machineLoading || this.saving || this.onSaveMachineConfig === undefined) return;
    this.machineLocalError = "";
    const target = this.targetId;
    try {
      const config = machineAccessConfigPatchFromDraft(this.machineDraft);
      const submission = { draft: this.machineDraft, expected: machineAccessDraftFromConfig(config) };
      this.machineSubmission = submission;
      try {
        await this.onSaveMachineConfig(config);
        await this.updateComplete;
      } finally {
        if (this.machineSubmission === submission) this.machineSubmission = undefined;
      }
    } catch (error) {
      if (this.targetId === target) this.machineLocalError = errorMessage(error);
    }
  }

  private updateGatewayDraft(patch: Partial<GatewayServerConfigDraft>): void {
    this.gatewayDraft = { ...this.gatewayDraft, ...patch };
    this.gatewayLocalError = "";
  }

  private updateMachineDraft(patch: Partial<MachineAccessConfigDraft>): void {
    this.machineDraft = { ...this.machineDraft, ...patch };
    this.machineLocalError = "";
  }

  static override styles = [uiButtonStyles, uiFormStyles, uiSettingsStyles, css`
    @layer pi-web-base {
    :host { display: block; }
    h3, p { margin: 0; }
    h3 { font-size: 13px; line-height: 1.3; }
    p { color: var(--pi-muted); line-height: 1.45; }
    .loading-card { color: var(--pi-muted); }
    .config-path-card span, .field-heading, dt { color: var(--pi-muted); font-size: 12px; font-weight: 600; }
    code { border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-bg); padding: 1px 4px; color: var(--pi-text); font: 12px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); overflow-wrap: anywhere; }
    .config-path-card small, .field small { color: var(--pi-muted); }
    .field-heading { display: flex; align-items: center; gap: 8px; }
    textarea { resize: vertical; min-height: 94px; --ui-input-font-family: var(--pi-control-monospace-font-family, var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)); }
    textarea:disabled { opacity: .55; }
    .override-badge { border: 1px solid var(--pi-warning-border); border-radius: 999px; color: var(--pi-warning); background: var(--pi-warning-surface); padding: 2px 7px; font-size: 11px; font-weight: 600; text-transform: none; }
    .effective-card dl { display: grid; gap: 8px; margin: 0; }
    .effective-card dl > div { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 12px; align-items: baseline; }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .muted { color: var(--pi-muted); }
    .form-actions small { align-self: center; color: var(--pi-muted); padding-inline-end: 12px; }

    @media (max-width: 760px) {
      .effective-card dl > div { grid-template-columns: minmax(0, 1fr); gap: 3px; }
    }
    }
  `];
}

function formatAllowedHosts(value: PiWebConfigValues["allowedHosts"]): string | TemplateResult {
  if (value === true) return "Any host";
  if (Array.isArray(value)) return value.length === 0 ? html`<span class="muted">None listed</span>` : value.join(", ");
  return html`<span class="muted">Unset</span>`;
}

function formatAllowedPaths(value: string[] | undefined): string | TemplateResult {
  if (value === undefined || value.length === 0) return html`<span class="muted">External paths denied</span>`;
  return value.join(", ");
}

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : "";
}

function selectValue(event: Event): string {
  return event.target instanceof HTMLSelectElement ? event.target.value : "";
}

function textAreaValue(event: Event): string {
  return event.target instanceof HTMLTextAreaElement ? event.target.value : "";
}

function draftsEqual<T extends object>(left: T, right: T): boolean {
  for (const key in left) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
