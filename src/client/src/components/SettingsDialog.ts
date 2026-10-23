import { stylesheetIntegrationCapability } from "../plugins/styles";
import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { cache } from "lit/directives/cache.js";
import { live } from "lit/directives/live.js";
import type { AppAction } from "../actions";
import { configApi, piPackagesApi, pluginsApi, type Machine, type MachineHealth, type MachineRuntime, type SessionModel, type PiPackageMutationResponse, type PiPackageScope, type PiPackagesResponse, type PiWebConfigResponse, type PiWebConfigValues, type PiWebPluginsResponse, type Workspace } from "../api";
import type { McpAuthContext, McpAuthHandler } from "./settings/SettingsMcpPanel";
import "./settings/SettingsMcpPanel";
import type { SettingsSection } from "../settingsRoute";
import "./ModalSurface";
import type { ModalSurface } from "./ModalSurface";
import { uiDialogStyles, uiSelectionStyles } from "./ui/dialogStyles";
import "./settings/SettingsGeneralPanel";
import type { SettingsGeneralPanel } from "./settings/SettingsGeneralPanel";
import "./settings/SettingsThemePanel";
import type { QualifiedThemeContribution } from "../plugins/types";
import { DEFAULT_THEME_PREFERENCE, type ThemePreference } from "../theme";
import "./settings/SettingsSessiondPanel";
import "./settings/SettingsPackagesPanel";
import "./settings/SettingsPluginsPanel";
import "./settings/SettingsShortcutsPanel";
import { friendlyPiPackageErrorMessage, piPackageMutationFollowUpMessage, piPackagesResponseAfterMutation, piPackageTargetLabel, shouldRefreshGatewayPluginsAfterPiPackageMutation, type PiPackageOperationState, type PiPackageTargetContext } from "./settings/piPackageSettings";
import { loadGatewaySettingsData, loadPiPackagesData } from "./settings/settingsDataLoading";
import { mergeSelectedMachineAccessConfig } from "./settings/settingsMachineAccessConfig";
import { friendlySelectedMachineSettingsErrorMessage, isSelectedMachineSettingsUnsupported, pluginLifecycleSupport, selectedMachineSettingsSupportKey, settingsMachineTarget, settingsMachineTargetLabel, type PluginLifecycleSupport, type SettingsMachineTarget } from "./settings/settingsMachineTarget";
import { mergeSelectedMachinePluginConfig, pluginEnabledConfigPatch } from "./settings/settingsPluginConfig";
import { mergeSelectedMachineSessiondConfig } from "./settings/settingsSessiondConfig";

