import { localization, LocalizationController } from "../../localization/browser";
import { generalMessages as messages, generalConfigError } from "./settingsGeneralMessages";
import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER, DEFAULT_WORKSPACE_UPLOADS_FOLDER, type PiWebConfigEnvOverrides, type PiWebConfigResponse, type PiWebConfigValues } from "../../api";
import { uiButtonStyles } from "../ui/controlStyles";
import { uiFormStyles } from "../ui/formStyles";
import { uiSettingsStyles } from "../ui/settingsStyles";
import "./SettingsPanelFrame";
import "./SettingsLocalizationPanel";
import type { SettingsNotice } from "./SettingsPanelFrame";
import { overlayPiWebConfig } from "../../../../shared/configResolution";
import { enforcedSetting, explicitConfigUpdate, resetConfigUpdate, settingControls, type ResetSettings } from "./settingsConfigUpdate";
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
  return html`${messages.t("description", { target: targetLabel })}`;
}

@customElement("settings-general-panel")
export class SettingsGeneralPanel extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @property({ attribute: false }) configResponse: PiWebConfigResponse | undefined;
  @property({ attribute: false }) machineConfigResponse: PiWebConfigResponse | undefined;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) machineLoading = false;
  @property({ type: Boolean }) saving = false;
  @property() error = "";
  @property() machineError = "";
  @property() savedMessage = "";
  @property() targetLabel = "";
  @property() targetId = "local";
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onReloadMachine?: () => void | Promise<void>;
  @property({ attribute: false }) onSave?: (config: PiWebConfigValues, unset?: string[]) => void | Promise<void>;
  @property({ attribute: false }) onSetQuietMode?: (quietMode: boolean) => void | Promise<void>;
  @property({ attribute: false }) onSaveMachineConfig?: (config: PiWebConfigValues, unset?: string[]) => void | Promise<void>;
  @property({ attribute: false }) onReset?: ResetSettings;
  @property({ attribute: false }) onResetMachine?: ResetSettings;
  @state() private gatewayDraft: GatewayServerConfigDraft = emptyGatewayServerConfigDraft();
  @state() private machineDraft: MachineAccessConfigDraft = emptyMachineAccessConfigDraft();
  @state() private gatewayLocalError: unknown = "";
  @state() private machineLocalError: unknown = "";

  private gatewayBaseline = emptyGatewayServerConfigDraft();
  private machineBaseline = emptyMachineAccessConfigDraft();
  private gatewaySubmission: { draft: GatewayServerConfigDraft; expected: GatewayServerConfigDraft } | undefined;
  private machineSubmission: { draft: MachineAccessConfigDraft; expected: MachineAccessConfigDraft } | undefined;

  private get displayTarget(): string { return this.targetLabel || messages.t("selectedMachine"); }

  get hasUnsavedMachineChanges(): boolean {
    return !draftsEqual(this.machineDraft, this.machineBaseline);
  }

  discardMachineChanges(): void {
    this.machineDraft = { ...this.machineBaseline };
    this.machineLocalError = "";
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("configResponse") && this.configResponse !== undefined) {
      const incoming = gatewayServerDraftFromConfig(this.configResponse.effectiveConfig);
      const submission = this.gatewaySubmission;
      const acknowledged = submission !== undefined && draftsEqual(incoming, submission.expected);
      this.gatewayDraft = reconcileConfigDraft(this.gatewayDraft, acknowledged ? submission.draft : this.gatewayBaseline, incoming);
      for (const [field, setting] of [["host", "host"], ["port", "port"], ["hostValidation", "hostValidation"], ["allowedHostsMode", "allowedHosts"], ["allowedHostsText", "allowedHosts"]] as const) {
        if (enforcedSetting(this.configResponse, `/${setting}`) !== undefined) Object.assign(this.gatewayDraft, { [field]: incoming[field] });
      }
      this.gatewayBaseline = incoming;
      if (acknowledged) this.gatewaySubmission = undefined;
    }
    // Stable target identity, not its translated label, owns draft lifetime.
    // Also reset cached panels whose unavailable transition happened disconnected.
    if (changed.has("targetId") || (changed.has("machineConfigResponse") && this.machineConfigResponse === undefined)) {
      this.machineDraft = emptyMachineAccessConfigDraft();
      this.machineBaseline = emptyMachineAccessConfigDraft();
      this.machineSubmission = undefined;
      this.machineLocalError = "";
    }
    if ((changed.has("machineConfigResponse") || changed.has("targetId")) && this.machineConfigResponse !== undefined) {
      const incoming = machineAccessDraftFromConfig(this.machineConfigResponse.effectiveConfig);
      const submission = this.machineSubmission;
      const acknowledged = submission !== undefined && draftsEqual(incoming, submission.expected);
      this.machineDraft = reconcileConfigDraft(this.machineDraft, acknowledged ? submission.draft : this.machineBaseline, incoming);
      for (const [field, setting] of [["installationName", "installationName"], ["allowedPathsText", "pathAccess/allowedPaths"], ["uploadDefaultFolder", "uploads/defaultFolder"], ["attachmentDefaultFolder", "attachments/defaultFolder"]] as const) {
        if (enforcedSetting(this.machineConfigResponse, `/${setting}`) !== undefined) Object.assign(this.machineDraft, { [field]: incoming[field] });
      }
      this.machineBaseline = incoming;
      if (acknowledged) this.machineSubmission = undefined;
    }
  }

  override render(): TemplateResult {
    return html`
      <settings-panel-frame
        heading=${messages.t("heading")}
        .description=${generalDescription(this.displayTarget)}
        actionLabel=${messages.t("refresh")}
        .actionDisabled=${this.loading || this.machineLoading || this.saving}
        .notices=${this.panelNotices()}
        .onAction=${() => { this.reloadAll(); }}
      >
        <div class="settings-sections ui-settings-list">
          <slot name="appearance"></slot>
          <settings-localization-panel .configResponse=${this.configResponse}></settings-localization-panel>
          ${this.renderChatDisplaySettings()}
          ${this.renderGatewayServerSettings()}
          ${this.renderSelectedMachineAccessSettings()}
        </div>
      </settings-panel-frame>
    `;
  }

  private renderChatDisplaySettings(): TemplateResult {
    const config = this.configResponse;
    const quietMode = config?.effectiveConfig.quietMode === true;
    return html`
      <section class="settings-card ui-settings-section" aria-label=${messages.t("chatAria")}>
        <div class="card-heading ui-settings-heading">
          <h3>${messages.t("chat")}</h3>
          <p>${messages.t("chatHelp")}</p>
        </div>
        ${config === undefined ? html`<div class="loading-card">${this.loading ? messages.t("loadingGateway") : messages.t("chatUnavailable")}</div>` : html`
          <div class="field ui-form-field">
            <label class="ui-checkbox-field">
              <input
                type="checkbox"
                id="quiet-mode"
                aria-describedby="quiet-mode-help"
                .checked=${live(quietMode)}
                ?disabled=${this.loading || this.saving || enforcedSetting(config, "/quietMode") !== undefined}
                @change=${(event: Event) => { this.setQuietMode(event); }}
              >
              <span>${messages.t("quiet")}</span>
            </label>
            <small id="quiet-mode-help">${messages.t("quietHelp")}</small>
            ${settingControls(config, "/quietMode", this.loading || this.saving, this.onReset)}
          </div>
        `}
      </section>
    `;
  }

  private renderGatewayServerSettings(): TemplateResult {
    const config = this.configResponse;
    return html`
      <section class="settings-card ui-settings-section" aria-label=${messages.t("gatewayAria")}>
        <div class="card-heading ui-settings-heading">
          <h3>${messages.t("gateway")}</h3>
          <p>${messages.t("gatewayHelp")}</p>
        </div>
        ${config === undefined ? html`<div class="loading-card">${this.loading ? messages.t("loadingGateway") : messages.t("gatewayUnavailable")}</div>` : html`
          <div class="config-path-card ui-settings-path">
            <span>${messages.t("gatewayFile")}</span>
            <code dir="ltr">${config.path}</code>
            <small>${config.exists ? messages.t("exists") : messages.t("createFile")}</small>
          </div>
          <form class="config-form ui-settings-fields" @submit=${(event: Event) => { void this.saveGatewayConfig(event); }}>
            <label class="field ui-form-field">
              <span class="field-heading">
                <span>${messages.t("host")}</span>
              </span>
              <input class="ui-input" ?disabled=${enforcedSetting(config, "/host") !== undefined} .value=${this.gatewayDraft.host} placeholder="127.0.0.1" autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateGatewayDraft({ host: inputValue(event) }); }}>
              <small>${messages.t("hostHelp")}</small>
            </label>
            ${this.renderOverrideBadge("host")}

            <label class="field ui-form-field">
              <span class="field-heading">
                <span>${messages.t("port")}</span>
              </span>
              <input class="ui-input" ?disabled=${enforcedSetting(config, "/port") !== undefined} .value=${this.gatewayDraft.port} inputmode="numeric" pattern="[0-9]*" placeholder="8504" autocomplete="off" @input=${(event: Event) => { this.updateGatewayDraft({ port: inputValue(event) }); }}>
              <small>${messages.t("portHelp", { min: 1, max: 65535 })}</small>
            </label>
            ${this.renderOverrideBadge("port")}

            <div class="field ui-form-field" data-settings-target="host-validation" tabindex="-1" role="group" aria-labelledby="host-validation-label">
              <label id="host-validation-label" for="host-validation">${messages.t("hostValidation")}</label>
              <select class="ui-input" id="host-validation" aria-describedby="host-validation-help" .value=${this.gatewayDraft.hostValidation} ?disabled=${enforcedSetting(config, "/hostValidation") !== undefined} @change=${(event: Event) => {
                const value = selectValue(event);
                if (value === "pending" || value === "enabled" || value === "disabled") this.updateGatewayDraft({ hostValidation: value });
              }}>
                <option value="pending">${messages.t("hostValidationPending")}</option>
                <option value="enabled">${messages.t("hostValidationEnabled")}</option>
                <option value="disabled">${messages.t("hostValidationDisabled")}</option>
              </select>
              <small id="host-validation-help">${messages.t("hostValidationHelp")}</small>
              ${settingControls(config, "/hostValidation", this.loading || this.saving, this.onReset)}
            </div>

            <div class="field ui-form-field">
              <span class="field-heading">
                <label for="allowed-hosts-mode">${messages.t("allowedHosts")}</label>
                ${this.renderOverrideBadge("allowedHosts")}
              </span>
              <select class="ui-input" ?disabled=${enforcedSetting(config, "/allowedHosts") !== undefined} id="allowed-hosts-mode" aria-describedby="allowed-hosts-help" .value=${this.gatewayDraft.allowedHostsMode} @change=${(event: Event) => { this.updateGatewayDraft({ allowedHostsMode: selectValue(event) === "all" ? "all" : "list" }); }}>
                <option value="list">${messages.t("hostsList")}</option>
                <option value="all" ?disabled=${this.gatewayDraft.hostValidation === "enabled"}>${messages.t("hostsAll")}</option>
              </select>
              <label for="allowed-hosts-list">${messages.t("hostList")}</label>
              <textarea class="ui-input" id="allowed-hosts-list" aria-describedby="allowed-hosts-help" .value=${this.gatewayDraft.allowedHostsText} ?disabled=${this.gatewayDraft.allowedHostsMode === "all" || enforcedSetting(config, "/allowedHosts") !== undefined} rows="4" placeholder="example.local&#10;192.168.1.20" spellcheck="false" @input=${(event: Event) => { this.updateGatewayDraft({ allowedHostsText: textAreaValue(event) }); }}></textarea>
              <small id="allowed-hosts-help">${messages.t("hostsHelp")}</small>
            </div>

            ${this.renderGatewayEffectiveConfig()}

            <footer class="form-actions ui-settings-actions">
              ${draftsEqual(this.gatewayDraft, this.gatewayBaseline) ? null : html`<small>${messages.t("unsaved")}</small>`}
              <button class="primary ui-button ui-button--action ui-button--primary" ?disabled=${this.loading || this.saving}>${this.saving ? messages.t("saving") : messages.t("saveGateway")}</button>
            </footer>
          </form>
        `}
      </section>
    `;
  }

  private renderSelectedMachineAccessSettings(): TemplateResult {
    const config = this.machineConfigResponse;
    return html`
      <section class="settings-card ui-settings-section" aria-label=${messages.t("machine")}>
        <div class="card-heading ui-settings-heading">
          <h3>${messages.t("machine")}</h3>
          <p>${messages.t("machineHelp", { target: this.displayTarget })}</p>
        </div>
        ${this.renderMachineMessages()}
        ${config === undefined ? html`<div class="loading-card">${this.machineLoading ? messages.t("loadingMachine") : messages.t("machineUnavailable")}</div>` : html`
          <div class="config-path-card ui-settings-path">
            <span>${messages.t("machineFile")}</span>
            <code dir="ltr">${config.path}</code>
            <small>${config.exists ? messages.t("exists") : messages.t("createFile")}</small>
          </div>
          <form class="config-form ui-settings-fields" @submit=${(event: Event) => { void this.saveMachineAccessConfig(event); }}>
            <label class="field ui-form-field">
              <span>${messages.t("name")}</span>
              <input class="ui-input" ?disabled=${enforcedSetting(config, "/installationName") !== undefined} dir="auto" name="installationName" maxlength="120" .value=${this.machineDraft.installationName} placeholder="PI-WEB" autocomplete="off" @input=${(event: Event) => { this.updateMachineDraft({ installationName: inputValue(event) }); }}>
              <small>${messages.t("nameHelp")}</small>
            </label>
            ${settingControls(config, "/installationName", this.machineLoading || this.saving, this.onResetMachine)}
            <label class="field ui-form-field">
              <span class="field-heading">
                <span>${messages.t("roots")}</span>
              </span>
              <textarea class="ui-input" ?disabled=${enforcedSetting(config, "/pathAccess/allowedPaths") !== undefined} .value=${this.machineDraft.allowedPathsText} rows="4" placeholder="~/SDKs&#10;/opt/reference" spellcheck="false" @input=${(event: Event) => { this.updateMachineDraft({ allowedPathsText: textAreaValue(event) }); }}></textarea>
              <small>${messages.rich("rootsHelp", { target: this.displayTarget, code: codeTag })}</small>
            </label>
            ${settingControls(config, "/pathAccess/allowedPaths", this.machineLoading || this.saving, this.onResetMachine)}

            <label class="field ui-form-field">
              <span class="field-heading">
                <span>${messages.t("upload")}</span>
              </span>
              <input class="ui-input" ?disabled=${enforcedSetting(config, "/uploads/defaultFolder") !== undefined} .value=${this.machineDraft.uploadDefaultFolder} placeholder=${DEFAULT_WORKSPACE_UPLOADS_FOLDER} autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateMachineDraft({ uploadDefaultFolder: inputValue(event) }); }}>
              <small>${messages.rich("uploadHelp", { target: this.displayTarget, folder: DEFAULT_WORKSPACE_UPLOADS_FOLDER, code: codeTag })}</small>
            </label>
            ${settingControls(config, "/uploads/defaultFolder", this.machineLoading || this.saving, this.onResetMachine)}

            <label class="field ui-form-field">
              <span class="field-heading">
                <span>${messages.t("attachment")}</span>
              </span>
              <input class="ui-input" ?disabled=${enforcedSetting(config, "/attachments/defaultFolder") !== undefined} .value=${this.machineDraft.attachmentDefaultFolder} placeholder=${DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER} autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateMachineDraft({ attachmentDefaultFolder: inputValue(event) }); }}>
              <small>${messages.rich("attachmentHelp", { target: this.displayTarget, folder: DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER, code: codeTag })}</small>
            </label>
            ${settingControls(config, "/attachments/defaultFolder", this.machineLoading || this.saving, this.onResetMachine)}

            ${this.renderMachineEffectiveConfig()}

            <footer class="form-actions ui-settings-actions">
              ${draftsEqual(this.machineDraft, this.machineBaseline) ? null : html`<small>${messages.t("unsaved")}</small>`}
              <button class="primary ui-button ui-button--action ui-button--primary" ?disabled=${this.machineLoading || this.saving}>${this.saving ? messages.t("saving") : messages.t("saveMachine")}</button>
            </footer>
          </form>
        `}
      </section>
    `;
  }

  private panelNotices(): readonly SettingsNotice[] {
    const notices: SettingsNotice[] = [];
    const gatewayError = this.gatewayLocalError !== "" ? generalConfigError(this.gatewayLocalError) : this.error;
    if (gatewayError !== "") notices.push({ type: "error", title: messages.t("configuration"), content: gatewayError });
    if (this.savedMessage !== "") notices.push({ type: "success", content: this.savedMessage });
    return notices;
  }

  private renderMachineMessages(): TemplateResult | null {
    const error = this.machineLocalError !== "" ? generalConfigError(this.machineLocalError) : this.machineError;
    if (error === "") return null;
    return html`<div class="message error-message ui-form-error" role="alert">${error}</div>`;
  }

  private renderOverrideBadge(key: keyof PiWebConfigEnvOverrides): ReturnType<typeof settingControls> {
    return settingControls(this.configResponse, `/${key}`, this.loading || this.saving, this.onReset);
  }

  private renderGatewayEffectiveConfig(): TemplateResult {
    const effective = this.configResponse?.effectiveConfig ?? {};
    return html`
      <section class="effective-card ui-settings-summary" aria-label=${messages.t("effectiveGatewayAria")}>
        <h3>${messages.t("effectiveGateway")}</h3>
        <p>${messages.t("effectiveHelp")}</p>
        <dl>
          <div><dt>${messages.t("host")}</dt><dd><bdi>${effective.host ?? html`<span class="muted">${messages.t("defaultValue", { value: "127.0.0.1" })}</span>`}</bdi></dd></div>
          <div><dt>${messages.t("port")}</dt><dd>${effective.port === undefined ? html`<span class="muted">${messages.t("defaultValue", { value: "8504" })}</span>` : localization.number(effective.port)}</dd></div>
          <div><dt>${messages.t("hostValidation")}</dt><dd>${messages.t("hostValidationStatus", { mode: effective.hostValidation ?? "pending" })}</dd></div>
          <div><dt>${messages.t("hostValidationRunning")}</dt><dd>${messages.t("hostValidationStatus", { mode: this.configResponse?.activeHostValidation ?? "unknown" })}</dd></div>
          <div><dt>${messages.t("allowedHosts")}</dt><dd>${formatAllowedHosts(effective.allowedHosts)}</dd></div>
        </dl>
      </section>
    `;
  }

  private renderMachineEffectiveConfig(): TemplateResult {
    const effective = this.machineConfigResponse?.effectiveConfig ?? {};
    return html`
      <section class="effective-card ui-settings-summary" aria-label=${messages.t("effectiveMachineAria")}>
        <h3>${messages.t("effectiveMachine")}</h3>
        <p>${messages.t("machineSummaryHelp")}</p>
        <dl>
          <div><dt>${messages.t("baseRoots")}</dt><dd>
            <div>${formatAllowedPaths(effective.basePaths)}</div>
            <div class="field ui-form-field">
              <small>${messages.t("baseRootsHelp")}</small>
              ${settingControls(this.machineConfigResponse, "/basePaths", this.machineLoading || this.saving)}
            </div>
          </dd></div>
          <div><dt>${messages.t("externalRoots")}</dt><dd>${formatAllowedPaths(effective.pathAccess?.allowedPaths)}</dd></div>
          <div><dt>${messages.t("uploadFolder")}</dt><dd>${effective.uploads?.defaultFolder === undefined ? html`<span class="muted">${messages.t("defaultValue", { value: DEFAULT_WORKSPACE_UPLOADS_FOLDER })}</span>` : html`<bdi dir="ltr">${effective.uploads.defaultFolder}</bdi>`}</dd></div>
          <div><dt>${messages.t("attachmentFolder")}</dt><dd>${effective.attachments?.defaultFolder === undefined ? html`<span class="muted">${messages.t("defaultValue", { value: DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER })}</span>` : html`<bdi dir="ltr">${effective.attachments.defaultFolder}</bdi>`}</dd></div>
        </dl>
        ${(effective.basePaths?.length ?? 0) === 0 && (effective.pathAccess?.allowedPaths?.length ?? 0) === 0 ? html`<p>${messages.t("denied")}</p>` : null}
      </section>
    `;
  }

  private reloadAll(): void {
    void this.onReload?.();
    void this.onReloadMachine?.();
  }

  // The dialog owns quiet-mode failure reporting through its error notice; this
  // toggle only forwards the new value. A second change arriving before the
  // dialog's `saving` prop reaches this panel is ignored by the dialog's own
  // saving guard.
  private setQuietMode(event: Event): void {
    const quietMode = event.target instanceof HTMLInputElement && event.target.checked;
    if (this.configResponse === undefined || this.loading || this.saving || this.onSetQuietMode === undefined) return;
    this.gatewayLocalError = "";
    void this.onSetQuietMode(quietMode);
  }

  private async saveGatewayConfig(event: Event): Promise<void> {
    event.preventDefault();
    if (this.configResponse === undefined || this.loading || this.saving || this.onSave === undefined) return;
    this.gatewayLocalError = "";
    try {
      const candidate = gatewayServerConfigFromDraft(this.gatewayDraft);
      const baseline = gatewayServerConfigFromDraft(this.gatewayBaseline);
      const config = explicitConfigUpdate(this.configResponse, candidate, baseline).set ?? {};
      const resetKeys = (["host", "port"] as const).filter((key) => candidate[key] === undefined && baseline[key] !== undefined && enforcedSetting(this.configResponse, `/${key}`) === undefined);
      const expectedConfig = { ...this.configResponse.effectiveConfig, ...config };
      for (const key of resetKeys) {
        Reflect.deleteProperty(expectedConfig, key);
        const inherited = this.configResponse.defaultsConfig?.[key];
        if (inherited !== undefined) Object.assign(expectedConfig, { [key]: inherited });
      }
      const submission = { draft: this.gatewayDraft, expected: gatewayServerDraftFromConfig(expectedConfig) };
      this.gatewaySubmission = submission;
      try {
        if (resetKeys.length === 0) await this.onSave(config);
        else await this.onSave(config, resetKeys.map((key) => `/${key}`));
        await this.updateComplete;
      } finally {
        if (this.gatewaySubmission === submission) this.gatewaySubmission = undefined;
      }
    } catch (error) {
      this.gatewayLocalError = error;
    }
  }

  private async saveMachineAccessConfig(event: Event): Promise<void> {
    event.preventDefault();
    if (this.machineConfigResponse === undefined || this.machineLoading || this.saving || this.onSaveMachineConfig === undefined) return;
    this.machineLocalError = "";
    const target = this.targetId;
    try {
      const candidate = machineAccessConfigPatchFromDraft(this.machineDraft);
      const baseline = machineAccessConfigPatchFromDraft(this.machineBaseline);
      const config = explicitConfigUpdate(this.machineConfigResponse, candidate, baseline).set ?? {};
      const unset = resetConfigUpdate(this.machineConfigResponse, (["uploads", "attachments"] as const)
        .filter((key) => candidate[key]?.defaultFolder === undefined && baseline[key]?.defaultFolder !== undefined)
        .map((key) => `/${key}/defaultFolder`)).unset ?? [];
      const expected = overlayPiWebConfig(this.machineConfigResponse.effectiveConfig, config);
      for (const key of ["uploads", "attachments"] as const) {
        if (unset.includes(`/${key}/defaultFolder`)) Object.assign(expected, { [key]: this.machineConfigResponse.defaultsConfig?.[key] ?? {} });
      }
      const submission = { draft: this.machineDraft, expected: machineAccessDraftFromConfig(expected) };
      this.machineSubmission = submission;
      try {
        if (unset.length) await this.onSaveMachineConfig(config, unset);
        else await this.onSaveMachineConfig(config);
        await this.updateComplete;
      } finally {
        if (this.machineSubmission === submission) this.machineSubmission = undefined;
      }
    } catch (error) {
      if (this.targetId === target) this.machineLocalError = error;
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
    :host { display: block; overflow-wrap: anywhere; }
    h3, p { margin: 0; }
    h3 { font-size: 13px; line-height: 1.3; }
    p { color: var(--pi-muted); line-height: 1.45; }
    .loading-card { color: var(--pi-muted); }
    .config-path-card span, .field-heading, dt { color: var(--pi-muted); font-size: 12px; font-weight: 600; }
    code { border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-bg); padding: 1px 4px; color: var(--pi-text); font: 12px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); overflow-wrap: anywhere; }
    .config-path-card small, .field small { color: var(--pi-muted); }
    .field-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    input:not([name="installationName"]), textarea { direction: ltr; text-align: start; }
    .override-badge { overflow-wrap: anywhere; }
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
  if (value === true) return messages.t("anyHost");
  if (Array.isArray(value)) return value.length === 0 ? html`<span class="muted">${messages.t("noHosts")}</span>` : html`<bdi dir="ltr">${localization.list(value)}</bdi>`;
  return html`<span class="muted">${messages.t("unset")}</span>`;
}

function formatAllowedPaths(value: string[] | undefined): string | TemplateResult {
  if (value === undefined || value.length === 0) return html`<span class="muted">${messages.t("noPaths")}</span>`;
  return html`<bdi dir="ltr">${localization.list(value)}</bdi>`;
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

function codeTag(parts: unknown[]): TemplateResult {
  return html`<code dir="ltr">${parts}</code>`;
}
