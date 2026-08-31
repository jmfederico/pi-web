import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER, DEFAULT_WORKSPACE_UPLOADS_FOLDER, type PiWebConfigEnvOverrides, type PiWebConfigResponse, type PiWebConfigValues } from "../../api";
import "./SettingsPanelFrame";
import "./SettingsPushNotifications";
import { settingsCardStyles } from "../shared";
import type { SettingsNotice } from "./SettingsPanelFrame";
import {
  emptyGatewayServerConfigDraft,
  emptyMachineAccessConfigDraft,
  gatewayServerConfigFromDraft,
  gatewayServerDraftFromConfig,
  machineAccessConfigPatchFromDraft,
  machineAccessDraftFromConfig,
  type GatewayServerConfigDraft,
  type MachineAccessConfigDraft,
} from "./settingsConfigDraft";

function generalDescription(targetLabel: string): TemplateResult {
  return html`Gateway server fields edit this local gateway. File access and upload defaults edit ${targetLabel}.`;
}

@customElement("settings-general-panel")
export class SettingsGeneralPanel extends LitElement {
  @property({ attribute: false }) configResponse: PiWebConfigResponse | undefined;
  @property({ attribute: false }) machineConfigResponse: PiWebConfigResponse | undefined;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) machineLoading = false;
  @property({ type: Boolean }) saving = false;
  @property() error = "";
  @property() machineError = "";
  @property() savedMessage = "";
  @property() targetLabel = "selected machine";
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onReloadMachine?: () => void | Promise<void>;
  @property({ attribute: false }) onSave?: (config: PiWebConfigValues) => void | Promise<void>;
  @property({ attribute: false }) onSaveMachineConfig?: (config: PiWebConfigValues) => void | Promise<void>;
  @state() private gatewayDraft: GatewayServerConfigDraft = emptyGatewayServerConfigDraft();
  @state() private machineDraft: MachineAccessConfigDraft = emptyMachineAccessConfigDraft();
  @state() private gatewayLocalError = "";
  @state() private machineLocalError = "";

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("configResponse") && this.configResponse !== undefined) {
      this.gatewayDraft = gatewayServerDraftFromConfig(this.configResponse.config);
      this.gatewayLocalError = "";
    }
    if (changed.has("machineConfigResponse") && this.machineConfigResponse !== undefined) {
      this.machineDraft = machineAccessDraftFromConfig(this.machineConfigResponse.config);
      this.machineLocalError = "";
    }
  }

  override render(): TemplateResult {
    return html`
      <settings-panel-frame
        heading="General configuration"
        .description=${generalDescription(this.targetLabel)}
        actionLabel="Reload"
        .actionDisabled=${this.loading || this.machineLoading}
        .notices=${this.panelNotices()}
        .onAction=${() => { this.reloadAll(); }}
      >
        <div class="settings-sections">
          ${this.renderGatewayServerSettings()}
          ${this.renderSelectedMachineAccessSettings()}
          <!-- Deployment-local browser state, deliberately outside the config drafts above. -->
          <settings-push-notifications></settings-push-notifications>
        </div>
      </settings-panel-frame>
    `;
  }

  private renderGatewayServerSettings(): TemplateResult {
    const config = this.configResponse;
    return html`
      <section class="settings-card" aria-label="Gateway server settings">
        <div class="card-heading">
          <h3>Gateway server</h3>
          <p>Host, port, and allowed hosts are saved in the gateway config. Address changes require the web service to restart before the running server binds to the new address.</p>
        </div>
        ${config === undefined && this.loading ? html`<div class="loading-card">Loading gateway configuration…</div>` : html`
          <div class="config-path-card">
            <span>Gateway config file</span>
            <code>${config?.path ?? "Unknown"}</code>
            <small>${config?.exists === true ? "Existing file" : "This file will be created on save"}</small>
          </div>
          <form class="config-form" @submit=${(event: Event) => { void this.saveGatewayConfig(event); }}>
            <label class="field">
              <span class="field-heading">
                <span>Host</span>
                ${this.renderOverrideBadge("host")}
              </span>
              <input .value=${this.gatewayDraft.host} placeholder="127.0.0.1" autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateGatewayDraft({ host: inputValue(event) }); }}>
              <small>Address the web server should bind to. Leave empty to use PI WEB's default.</small>
            </label>

            <label class="field">
              <span class="field-heading">
                <span>Port</span>
                ${this.renderOverrideBadge("port")}
              </span>
              <input .value=${this.gatewayDraft.port} inputmode="numeric" pattern="[0-9]*" placeholder="8504" autocomplete="off" @input=${(event: Event) => { this.updateGatewayDraft({ port: inputValue(event) }); }}>
              <small>TCP port from 1 to 65535. Leave empty to use PI WEB's default.</small>
            </label>

            <div class="field">
              <span class="field-heading">
                <span>Allowed hosts</span>
                ${this.renderOverrideBadge("allowedHosts")}
              </span>
              <select .value=${this.gatewayDraft.allowedHostsMode} @change=${(event: Event) => { this.updateGatewayDraft({ allowedHostsMode: selectValue(event) === "all" ? "all" : "list" }); }}>
                <option value="list">Only listed hosts</option>
                <option value="all">Allow every host</option>
              </select>
              <textarea .value=${this.gatewayDraft.allowedHostsText} ?disabled=${this.gatewayDraft.allowedHostsMode === "all"} rows="4" placeholder="example.local&#10;192.168.1.20" spellcheck="false" @input=${(event: Event) => { this.updateGatewayDraft({ allowedHostsText: textAreaValue(event) }); }}></textarea>
              <small>Enter one host per line, or choose “Allow every host” to write <code>true</code>.</small>
            </div>

            ${this.renderGatewayEffectiveConfig()}

            <footer class="form-actions">
              <button class="primary" ?disabled=${this.loading || this.saving}>${this.saving ? "Saving…" : "Save gateway server config"}</button>
            </footer>
          </form>
        `}
      </section>
    `;
  }

  private renderSelectedMachineAccessSettings(): TemplateResult {
    const config = this.machineConfigResponse;
    return html`
      <section class="settings-card" aria-label="Selected machine file access and upload settings">
        <div class="card-heading">
          <h3>Selected machine file access and uploads</h3>
          <p>External filesystem roots and upload defaults are saved on ${this.targetLabel}.</p>
        </div>
        ${this.renderMachineMessages()}
        ${config === undefined ? html`<div class="loading-card">${this.machineLoading ? "Loading selected-machine file access config…" : "Selected-machine file access config is unavailable. Reload before saving file/upload settings."}</div>` : html`
          <div class="config-path-card">
            <span>Selected machine config file</span>
            <code>${config.path}</code>
            <small>${config.exists ? "Existing file" : "This file will be created on save"}</small>
          </div>
          <form class="config-form" @submit=${(event: Event) => { void this.saveMachineAccessConfig(event); }}>
            <label class="field">
              <span class="field-heading">
                <span>External filesystem roots</span>
              </span>
              <textarea .value=${this.machineDraft.allowedPathsText} rows="4" placeholder="~/SDKs&#10;/opt/reference" spellcheck="false" @input=${(event: Event) => { this.updateMachineDraft({ allowedPathsText: textAreaValue(event) }); }}></textarea>
              <small>Allowlist for absolute <code>@</code> completions and file explorer reads outside a workspace on ${this.targetLabel}. Enter one absolute path, Windows absolute path, or <code>~</code>-prefixed path per line. Leave empty to deny external paths by default.</small>
            </label>

            <label class="field">
              <span class="field-heading">
                <span>Default upload folder</span>
              </span>
              <input .value=${this.machineDraft.uploadDefaultFolder} placeholder=${DEFAULT_WORKSPACE_UPLOADS_FOLDER} autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateMachineDraft({ uploadDefaultFolder: inputValue(event) }); }}>
              <small>Workspace-relative folder for manual file uploads on ${this.targetLabel}. Leave empty to use PI WEB's default <code>${DEFAULT_WORKSPACE_UPLOADS_FOLDER}</code>.</small>
            </label>

            <label class="field">
              <span class="field-heading">
                <span>Default attachments folder</span>
              </span>
              <input .value=${this.machineDraft.attachmentDefaultFolder} placeholder=${DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER} autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateMachineDraft({ attachmentDefaultFolder: inputValue(event) }); }}>
              <small>Workspace-relative folder for prompt attachments saved into the workspace on ${this.targetLabel}. Leave empty to use PI WEB's default <code>${DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER}</code>.</small>
            </label>

            ${this.renderMachineEffectiveConfig()}

            <footer class="form-actions">
              <button class="primary" ?disabled=${this.machineLoading || this.saving}>${this.saving ? "Saving…" : "Save file/upload config"}</button>
            </footer>
          </form>
        `}
      </section>
    `;
  }

  private panelNotices(): readonly SettingsNotice[] {
    const notices: SettingsNotice[] = [];
    const gatewayError = this.gatewayLocalError || this.error;
    if (gatewayError !== "") notices.push({ type: "error", title: "Gateway server", content: gatewayError });
    if (this.savedMessage !== "") notices.push({ type: "success", content: this.savedMessage });
    return notices;
  }

  private renderMachineMessages(): TemplateResult | null {
    const error = this.machineLocalError || this.machineError;
    if (error === "") return null;
    return html`<div class="message error-message">${error}</div>`;
  }

  private renderOverrideBadge(key: keyof PiWebConfigEnvOverrides): TemplateResult | null {
    if (this.configResponse?.envOverrides[key] !== true) return null;
    return html`<span class="override-badge">environment override</span>`;
  }

  private renderGatewayEffectiveConfig(): TemplateResult {
    const effective = this.configResponse?.effectiveConfig ?? {};
    return html`
      <section class="effective-card" aria-label="Effective gateway configuration summary">
        <h3>Effective gateway settings after environment overrides</h3>
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
      <section class="effective-card" aria-label="Effective selected machine file access and upload summary">
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
    this.gatewayLocalError = "";
    try {
      await this.onSave?.(gatewayServerConfigFromDraft(this.gatewayDraft, this.configResponse?.config ?? {}));
    } catch (error) {
      this.gatewayLocalError = errorMessage(error);
    }
  }

  private async saveMachineAccessConfig(event: Event): Promise<void> {
    event.preventDefault();
    this.machineLocalError = "";
    try {
      await this.onSaveMachineConfig?.(machineAccessConfigPatchFromDraft(this.machineDraft));
    } catch (error) {
      this.machineLocalError = errorMessage(error);
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

  // Card design language (headings, buttons, settings-card box, form fields) comes from the shared
  // settingsCardStyles; this block keeps only what is specific to this panel's extra card kinds.
  static override styles = [
    settingsCardStyles,
    css`
      .settings-sections { display: grid; gap: 14px; }
      .message, .loading-card, .config-path-card, .effective-card { border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); padding: 12px; }
      .message { margin-bottom: 12px; }
      .settings-card .message { margin-bottom: 0; }
      .error-message { border-color: var(--pi-danger); color: var(--pi-danger); background: color-mix(in srgb, var(--pi-danger) 10%, var(--pi-surface)); }
      .loading-card { color: var(--pi-muted); }
      .config-path-card { display: grid; gap: 5px; }
      .config-path-card span, dt { color: var(--pi-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
      code { border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-bg); padding: 1px 4px; color: var(--pi-text); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
      .config-path-card small { color: var(--pi-muted); }
      input, select, textarea { box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); padding: 9px 10px; outline: none; font: var(--pi-control-font-size, 16px) var(--pi-control-font-family, system-ui, sans-serif); }
      input:focus, select:focus, textarea:focus { border-color: var(--pi-accent); box-shadow: 0 0 0 1px var(--pi-accent-border); }
      textarea { resize: vertical; min-height: 94px; font-family: var(--pi-control-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
      textarea:disabled { opacity: .55; }
      .override-badge { border: 1px solid var(--pi-warning-border); border-radius: 999px; color: var(--pi-warning); background: var(--pi-warning-surface); padding: 2px 7px; font-size: 11px; font-weight: 600; text-transform: none; }
      .effective-card { display: grid; gap: 10px; }
      .effective-card dl { display: grid; gap: 8px; margin: 0; }
      .effective-card dl > div { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 12px; align-items: baseline; }
      dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
      .muted { color: var(--pi-muted); }
      .primary { border-color: var(--pi-accent); background: var(--pi-selection-bg); color: var(--pi-text-bright); }

      @media (max-width: 760px) {
        .effective-card dl > div { grid-template-columns: minmax(0, 1fr); gap: 3px; }
      }
    `,
  ];
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