@customElement("settings-dialog")
export class SettingsDialog extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) section: SettingsSection = "general";
  @property({ attribute: false }) actions: AppAction[] = [];
  @property({ attribute: false }) themes: readonly QualifiedThemeContribution[] = [];
  @property({ attribute: false }) themePreference: ThemePreference = DEFAULT_THEME_PREFERENCE;
  @property() activeThemeId = "";
  @property({ type: Boolean }) hasLocalThemeOverride = false;
  @property({ attribute: false }) onUseLocalTheme?: (preference: ThemePreference) => void;
  @property({ attribute: false }) onUseDefaultTheme?: () => void;
  @property({ attribute: false }) mcpContext: McpAuthContext | undefined;
  @property({ attribute: false }) onMcpAuth?: McpAuthHandler;
  @property({ attribute: false }) machine: Machine | undefined;
  @property({ attribute: false }) workspace: Workspace | undefined;
  @property({ attribute: false }) machineRuntime: MachineRuntime | undefined;
  @property({ attribute: false }) machines: Machine[] = [];
  @property({ attribute: false }) machineStatuses: Record<string, MachineHealth> = {};
  @property({ attribute: false }) machineRuntimes: Record<string, MachineRuntime> = {};
  @state() private settingsMachineId: string | undefined;
  @state() private pendingMachineId: string | undefined;
  private generalPanel: SettingsGeneralPanel | undefined;
  @property({ attribute: false }) onNavigate?: (section: SettingsSection) => void;
  @property({ attribute: false }) onClose?: () => void;
  @property({ attribute: false }) onConfigSaved?: (config: PiWebConfigValues) => void;
  @property({ attribute: false }) onRefreshMachineRuntime?: (machineId: string) => void | Promise<void>;
  @state() private configResponse: PiWebConfigResponse | undefined;
  @state() private accessConfigResponse: PiWebConfigResponse | undefined;
  @state() private sessiondConfigResponse: PiWebConfigResponse | undefined;
  @state() private pluginsResponse: PiWebPluginsResponse | undefined;
  @state() private selectedPluginConfigResponse: PiWebConfigResponse | undefined;
  @state() private selectedPluginsResponse: PiWebPluginsResponse | undefined;
  @state() private packagesResponse: PiPackagesResponse | undefined;
  @state() private loading = true;
  @state() private accessLoading = true;
  @state() private sessiondLoading = true;
  @state() private namingModels: SessionModel[] = [];
  @state() private namingModelsLoading = true;
  @state() private namingModelsError = "";
  @state() private pluginLoading = true;
  @state() private packageLoading = true;
  @state() private saving = false;
  @state() private packageOperation: PiPackageOperationState | undefined;
  @state() private error = "";
  @state() private accessError = "";
  @state() private sessiondError = "";
  @state() private pluginError = "";
  @state() private packageError = "";
  @state() private savedMessage = "";
  @state() private savedSection: SettingsSection | undefined;
  @state() private packageMessage = "";
  private savedMessageTimer: number | undefined;
  private loadRequestSeq = 0;
  private accessLoadRequestSeq = 0;
  private sessiondLoadRequestSeq = 0;
  private namingModelsLoadRequestSeq = 0;
  private pluginLoadRequestSeq = 0;
  private packageLoadRequestSeq = 0;
  private packageMutationSeq = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.loadConfig();
    void this.loadAccessConfigForTarget();
    void this.reloadSessiondState();
    void this.loadPluginsForTarget();
    void this.loadPackagesForTarget();
  }

  override disconnectedCallback(): void {
    if (this.savedMessageTimer !== undefined) window.clearTimeout(this.savedMessageTimer);
    this.savedMessageTimer = undefined;
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("section")) {
      // The surface must render its slot before the mobile tab row has layout.
      const surface = this.renderRoot.querySelector<ModalSurface>("modal-surface");
      void surface?.updateComplete.then(() => {
        if (this.isConnected) this.renderRoot.querySelector(".settings-nav button.selected")?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    }
    if (this.isConnected) {
      const generalPanel = this.renderRoot.querySelector<SettingsGeneralPanel>("settings-general-panel");
      if (generalPanel !== null) this.generalPanel = generalPanel;
    }
    const currentTarget = this.settingsTarget();
    if (changed.has("machine") || changed.has("machines")) {
      const previousTarget = settingsMachineTarget(this.selectedSettingsMachine(
        changed.has("machines") ? changed.get("machines") ?? [] : this.machines,
        changed.has("machine") ? changed.get("machine") : this.machine,
        this.settingsMachineId,
      ));
      if (previousTarget.id !== currentTarget.id) {
        this.reloadForTargetChange(currentTarget);
        return;
      }
    }

    if (!changed.has("machineRuntime") && !changed.has("machineRuntimes")) return;
    const previousRuntime = this.settingsRuntime(
      changed.has("machineRuntimes") ? changed.get("machineRuntimes") ?? {} : this.machineRuntimes,
      changed.has("machineRuntime") ? changed.get("machineRuntime") : this.machineRuntime,
      currentTarget,
    );
    if (!this.pluginLifecycleSupportNeedsReload(previousRuntime, currentTarget)) return;
    this.resetPluginStateForTargetChange();
    if (this.isConnected) void this.loadPluginsForTarget(currentTarget);
  }

  override render(): TemplateResult {
    return html`
      <modal-surface .onClose=${() => this.onClose?.()} .label=${"PI WEB settings"}>
        <header class="settings-header ui-dialog-header">
          <h1 class="ui-dialog-title">Settings</h1>
          <button class="close-button ui-button ui-button--icon" title="Close settings" aria-label="Close settings" @click=${() => this.onClose?.()}>×</button>
        </header>
        <div class="settings-body">
          <nav class="settings-nav" aria-label="Settings sections">
            ${this.renderNavButton("general", "General", "Appearance, gateway, and machine")}
            ${this.renderNavButton("sessiond", "Session daemon", "Selected machine")}
            ${this.renderNavButton("packages", "Pi packages", "Selected machine")}
            ${this.renderNavButton("plugins", "PI WEB plugins", "Selected machine")}
            ${this.renderNavButton("mcp", "MCP servers", "Selected machine + workspace")}
            ${this.renderNavButton("shortcuts", "Keyboard shortcuts", "This gateway")}
          </nav>
          <main class="settings-main">
            ${this.renderMachineSelector()}
            ${this.renderMachineSwitchConfirmation()}
            <div class="settings-content">${cache(this.renderActiveSection())}</div>
          </main>
        </div>
      </modal-surface>
    `;
  }

  private renderMachineSelector(): TemplateResult | null {
    if (this.machines.length <= 1) return null;
    const target = this.settingsTarget();
    const health = this.machineStatuses[target.id];
    const machine = this.machines.find((candidate) => candidate.id === target.id);
    const runtime = this.settingsRuntime(this.machineRuntimes, this.machineRuntime, target);
    const status = health?.status ?? (health === undefined ? machine?.status ?? (runtime === undefined ? "unknown" : runtime.ok ? "online" : "offline") : health.ok ? "online" : "offline");
    const statusLabel = status === "online" ? "Connected" : status === "unknown" ? "Connection not checked" : "Unavailable";
    const unavailable = status === "offline" || status === "error";
    const statusMessage = unavailable ? health?.error ?? machine?.statusMessage ?? runtime?.error : undefined;
    return html`
      <div class="settings-machine">
        <label for="settings-machine">Configure machine</label>
        <select class="ui-select" id="settings-machine" aria-describedby=${unavailable ? "settings-machine-help settings-machine-status settings-machine-error" : "settings-machine-help settings-machine-status"} .value=${live(target.id)} ?disabled=${this.saving} @change=${(event: Event) => {
          if (event.target instanceof HTMLSelectElement) this.requestMachineSwitch(event.target.value);
        }}>
          ${this.machines.map((candidate) => html`<option value=${candidate.id}>${candidate.name}${candidate.kind === "local" ? " (this gateway)" : ""}</option>`)}
        </select>
        <small id="settings-machine-status" class=${unavailable ? "machine-status unavailable" : "machine-status"} role="status">${statusLabel}</small>
        <details class="machine-scope">
          <summary>What changes?</summary>
          <p id="settings-machine-help">Agent permissions, packages, plugins, file access, and upload settings apply to this machine. Gateway settings, the default theme, and keyboard shortcuts stay on this server. Your browser theme, workspace, and session stay unchanged.</p>
        </details>
        ${unavailable ? html`<p id="settings-machine-error" class="machine-connection-error" role="status">${statusMessage ?? "This machine is unavailable."}<br>Check the machine connection, then refresh settings.</p>` : null}
      </div>
    `;
  }

  private requestMachineSwitch(machineId: string): void {
    if (this.saving || !this.machines.some((machine) => machine.id === machineId)) return;
    if (machineId === this.settingsTarget().id) {
      this.pendingMachineId = undefined;
    } else if (this.generalPanel?.hasUnsavedMachineChanges === true) {
      this.pendingMachineId = machineId;
    } else {
      this.switchSettingsMachine(machineId);
    }
    // A pending confirmation keeps the native select on the current target.
    this.requestUpdate();
  }

  private switchSettingsMachine(machineId: string): void {
    this.settingsMachineId = machineId;
    this.pendingMachineId = undefined;
    this.reloadForTargetChange(this.settingsTarget());
  }

  private reloadForTargetChange(target: SettingsMachineTarget): void {
    this.resetAccessStateForTargetChange();
    this.resetSessiondStateForTargetChange();
    this.resetPluginStateForTargetChange();
    this.resetPackageStateForTargetChange();
    if (!this.isConnected) return;
    void this.loadAccessConfigForTarget(target);
    void this.reloadSessiondState(target);
    void this.loadPluginsForTarget(target);
    void this.loadPackagesForTarget(target);
  }

  private renderMachineSwitchConfirmation(): TemplateResult | null {
    const pending = this.machines.find((machine) => machine.id === this.pendingMachineId);
    if (pending === undefined) return null;
    return html`
      <section class="machine-switch-confirmation" role="alert" aria-label="Unsaved machine settings">
        <p>You have unsaved file access or upload settings for ${this.settingsTarget().name}. Discard them and configure ${pending.name}?</p>
        <button class="ui-button ui-button--action danger" ?disabled=${this.saving} @click=${() => { this.generalPanel?.discardMachineChanges(); this.switchSettingsMachine(pending.id); }}>Discard edits and switch</button>
        <button class="ui-button ui-button--action" @click=${() => { this.pendingMachineId = undefined; }}>Keep editing</button>
      </section>
    `;
  }

  private renderActiveSection(): TemplateResult {
    // Keep the section -> panel routing in sync with the public
    // `activeSettingsPanelTag` seam below, which tests assert against instead of
    // scraping this template's markup.
    if (this.section === "mcp") {
      const target = this.settingsTarget();
      const machine = this.selectedSettingsMachine(this.machines, this.machine, this.settingsMachineId);
      return html`
        <settings-mcp-panel
          .machine=${machine}
          .workspace=${target.id === settingsMachineTarget(this.machine).id ? this.workspace : undefined}
          .context=${this.mcpContext?.machineId === target.id ? this.mcpContext : undefined}
          .targetLabel=${settingsMachineTargetLabel(target)}
          .onMcpAuth=${this.onMcpAuth}
        ></settings-mcp-panel>
      `;
    }
    if (this.section === "sessiond") {
      return html`
        <settings-sessiond-panel
          .configResponse=${this.sessiondConfigResponse}
          .namingModels=${this.namingModels}
          .namingModelsLoading=${this.namingModelsLoading}
          .namingModelsError=${this.namingModelsError}
          .loading=${this.sessiondLoading}
          .saving=${this.saving}
          .error=${this.sessiondError}
          .savedMessage=${this.savedSection === "sessiond" ? this.savedMessage : ""}
          .targetLabel=${settingsMachineTargetLabel(this.settingsTarget())}
          .onReload=${() => this.reloadSessiondState()}
          .onSave=${(config: PiWebConfigValues) => this.saveSessiondConfig(config)}
        ></settings-sessiond-panel>
      `;
    }
    if (this.section === "shortcuts") {
      return html`
        <settings-shortcuts-panel
          .actions=${this.actions}
          .configResponse=${this.configResponse}
          .loading=${this.loading}
          .saving=${this.saving}
          .error=${this.error}
          .savedMessage=${this.savedSection === "shortcuts" ? this.savedMessage : ""}
          .onReload=${() => this.loadConfig()}
          .onSave=${(config: PiWebConfigValues) => this.saveConfig(config)}
        ></settings-shortcuts-panel>
      `;
    }
    if (this.section === "packages") {
      return html`
        <settings-packages-panel
          .packagesResponse=${this.packagesResponse}
          .targetMachine=${this.packageTarget()}
          .loading=${this.packageLoading}
          .operation=${this.packageOperation}
          .error=${this.packageError}
          .operationMessage=${this.packageMessage}
          .onReload=${() => this.loadPackagesForTarget()}
          .onInstallPackage=${(source: string) => this.installPiPackage(source)}
          .onRemovePackage=${(source: string, scope: PiPackageScope) => this.removePiPackage(source, scope)}
          .onUpdatePackage=${(source?: string) => this.updatePiPackage(source)}
        ></settings-packages-panel>
      `;
    }
    if (this.section === "plugins") {
      return html`
        <settings-plugins-panel
          .configResponse=${this.selectedPluginConfigResponse}
          .pluginsResponse=${this.selectedPluginsResponse}
          .loading=${this.pluginLoading}
          .saving=${this.saving}
          .recoveryCommandsSupported=${this.pluginLifecycleSupport().state === "supported"}
          .error=${this.pluginError}
          .savedMessage=${this.savedSection === "plugins" ? this.savedMessage : ""}
          .targetLabel=${settingsMachineTargetLabel(this.settingsTarget())}
          .onReload=${() => this.loadPluginsForTarget()}
          .onTogglePlugin=${(pluginId: string, enabled: boolean) => this.togglePlugin(pluginId, enabled)}
        ></settings-plugins-panel>
      `;
    }
    return html`
      <settings-general-panel
        .configResponse=${this.configResponse}
        .machineConfigResponse=${this.accessConfigResponse}
        .loading=${this.loading}
        .machineLoading=${this.accessLoading}
        .saving=${this.saving}
        .error=${this.error}
        .machineError=${this.accessError}
        .savedMessage=${this.savedSection === "general" ? this.savedMessage : ""}
        .targetLabel=${settingsMachineTargetLabel(this.settingsTarget())}
        .targetId=${this.settingsTarget().id}
        .onReload=${() => this.loadConfig()}
        .onReloadMachine=${() => this.loadAccessConfigForTarget()}
        .onSave=${(config: PiWebConfigValues) => this.saveConfig(config)}
        .onSaveMachineConfig=${(config: PiWebConfigValues) => this.saveMachineAccessConfig(config)}
      >
        <settings-theme-panel
          slot="appearance"
          .themes=${this.themes}
          .preference=${this.themePreference}
          .defaultPreference=${this.configResponse?.effectiveConfig.defaultTheme ?? DEFAULT_THEME_PREFERENCE}
          .activeThemeId=${this.activeThemeId}
          .hasLocalOverride=${this.hasLocalThemeOverride}
          .loading=${this.loading || this.configResponse === undefined}
          .saving=${this.saving}
          .onUseLocal=${this.onUseLocalTheme}
          .onUseDefault=${this.onUseDefaultTheme}
          .onSetDefault=${(preference: ThemePreference) => this.saveDefaultTheme(preference)}
        ></settings-theme-panel>
      </settings-general-panel>
    `;
  }

  private renderNavButton(section: SettingsSection, label: string, detail: string): TemplateResult {
    const selected = this.section === section;
    return html`
      <button class=${`ui-button ui-selection-option${selected ? " selected" : ""}`} aria-current=${selected ? "page" : "false"} @click=${() => { this.navigate(section); }}>
        <strong>${label}</strong>
        <small>${detail}</small>
      </button>
    `;
  }

  private navigate(section: SettingsSection): void {
    this.onNavigate?.(section);
  }

  private async loadConfig(): Promise<void> {
    const requestSeq = ++this.loadRequestSeq;
    this.loading = true;
    this.error = "";
    try {
      const result = await loadGatewaySettingsData({
        loadConfig: () => configApi.config(),
        loadPlugins: () => pluginsApi.plugins(),
      });
      if (!this.isCurrentLoad(requestSeq)) return;

      if (result.config !== undefined) {
        this.configResponse = result.config;
        this.onConfigSaved?.(result.config.effectiveConfig);
      }
      if (result.plugins !== undefined) this.pluginsResponse = result.plugins;
      this.error = result.error;
    } finally {
      if (this.isCurrentLoad(requestSeq)) this.loading = false;
    }
  }

  private async loadAccessConfigForTarget(target = this.settingsTarget()): Promise<void> {
    const requestSeq = ++this.accessLoadRequestSeq;
    this.accessLoading = true;
    this.accessError = "";
    try {
      const response = await configApi.config(target.id);
      if (!this.isCurrentAccessLoad(requestSeq, target)) return;
      this.accessConfigResponse = response;
    } catch (error) {
      if (this.isCurrentAccessLoad(requestSeq, target)) {
        this.accessError = `Failed to load file access/upload config from ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}`;
      }
    } finally {
      if (this.isCurrentAccessLoad(requestSeq, target)) this.accessLoading = false;
    }
  }

  private async reloadSessiondState(target = this.settingsTarget()): Promise<void> {
    await Promise.all([
      this.loadSessiondConfigForTarget(target),
      this.loadNamingModelsForTarget(target),
      this.onRefreshMachineRuntime?.(target.id),
    ]);
  }

  private async loadNamingModelsForTarget(target = this.settingsTarget()): Promise<void> {
    const requestSeq = ++this.namingModelsLoadRequestSeq;
    this.namingModelsLoading = true;
    this.namingModelsError = "";
    try {
      const response = await configApi.namingModels(target.id);
      if (!this.isCurrentNamingModelsLoad(requestSeq, target)) return;
      this.namingModels = response.models;
    } catch (error) {
      if (this.isCurrentNamingModelsLoad(requestSeq, target)) {
        this.namingModelsError = `Failed to load naming models from ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}`;
      }
    } finally {
      if (this.isCurrentNamingModelsLoad(requestSeq, target)) this.namingModelsLoading = false;
    }
  }

  private async loadSessiondConfigForTarget(target = this.settingsTarget()): Promise<void> {
    const requestSeq = ++this.sessiondLoadRequestSeq;
    this.sessiondLoading = true;
    this.sessiondError = "";
    try {
      const response = await configApi.config(target.id);
      if (!this.isCurrentSessiondLoad(requestSeq, target)) return;
      this.sessiondConfigResponse = response;
    } catch (error) {
      if (this.isCurrentSessiondLoad(requestSeq, target)) {
        this.sessiondError = `Failed to load session-daemon config from ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}`;
      }
    } finally {
      if (this.isCurrentSessiondLoad(requestSeq, target)) this.sessiondLoading = false;
    }
  }

  private async loadPluginsForTarget(target = this.settingsTarget()): Promise<void> {
    const requestSeq = ++this.pluginLoadRequestSeq;
    this.pluginLoading = true;
    this.pluginError = "";
    try {
      const lifecycleSupport = this.pluginLifecycleSupport(target);
      if (isSelectedMachineSettingsUnsupported(lifecycleSupport)) {
        try {
          const config = await configApi.config(target.id);
          if (!this.isCurrentPluginLoad(requestSeq, target)) return;
          this.selectedPluginConfigResponse = config;
          this.selectedPluginsResponse = undefined;
          this.pluginError = lifecycleSupport.message ?? `Plugin lifecycle diagnostics are not available on ${settingsMachineTargetLabel(target)}.`;
        } catch (error) {
          if (!this.isCurrentPluginLoad(requestSeq, target)) return;
          this.pluginError = `Failed to load PI WEB plugin config from ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}; ${lifecycleSupport.message ?? "plugin lifecycle diagnostics are unsupported"}`;
        }
        return;
      }

      const [config, plugins] = await Promise.allSettled([configApi.config(target.id), pluginsApi.plugins(target.id)]);
      if (!this.isCurrentPluginLoad(requestSeq, target)) return;

      const errors: string[] = [];
      if (config.status === "fulfilled") this.selectedPluginConfigResponse = config.value;
      else errors.push(`config: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(config.reason), target)}`);

      if (plugins.status === "fulfilled") this.selectedPluginsResponse = plugins.value;
      else errors.push(`PI WEB plugins: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(plugins.reason), target)}`);

      this.pluginError = errors.length === 0 ? "" : `Failed to load PI WEB plugin settings from ${settingsMachineTargetLabel(target)}: ${errors.join("; ")}`;
    } finally {
      if (this.isCurrentPluginLoad(requestSeq, target)) this.pluginLoading = false;
    }
  }

  private async loadPackagesForTarget(target = this.packageTarget()): Promise<void> {
    const requestSeq = ++this.packageLoadRequestSeq;
    this.packageLoading = true;
    this.packageError = "";
    this.packageMessage = "";
    try {
      const result = await loadPiPackagesData(target, (targetId) => piPackagesApi.packages(targetId));
      if (!this.isCurrentPackageLoad(requestSeq, target)) return;

      this.packagesResponse = result.packagesResponse;
      this.packageError = result.error;
    } finally {
      if (this.isCurrentPackageLoad(requestSeq, target)) this.packageLoading = false;
    }
  }

  private async togglePlugin(pluginId: string, enabled: boolean): Promise<void> {
    if (this.saving) return;
    const target = this.settingsTarget();
    const lifecycleSupport = this.pluginLifecycleSupport(target);
    if (this.selectedPluginConfigResponse === undefined) {
      this.pluginError = `Plugin config is not loaded for ${settingsMachineTargetLabel(target)}. Choose Refresh plugins before changing plugin settings.`;
      return;
    }
    const patch = pluginEnabledConfigPatch(this.selectedPluginConfigResponse.config, pluginId, enabled);
    this.saving = true;
    this.pluginError = "";
    this.savedMessage = "";
    try {
      const response = await configApi.saveConfig(patch, target.id);
      if (!this.isCurrentSettingsTarget(target)) return;
      this.selectedPluginConfigResponse = response;
      if (target.kind === "local" && this.configResponse !== undefined) {
        this.configResponse = mergeSelectedMachinePluginConfig(this.configResponse, response);
        this.onConfigSaved?.(this.configResponse.effectiveConfig);
      }
      let pluginRefreshError: string | undefined;
      if (isSelectedMachineSettingsUnsupported(lifecycleSupport)) {
        this.selectedPluginsResponse = undefined;
        pluginRefreshError = lifecycleSupport.message ?? `Plugin lifecycle diagnostics are not available on ${settingsMachineTargetLabel(target)}.`;
      } else {
        pluginRefreshError = await this.refreshPluginsForTarget(target);
      }
      if (!this.isCurrentSettingsTarget(target)) return;
      if (pluginRefreshError !== undefined) this.pluginError = pluginRefreshError;
      this.showSavedMessage(`Plugin settings saved for ${target.name}.`, "plugins");
    } catch (error) {
      if (this.isCurrentSettingsTarget(target)) {
        this.pluginError = `Failed to save PI WEB plugin config on ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}`;
      }
    } finally {
      this.saving = false;
    }
  }

  private async saveConfig(config: PiWebConfigValues): Promise<void> {
    if (this.saving) return;
    const section = this.section === "shortcuts" ? "shortcuts" : "general";
    this.saving = true;
    this.error = "";
    this.savedMessage = "";
    try {
      const response = await configApi.saveConfig(config);
      this.configResponse = response;
      this.onConfigSaved?.(response.effectiveConfig);
      this.showSavedMessage(section === "shortcuts" ? "Keyboard settings saved." : "Gateway settings saved. Restart the web service to apply address changes.", section);
    } catch (error) {
      this.error = `Couldn't save settings: ${errorMessage(error)}`;
    } finally {
      this.saving = false;
    }
  }

  private async saveDefaultTheme(preference: ThemePreference): Promise<void> {
    if (this.saving) return;
    // Retire an older Reload result and read fresh gateway config so this
    // focused action does not replace other settings with the dialog's snapshot.
    this.loadRequestSeq += 1;
    this.loading = false;
    this.saving = true;
    this.error = "";
    this.savedMessage = "";
    try {
      const current = await configApi.config();
      const response = await configApi.saveConfig({ ...current.config, defaultTheme: preference });
      this.configResponse = response;
      this.onConfigSaved?.(response.effectiveConfig);
      this.showSavedMessage("Default theme saved. Saved browser choices are unchanged.", "general");
    } catch (error) {
      this.error = `Couldn't save the default theme: ${errorMessage(error)}`;
    } finally {
      this.saving = false;
    }
  }

  private async saveMachineAccessConfig(config: PiWebConfigValues): Promise<void> {
    if (this.saving) return;
    const target = this.settingsTarget();
    this.saving = true;
    this.accessError = "";
    this.savedMessage = "";
    try {
      const response = await configApi.saveConfig(config, target.id);
      if (!this.isCurrentSettingsTarget(target)) return;
      this.accessConfigResponse = response;
      if (target.kind === "local" && this.configResponse !== undefined) {
        this.configResponse = mergeSelectedMachineAccessConfig(this.configResponse, response);
        this.onConfigSaved?.(this.configResponse.effectiveConfig);
      }
      this.showSavedMessage(`File access and upload settings saved for ${target.name}.`, "general");
    } catch (error) {
      if (this.isCurrentSettingsTarget(target)) {
        this.accessError = `Failed to save file access/upload config on ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}`;
      }
    } finally {
      this.saving = false;
    }
  }

  private async saveSessiondConfig(config: PiWebConfigValues): Promise<void> {
    if (this.saving) return;
    const target = this.settingsTarget();
    this.saving = true;
    this.sessiondError = "";
    this.savedMessage = "";
    try {
      const response = await configApi.saveConfig(config, target.id);
      if (!this.isCurrentSettingsTarget(target)) return;
      this.sessiondConfigResponse = response;
      if (target.kind === "local" && this.configResponse !== undefined) this.configResponse = mergeSelectedMachineSessiondConfig(this.configResponse, response);
      const namingOnly = Object.keys(config).length === 1 && config.sessionNaming !== undefined;
      const message = namingOnly
        ? `Session naming settings saved for ${target.name}. They apply to the next naming request without a restart. Existing names and in-progress naming requests are unchanged.`
        : `Session daemon settings saved for ${target.name}. Restart the session daemon to apply agent permission changes. Restarting interrupts active sessions.${config.sessionNaming === undefined ? "" : " Naming changes apply to the next naming request without a restart."}`;
      this.showSavedMessage(message, "sessiond");
    } catch (error) {
      if (this.isCurrentSettingsTarget(target)) {
        this.sessiondError = `Failed to save session-daemon config on ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}`;
      }
    } finally {
      this.saving = false;
    }
  }

  private async installPiPackage(source: string): Promise<void> {
    const target = this.packageTarget();
    await this.runPiPackageMutation({ kind: "install", source }, "install Pi package", target, () => piPackagesApi.install(source, target.id));
  }

  private async removePiPackage(source: string, scope: PiPackageScope): Promise<void> {
    const target = this.packageTarget();
    await this.runPiPackageMutation({ kind: "remove", source }, "remove Pi package", target, () => piPackagesApi.remove(source, scope, target.id));
  }

  private async updatePiPackage(source?: string): Promise<void> {
    const target = this.packageTarget();
    await this.runPiPackageMutation(source === undefined ? { kind: "update-all" } : { kind: "update", source }, "update Pi packages", target, () => piPackagesApi.update(source, target.id));
  }

  private async runPiPackageMutation(operation: PiPackageOperationState, label: string, target: PiPackageTargetContext, mutate: () => Promise<PiPackageMutationResponse>): Promise<void> {
    if (this.saving) throw new Error("A settings operation is already running.");
    const requestSeq = ++this.packageMutationSeq;
    this.packageLoadRequestSeq += 1;
    this.packageLoading = false;
    this.saving = true;
    this.packageOperation = operation;
    this.packageError = "";
    this.packageMessage = "";
    try {
      const response = await mutate();
      if (!this.isCurrentPackageMutation(requestSeq, target)) return;
      this.packagesResponse = piPackagesResponseAfterMutation(response);
      const pluginRefreshError = shouldRefreshGatewayPluginsAfterPiPackageMutation(target) ? await this.refreshGatewayPlugins() : undefined;
      if (!this.isCurrentPackageMutation(requestSeq, target)) return;
      if (pluginRefreshError !== undefined) this.packageError = pluginRefreshError;
      this.packageMessage = piPackageMutationFollowUpMessage(response.action, target);
    } catch (error) {
      if (this.isCurrentPackageMutation(requestSeq, target)) this.packageError = `Failed to ${label} on ${piPackageTargetLabel(target)}: ${friendlyPiPackageErrorMessage(errorMessage(error), target)}`;
      throw error;
    } finally {
      if (this.packageMutationSeq === requestSeq) {
        this.packageOperation = undefined;
        this.saving = false;
      }
    }
  }

  private async refreshGatewayPlugins(): Promise<string | undefined> {
    try {
      this.pluginsResponse = await pluginsApi.plugins();
      return undefined;
    } catch (error) {
      return `Failed to refresh gateway PI WEB plugins: ${errorMessage(error)}`;
    }
  }

  private async refreshPluginsForTarget(target: SettingsMachineTarget): Promise<string | undefined> {
    try {
      const response = await pluginsApi.plugins(target.id);
      if (this.isCurrentSettingsTarget(target)) this.selectedPluginsResponse = response;
      return undefined;
    } catch (error) {
      if (this.isCurrentSettingsTarget(target)) this.selectedPluginsResponse = undefined;
      return `Config saved, but failed to refresh PI WEB plugins from ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}`;
    }
  }

  private selectedSettingsMachine(machines: Machine[], machine: Machine | undefined, selectedId: string | undefined): Machine | undefined {
    if (machines.length === 0) return machine;
    return machines.find((candidate) => candidate.id === (selectedId ?? machine?.id))
      ?? machines.find((candidate) => candidate.kind === "local")
      ?? machines[0];
  }

  private settingsTarget(): SettingsMachineTarget {
    return settingsMachineTarget(this.selectedSettingsMachine(this.machines, this.machine, this.settingsMachineId));
  }

  private settingsRuntime(runtimes: Record<string, MachineRuntime>, runtime: MachineRuntime | undefined, target: SettingsMachineTarget): MachineRuntime | undefined {
    return runtimes[target.id] ?? (runtime?.machineId === target.id ? runtime : undefined);
  }

  private packageTarget(): PiPackageTargetContext {
    return this.settingsTarget();
  }

  private pluginLifecycleSupport(target = this.settingsTarget()): PluginLifecycleSupport {
    return pluginLifecycleSupport(target, this.settingsRuntime(this.machineRuntimes, this.machineRuntime, target));
  }

  private pluginLifecycleSupportNeedsReload(previousRuntime: MachineRuntime | undefined, target: SettingsMachineTarget): boolean {
    const previousSupport = pluginLifecycleSupport(target, previousRuntime);
    const currentSupport = this.pluginLifecycleSupport(target);
    return selectedMachineSettingsSupportKey(previousSupport) !== selectedMachineSettingsSupportKey(currentSupport);
  }

  private isCurrentLoad(requestSeq: number): boolean {
    return requestSeq === this.loadRequestSeq;
  }

  private isCurrentAccessLoad(requestSeq: number, target: SettingsMachineTarget): boolean {
    return requestSeq === this.accessLoadRequestSeq && this.isCurrentSettingsTarget(target);
  }

  private isCurrentNamingModelsLoad(requestSeq: number, target: SettingsMachineTarget): boolean {
    return requestSeq === this.namingModelsLoadRequestSeq && this.isCurrentSettingsTarget(target);
  }

  private isCurrentSessiondLoad(requestSeq: number, target: SettingsMachineTarget): boolean {
    return requestSeq === this.sessiondLoadRequestSeq && this.isCurrentSettingsTarget(target);
  }

  private isCurrentPluginLoad(requestSeq: number, target: SettingsMachineTarget): boolean {
    return requestSeq === this.pluginLoadRequestSeq && this.isCurrentSettingsTarget(target);
  }

  private isCurrentPackageLoad(requestSeq: number, target: PiPackageTargetContext): boolean {
    return requestSeq === this.packageLoadRequestSeq && this.isCurrentPackageTarget(target);
  }

  private isCurrentPackageMutation(requestSeq: number, target: PiPackageTargetContext): boolean {
    return requestSeq === this.packageMutationSeq && this.isCurrentPackageTarget(target);
  }

  private isCurrentPackageTarget(target: PiPackageTargetContext): boolean {
    return this.packageTarget().id === target.id;
  }

  private isCurrentSettingsTarget(target: SettingsMachineTarget): boolean {
    return this.settingsTarget().id === target.id;
  }

  private resetAccessStateForTargetChange(): void {
    this.accessLoadRequestSeq += 1;
    this.accessLoading = false;
    this.accessError = "";
    this.accessConfigResponse = undefined;
    this.savedMessage = "";
  }

  private resetSessiondStateForTargetChange(): void {
    this.namingModelsLoadRequestSeq += 1;
    this.namingModels = [];
    this.namingModelsLoading = false;
    this.namingModelsError = "";
    this.sessiondLoadRequestSeq += 1;
    this.sessiondLoading = false;
    this.sessiondError = "";
    this.sessiondConfigResponse = undefined;
    this.savedMessage = "";
  }

  private resetPluginStateForTargetChange(): void {
    this.pluginLoadRequestSeq += 1;
    this.pluginLoading = false;
    this.pluginError = "";
    this.selectedPluginConfigResponse = undefined;
    this.selectedPluginsResponse = undefined;
    this.savedMessage = "";
  }

  private resetPackageStateForTargetChange(): void {
    const hadPackageOperation = this.packageOperation !== undefined;
    this.packageLoadRequestSeq += 1;
    this.packageMutationSeq += 1;
    this.packageLoading = false;
    this.packageOperation = undefined;
    this.packageMessage = "";
    this.packageError = "";
    this.packagesResponse = undefined;
    if (hadPackageOperation) this.saving = false;
  }

  private showSavedMessage(message: string, section: SettingsSection): void {
    this.savedMessage = message;
    this.savedSection = section;
    if (this.savedMessageTimer !== undefined) window.clearTimeout(this.savedMessageTimer);
    this.savedMessageTimer = window.setTimeout(() => {
      this.savedMessage = "";
      this.savedMessageTimer = undefined;
    }, 3000);
  }

  static override styles = [uiDialogStyles, uiSelectionStyles, css`
    @layer pi-web-base {
    :host { position: fixed; inset: 0; color: var(--pi-text); font: 14px var(--pi-font, system-ui, sans-serif); }
    modal-surface { --modal-surface-backdrop-padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); --modal-surface-width: min(980px, 100%); --modal-surface-max-height: min(760px, 100%); --modal-surface-min-height: min(620px, 100%); --modal-surface-radius: 14px; }
    .settings-machine { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 18px; border-bottom: 1px solid var(--pi-border); }
    .settings-machine label { font-size: 12px; font-weight: 700; }
    .settings-machine select { flex: 1 1 160px; max-width: 280px; background: var(--pi-bg); }
    .machine-status { color: var(--pi-muted); line-height: 1.35; }
    .machine-status.unavailable { color: var(--pi-warning); }
    .machine-scope { color: var(--pi-muted); font-size: 12px; }
    .machine-scope summary { cursor: pointer; }
    .machine-scope[open] { flex-basis: 100%; }
    .machine-scope p { margin: 8px 0 0; line-height: 1.45; }
    .machine-connection-error { flex-basis: 100%; margin: 0; font-size: 12px; line-height: 1.45; color: var(--pi-warning); overflow-wrap: anywhere; }
    .machine-scope summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .machine-switch-confirmation { flex: 0 0 auto; padding: 12px 16px; border-bottom: 1px solid var(--pi-warning-border); background: var(--pi-warning-surface); }
    .machine-switch-confirmation p { margin: 0 0 8px; }
    .machine-switch-confirmation button + button { margin-inline-start: 8px; }
    .settings-body { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 220px minmax(0, 1fr); }
    .settings-nav { min-height: 0; border-right: 1px solid var(--pi-border); background: var(--pi-surface); overflow: auto; }
    .settings-nav button { display: grid; justify-content: stretch; gap: 2px; }
    .settings-nav small { color: var(--pi-muted); }
    .settings-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    .settings-content { flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto; padding: 0; }

    @media (max-width: 760px) {
      modal-surface { --modal-surface-backdrop-padding: 0; --modal-surface-place-items: stretch; --modal-surface-width: 100%; --modal-surface-max-height: none; --modal-surface-min-height: 0; --modal-surface-border: 0; --modal-surface-radius: 0; }
      .settings-header { padding-top: env(safe-area-inset-top); }
      .settings-machine { padding: 10px 12px; }
      .settings-machine label { flex-basis: 100%; }
      .settings-machine select { max-width: none; }
      .machine-scope { flex-basis: 100%; }
      .settings-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
      .settings-nav { display: flex; gap: 0; padding: 0; border-right: 0; border-bottom: 1px solid var(--pi-border); overflow-x: auto; overflow-y: hidden; }
      .settings-nav button { flex: 0 0 auto; width: auto; white-space: nowrap; border-inline-end: 1px solid var(--pi-border-muted); }
      .settings-nav small { display: none; }
      .settings-content { padding-bottom: env(safe-area-inset-bottom); }
    }
    }
  `];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type SettingsPanelTag =
  | "settings-general-panel"
  | "settings-sessiond-panel"
  | "settings-packages-panel"
  | "settings-plugins-panel"
  | "settings-mcp-panel"
  | "settings-shortcuts-panel";

/**
 * The single custom-element panel the settings dialog renders for a section.
 *
 * This is the public routing contract behind `renderActiveSection`: each section
 * maps to exactly one panel element and nothing else (no per-tab "scope note"
 * wrapper). Tests assert this mapping instead of inspecting the rendered
 * `TemplateResult`'s markup.
 */
export function activeSettingsPanelTag(section: SettingsSection): SettingsPanelTag {
  switch (section) {
    case "sessiond":
      return "settings-sessiond-panel";
    case "packages":
      return "settings-packages-panel";
    case "plugins":
      return "settings-plugins-panel";
    case "mcp":
      return "settings-mcp-panel";
    case "shortcuts":
      return "settings-shortcuts-panel";
    case "general":
      return "settings-general-panel";
  }
}
