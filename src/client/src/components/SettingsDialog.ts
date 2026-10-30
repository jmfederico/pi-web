import { stylesheetIntegrationCapability } from "../plugins/styles";
import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { cache } from "lit/directives/cache.js";
import { live } from "lit/directives/live.js";
import type { AppAction } from "../actions";
import { loadThemeCatalog, type BrowserThemeCatalog } from "../themeCatalog";
import { configApi, piPackagesApi, pluginsApi, type Machine, type MachineHealth, type MachineRuntime, type SessionModel, type PiPackageMutationResponse, type PiPackageScope, type PiPackagesResponse, type PiWebConfigResponse, type PiWebConfigValues, type PiWebPluginsResponse } from "../api";
import type { McpAuthContext, McpAuthHandler } from "./settings/SettingsMcpPanel";
import "./settings/SettingsMcpPanel";
import type { SettingsSection } from "../settingsRoute";
import "./ModalSurface";
import type { ModalSurface } from "./ModalSurface";
import { uiDialogStyles, uiSelectionStyles } from "./ui/dialogStyles";
import "./settings/SettingsGeneralPanel";
import type { SettingsGeneralPanel } from "./settings/SettingsGeneralPanel";
import "./settings/SettingsThemePanel";
import type { QualifiedFileIconThemeContribution, QualifiedThemeContribution } from "../plugins/types";
import "./settings/SettingsFileIconThemePanel";
import { configureThemePolicy, DEFAULT_THEME_PREFERENCE, type ThemePreference } from "../theme";
import "./settings/SettingsSessiondPanel";
import "./settings/SettingsPackagesPanel";
import "./settings/SettingsPluginsPanel";
import "./settings/SettingsShortcutsPanel";
import { piPackagesResponseAfterMutation, shouldRefreshGatewayPluginsAfterPiPackageMutation, type PiPackageOperationState, type PiPackageTargetContext } from "./settings/piPackageSettings";
import { loadGatewaySettingsData, loadPiPackagesData } from "./settings/settingsDataLoading";
import { mergeSelectedMachineAccessConfig } from "./settings/settingsMachineAccessConfig";
import { isSelectedMachineSettingsUnsupported, pluginLifecycleSupport, selectedMachineSettingsSupportKey, settingsMachineTarget, type PluginLifecycleSupport, type SettingsMachineTarget } from "./settings/settingsMachineTarget";
import { mergeSelectedMachinePluginConfig } from "./settings/settingsPluginConfig";
import { enforcedSetting, explicitConfigUpdate, resetConfigUpdate, settingPath } from "./settings/settingsConfigUpdate";
import { mergeSelectedMachineSessiondConfig } from "./settings/settingsSessiondConfig";
import { configureLocalizationPolicy, LocalizationController, localization } from "../localization/browser";
import source from "./settingsDialog.messages";
import { settingsFeedbackTargetLabel, settingsFeedbackLifecycleUnavailable, settingsFeedbackSelectedError, settingsFeedbackPackageError, settingsFeedbackPackageFollowUp } from "./settings/settingsFeedback";

export const settingsDialogMessages = localization.registerMessages("core.settingsDialog", source);
type DisplayText = string | (() => string);
const displayText = (value: DisplayText): string => typeof value === "function" ? value() : value;

@customElement("settings-dialog")
export class SettingsDialog extends LitElement {
  constructor() {
    super();
    new LocalizationController(this);
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) section: SettingsSection = "general";
  @property({ attribute: false }) actions: AppAction[] = [];
  @property({ attribute: false }) themes: readonly QualifiedThemeContribution[] = [];
  @property({ attribute: false }) onThemeCatalogLoaded: (catalog: BrowserThemeCatalog) => void = () => undefined;
  @state() private themeCatalogLoading = false;
  @state() private themeCatalogError = "";
  private themeCatalogRequested = false;
  @property({ attribute: false }) fileIconThemes: readonly QualifiedFileIconThemeContribution[] = [];
  @property({ attribute: false }) fileIconPreference: string | undefined;
  @property({ attribute: false }) onSelectFileIconTheme?: (id: string) => void;
  @property({ attribute: false }) onResetFileIconTheme?: () => void;
  @property({ attribute: false }) themePreference: ThemePreference = DEFAULT_THEME_PREFERENCE;
  @property() activeThemeId = "";
  @property({ type: Boolean }) hasLocalThemeOverride = false;
  @property({ attribute: false }) onUseLocalTheme?: (preference: ThemePreference) => void;
  @property({ attribute: false }) onUseDefaultTheme?: () => void;
  @property({ attribute: false }) mcpContext: McpAuthContext | undefined;
  @property({ attribute: false }) onMcpAuth?: McpAuthHandler;
  @property({ attribute: false }) machine: Machine | undefined;
  @property({ attribute: false }) machineRuntime: MachineRuntime | undefined;
  @property({ attribute: false }) machines: Machine[] = [];
  @property({ attribute: false }) machineStatuses: Record<string, MachineHealth> = {};
  @property({ attribute: false }) machineRuntimes: Record<string, MachineRuntime> = {};
  @state() private settingsMachineId: string | undefined;
  @state() private pendingMachineId: string | undefined;
  private generalPanel: SettingsGeneralPanel | undefined;
  @property({ attribute: false }) onNavigate?: (section: SettingsSection) => void;
  @property({ attribute: false }) onClose?: () => void;
  @property({ attribute: false }) onMachineConfigSaved?: (machineId: string) => void;
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
  @state() private namingModelsErrorPresentation: DisplayText = "";
  private get namingModelsError(): string { return displayText(this.namingModelsErrorPresentation); }
  private set namingModelsError(value: DisplayText) { this.namingModelsErrorPresentation = value; }
  @state() private pluginLoading = true;
  @state() private packageLoading = true;
  @state() private saving = false;
  @state() private packageOperation: PiPackageOperationState | undefined;
  @state() private errorPresentation: DisplayText = "";
  private get error(): string { return displayText(this.errorPresentation); }
  private set error(value: DisplayText) { this.errorPresentation = value; }
  @state() private accessErrorPresentation: DisplayText = "";
  private get accessError(): string { return displayText(this.accessErrorPresentation); }
  private set accessError(value: DisplayText) { this.accessErrorPresentation = value; }
  @state() private sessiondErrorPresentation: DisplayText = "";
  private get sessiondError(): string { return displayText(this.sessiondErrorPresentation); }
  private set sessiondError(value: DisplayText) { this.sessiondErrorPresentation = value; }
  @state() private pluginErrorPresentation: DisplayText = "";
  private get pluginError(): string { return displayText(this.pluginErrorPresentation); }
  private set pluginError(value: DisplayText) { this.pluginErrorPresentation = value; }
  @state() private packageErrorPresentation: DisplayText = "";
  private get packageError(): string { return displayText(this.packageErrorPresentation); }
  private set packageError(value: DisplayText) { this.packageErrorPresentation = value; }
  @state() private savedMessagePresentation: DisplayText = "";
  private get savedMessage(): string { return displayText(this.savedMessagePresentation); }
  private set savedMessage(value: DisplayText) { this.savedMessagePresentation = value; }
  @state() private savedSection: SettingsSection | undefined;
  @state() private packageMessagePresentation: DisplayText = "";
  private get packageMessage(): string { return displayText(this.packageMessagePresentation); }
  private set packageMessage(value: DisplayText) { this.packageMessagePresentation = value; }
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
    this.loadThemeCatalogForGeneral();
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
      this.loadThemeCatalogForGeneral();
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

  private loadThemeCatalogForGeneral(): void {
    if (this.isConnected && this.section === "general" && !this.themeCatalogRequested) void this.loadThemeInventory();
  }

  private async loadThemeInventory(): Promise<void> {
    if (this.themeCatalogLoading) return;
    this.themeCatalogRequested = true;
    this.themeCatalogLoading = true;
    this.themeCatalogError = "";
    try {
      const catalog = await loadThemeCatalog();
      if (this.isConnected) this.onThemeCatalogLoaded(catalog);
    } catch (error) {
      if (this.isConnected) this.themeCatalogError = error instanceof Error ? error.message : String(error);
    } finally {
      this.themeCatalogLoading = false;
    }
  }

  override render(): TemplateResult {
    return html`
      <modal-surface .onClose=${() => this.onClose?.()} .label=${settingsDialogMessages.t("label")}>
        <header class="settings-header ui-dialog-header">
          <h1 class="ui-dialog-title">${settingsDialogMessages.t("heading")}</h1>
          <button class="close-button ui-button ui-button--icon" title=${settingsDialogMessages.t("close")} aria-label=${settingsDialogMessages.t("close")} @click=${() => this.onClose?.()}>×</button>
        </header>
        <div class="settings-body">
          <nav class="settings-nav" aria-label=${settingsDialogMessages.t("sections")}>
            ${this.renderNavButton("general", settingsDialogMessages.t("general"), settingsDialogMessages.t("generalDetail"))}
            ${this.renderNavButton("sessiond", settingsDialogMessages.t("sessiond"), settingsDialogMessages.t("selectedMachine"))}
            ${this.renderNavButton("packages", settingsDialogMessages.t("packages"), settingsDialogMessages.t("selectedMachine"))}
            ${this.renderNavButton("plugins", settingsDialogMessages.t("plugins"), settingsDialogMessages.t("selectedMachine"))}
            ${this.renderNavButton("mcp", settingsDialogMessages.t("mcp"), settingsDialogMessages.t("selectedSession"))}
            ${this.renderNavButton("shortcuts", settingsDialogMessages.t("shortcuts"), settingsDialogMessages.t("gateway"))}
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
    const statusLabel = settingsDialogMessages.t(status === "online" ? "connected" : status === "unknown" ? "unchecked" : "unavailable");
    const unavailable = status === "offline" || status === "error";
    const statusMessage = unavailable ? health?.error ?? machine?.statusMessage ?? runtime?.error : undefined;
    return html`
      <div class="settings-machine">
        <label for="settings-machine">${settingsDialogMessages.t("configure")}</label>
        <select class="ui-select" id="settings-machine" aria-describedby=${unavailable ? "settings-machine-help settings-machine-status settings-machine-error" : "settings-machine-help settings-machine-status"} .value=${live(target.id)} ?disabled=${this.saving} @change=${(event: Event) => {
          if (event.target instanceof HTMLSelectElement) this.requestMachineSwitch(event.target.value);
        }}>
          ${this.machines.map((candidate) => html`<option value=${candidate.id}>${settingsDialogMessages.t("machineOption", { name: candidate.name, kind: candidate.kind })}</option>`)}
        </select>
        <small id="settings-machine-status" class=${unavailable ? "machine-status unavailable" : "machine-status"} role="status">${statusLabel}</small>
        <details class="machine-scope">
          <summary>${settingsDialogMessages.t("scopeHeading")}</summary>
          <p id="settings-machine-help">${settingsDialogMessages.t("scopeHelp")}</p>
        </details>
        ${unavailable ? html`<p id="settings-machine-error" class="machine-connection-error" role="status"><span dir="auto">${statusMessage ?? settingsDialogMessages.t("machineUnavailable")}</span><br>${settingsDialogMessages.t("connectionHelp")}</p>` : null}
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
      <section class="machine-switch-confirmation" role="alert" aria-label=${settingsDialogMessages.t("unsaved")}>
        <p>${settingsDialogMessages.t("switchPrompt", { current: this.settingsTarget().name, next: pending.name })}</p>
        <button class="ui-button ui-button--action danger" ?disabled=${this.saving} @click=${() => { this.generalPanel?.discardMachineChanges(); this.switchSettingsMachine(pending.id); }}>${settingsDialogMessages.t("discard")}</button>
        <button class="ui-button ui-button--action" @click=${() => { this.pendingMachineId = undefined; }}>${settingsDialogMessages.t("keepEditing")}</button>
      </section>
    `;
  }

  private renderActiveSection(): TemplateResult {
    if (this.section === "mcp") {
      const target = this.settingsTarget();
      return html`
        <settings-mcp-panel
          .context=${this.mcpContext?.machineId === target.id ? this.mcpContext : undefined}
          .targetLabel=${settingsFeedbackTargetLabel(target)}
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
          .targetLabel=${settingsFeedbackTargetLabel(this.settingsTarget())}
          .targetId=${this.settingsTarget().id}
          .onReload=${() => this.reloadSessiondState()}
          .onSave=${(config: PiWebConfigValues, unset?: string[]) => this.saveSessiondConfig(config, unset)}
          .onReset=${(paths: string[]) => this.saveSessiondConfig({}, paths)}
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
          .onReset=${(paths: string[]) => this.saveConfig({}, paths)}
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
          .targetLabel=${settingsFeedbackTargetLabel(this.settingsTarget())}
          .onReload=${() => this.loadPluginsForTarget()}
          .onTogglePlugin=${(pluginId: string, enabled: boolean) => this.togglePlugin(pluginId, enabled)}
          .onResetPlugin=${(pluginId: string) => this.togglePlugin(pluginId)}
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
        .targetLabel=${settingsFeedbackTargetLabel(this.settingsTarget())}
        .targetId=${this.settingsTarget().id}
        .onReload=${() => this.loadConfig()}
        .onReloadMachine=${() => this.loadAccessConfigForTarget()}
        .onSave=${(config: PiWebConfigValues, unset?: string[]) => this.saveConfig(config, unset)}
        .onReset=${(paths: string[]) => this.saveConfig({}, paths)}
        .onResetMachine=${(paths: string[]) => this.saveMachineAccessConfig({}, paths)}
        .onSetQuietMode=${(quietMode: boolean) => this.saveQuietMode(quietMode)}
        .onSaveMachineConfig=${(config: PiWebConfigValues, unset?: string[]) => this.saveMachineAccessConfig(config, unset)}
      >
        <settings-theme-panel
          slot="appearance"
          .themes=${this.themes}
          .catalogLoading=${this.themeCatalogLoading}
          .catalogError=${this.themeCatalogError}
          .onRetryCatalog=${() => this.loadThemeInventory()}
          .configResponse=${this.configResponse}
          .onReset=${(paths: string[]) => this.saveConfig({}, paths)}
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
        <settings-file-icon-theme-panel
          slot="appearance"
          .themes=${this.fileIconThemes}
          .preference=${this.fileIconPreference}
          .onSelect=${this.onSelectFileIconTheme}
          .onReset=${this.onResetFileIconTheme}
        ></settings-file-icon-theme-panel>
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

  private publishGatewayConfig(response: PiWebConfigResponse): void {
    configureThemePolicy(response);
    void configureLocalizationPolicy(response).catch((error: unknown) => {
      console.warn("Failed to apply gateway localization policy", error);
    });
    this.onConfigSaved?.(response.effectiveConfig);
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
        this.publishGatewayConfig(result.config);
      }
      if (result.plugins !== undefined) this.pluginsResponse = result.plugins;
      const failure = result.failure;
      this.error = failure === undefined ? "" : () => settingsDialogMessages.t("loadGateway", {
        errors: localization.list([
          ...(failure.config === undefined ? [] : [settingsDialogMessages.t("configDiagnostic", { error: failure.config })]),
          ...(failure.plugins === undefined ? [] : [settingsDialogMessages.t("pluginsDiagnostic", { error: failure.plugins })]),
        ]),
      });
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
        const diagnostic = errorMessage(error);
        this.accessError = () => settingsDialogMessages.t("loadAccess", { target: settingsFeedbackTargetLabel(target), error: settingsFeedbackSelectedError(diagnostic, target) });
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
        const diagnostic = errorMessage(error);
        this.namingModelsError = () => settingsDialogMessages.t("loadModels", { target: settingsFeedbackTargetLabel(target), error: settingsFeedbackSelectedError(diagnostic, target) });
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
        const diagnostic = errorMessage(error);
        this.sessiondError = () => settingsDialogMessages.t("loadSessiond", { target: settingsFeedbackTargetLabel(target), error: settingsFeedbackSelectedError(diagnostic, target) });
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
          this.pluginError = () => settingsFeedbackLifecycleUnavailable(target);
        } catch (error) {
          if (!this.isCurrentPluginLoad(requestSeq, target)) return;
          const diagnostic = errorMessage(error);
          this.pluginError = () => settingsDialogMessages.t("loadPluginConfigUnsupported", {
            target: settingsFeedbackTargetLabel(target), error: settingsFeedbackSelectedError(diagnostic, target),
            support: settingsFeedbackLifecycleUnavailable(target),
          });
        }
        return;
      }

      const [config, plugins] = await Promise.allSettled([configApi.config(target.id), pluginsApi.plugins(target.id)]);
      if (!this.isCurrentPluginLoad(requestSeq, target)) return;

      const errors: (() => string)[] = [];
      if (config.status === "fulfilled") this.selectedPluginConfigResponse = config.value;
      else errors.push(() => settingsDialogMessages.t("configDiagnostic", { error: settingsFeedbackSelectedError(errorMessage(config.reason), target) }));

      if (plugins.status === "fulfilled") this.selectedPluginsResponse = plugins.value;
      else errors.push(() => settingsDialogMessages.t("pluginsDiagnostic", { error: settingsFeedbackSelectedError(errorMessage(plugins.reason), target) }));

      this.pluginError = errors.length === 0 ? "" : () => settingsDialogMessages.t("loadPluginSettings", { target: settingsFeedbackTargetLabel(target), errors: localization.list(errors.map((error) => error())) });
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
      const failure = result.failure;
      this.packageError = failure === undefined ? "" : () => settingsDialogMessages.t("loadPackages", { target: settingsFeedbackTargetLabel(target), error: settingsFeedbackPackageError(failure, target) });
    } finally {
      if (this.isCurrentPackageLoad(requestSeq, target)) this.packageLoading = false;
    }
  }

  private async togglePlugin(pluginId: string, enabled?: boolean): Promise<void> {
    if (this.saving) return;
    const target = this.settingsTarget();
    const lifecycleSupport = this.pluginLifecycleSupport(target);
    if (this.selectedPluginConfigResponse === undefined) {
      this.pluginError = () => settingsDialogMessages.t("pluginConfigMissing", { target: settingsFeedbackTargetLabel(target) });
      return;
    }
    const path = settingPath("plugins", pluginId, "enabled");
    if (enforcedSetting(this.selectedPluginConfigResponse, path) !== undefined) return;
    const update = enabled === undefined
      ? resetConfigUpdate(this.selectedPluginConfigResponse, [path])
      : { set: { plugins: { [pluginId]: { enabled } } } };
    this.saving = true;
    this.pluginError = "";
    this.savedMessage = "";
    try {
      const response = await configApi.updateConfig(update, target.id);
      if (!this.isCurrentSettingsTarget(target)) return;
      this.selectedPluginConfigResponse = response;
      if (target.kind === "local" && this.configResponse !== undefined) {
        this.configResponse = mergeSelectedMachinePluginConfig(this.configResponse, response);
        this.publishGatewayConfig(this.configResponse);
      }
      let pluginRefreshError: DisplayText | undefined;
      if (isSelectedMachineSettingsUnsupported(lifecycleSupport)) {
        this.selectedPluginsResponse = undefined;
        pluginRefreshError = () => settingsFeedbackLifecycleUnavailable(target);
      } else {
        pluginRefreshError = await this.refreshPluginsForTarget(target);
      }
      if (!this.isCurrentSettingsTarget(target)) return;
      if (pluginRefreshError !== undefined) this.pluginError = pluginRefreshError;
      this.showSavedMessage(() => settingsDialogMessages.t("pluginsSaved", { name: target.name }), "plugins");
    } catch (error) {
      if (this.isCurrentSettingsTarget(target)) {
        const diagnostic = errorMessage(error);
        this.pluginError = () => settingsDialogMessages.t("savePlugins", { target: settingsFeedbackTargetLabel(target), error: settingsFeedbackSelectedError(diagnostic, target) });
      }
    } finally {
      this.saving = false;
    }
  }

  private async saveConfig(config: PiWebConfigValues, unset: string[] = []): Promise<void> {
    if (this.saving) return;
    const section = this.section === "shortcuts" ? "shortcuts" : "general";
    this.loadRequestSeq += 1;
    this.loading = false;
    this.saving = true;
    this.error = "";
    this.savedMessage = "";
    try {
      const response = await configApi.updateConfig({ ...explicitConfigUpdate(this.configResponse, config), ...resetConfigUpdate(this.configResponse, unset) });
      this.configResponse = response;
      this.publishGatewayConfig(response);
      this.showSavedMessage(() => section === "shortcuts" ? settingsDialogMessages.t("shortcutsSaved")
        : unset.length === 1 && unset[0] === "/defaultTheme" ? settingsDialogMessages.t("themeSaved")
        : unset.length === 1 && unset[0] === "/quietMode" ? settingsDialogMessages.t("quietSaved", { enabled: String(response.effectiveConfig.quietMode === true) })
        : settingsDialogMessages.t("gatewaySaved"), section);
    } catch (error) {
      const diagnostic = errorMessage(error);
      this.error = () => settingsDialogMessages.t("settingsFailure", { error: diagnostic });
    } finally {
      this.saving = false;
    }
  }

  private async saveDefaultTheme(preference: ThemePreference): Promise<void> {
    await this.saveFocusedGatewayConfig({ defaultTheme: preference }, () => settingsDialogMessages.t("themeSaved"), "themeFailure");
  }

  private async saveQuietMode(quietMode: boolean): Promise<void> {
    await this.saveFocusedGatewayConfig({ quietMode }, () => settingsDialogMessages.t("quietSaved", { enabled: String(quietMode) }), "quietFailure");
  }

  /** PATCH changes supplied settings only; retire older refreshes before saving. */
  private async saveFocusedGatewayConfig(patch: PiWebConfigValues, savedMessage: DisplayText, failure: "themeFailure" | "quietFailure"): Promise<void> {
    if (this.saving) return;
    this.loadRequestSeq += 1;
    this.loading = false;
    this.saving = true;
    this.error = "";
    this.savedMessage = "";
    try {
      const response = await configApi.updateConfig(explicitConfigUpdate(this.configResponse, patch));
      this.configResponse = response;
      this.publishGatewayConfig(response);
      this.showSavedMessage(savedMessage, "general");
    } catch (error) {
      const diagnostic = errorMessage(error);
      this.error = () => settingsDialogMessages.t(failure, { error: diagnostic });
    } finally {
      this.saving = false;
    }
  }

  private async saveMachineAccessConfig(config: PiWebConfigValues, unset: string[] = []): Promise<void> {
    if (this.saving) return;
    const target = this.settingsTarget();
    this.accessLoadRequestSeq += 1;
    this.accessLoading = false;
    if (target.kind === "local") {
      this.loadRequestSeq += 1;
      this.loading = false;
    }
    this.saving = true;
    this.accessError = "";
    this.savedMessage = "";
    try {
      const response = await configApi.updateConfig({ ...explicitConfigUpdate(this.accessConfigResponse, config), ...resetConfigUpdate(this.accessConfigResponse, unset) }, target.id);
      // The save belongs to its captured target even if the dialog has moved on.
      // Notify the owner, but never install that response into another target's draft.
      this.onMachineConfigSaved?.(target.id);
      if (target.kind === "local") {
        // The gateway snapshot is not owned by the current settings target.
        // Retire older loads so a later gateway save cannot restore the old name.
        this.loadRequestSeq += 1;
        this.loading = false;
        if (this.configResponse !== undefined) {
          this.configResponse = mergeSelectedMachineAccessConfig(this.configResponse, response);
          this.publishGatewayConfig(this.configResponse);
        }
      }
      if (!this.isCurrentSettingsTarget(target)) return;
      this.accessLoadRequestSeq += 1;
      this.accessLoading = false;
      this.accessConfigResponse = response;
      this.showSavedMessage(() => settingsDialogMessages.t("machineSaved", { name: target.name }), "general");
    } catch (error) {
      if (this.isCurrentSettingsTarget(target)) {
        const diagnostic = errorMessage(error);
        this.accessError = () => settingsDialogMessages.t("saveAccess", { target: settingsFeedbackTargetLabel(target), error: settingsFeedbackSelectedError(diagnostic, target) });
      }
    } finally {
      this.saving = false;
    }
  }

  private async saveSessiondConfig(config: PiWebConfigValues, unset: string[] = []): Promise<void> {
    if (this.saving) return;
    const target = this.settingsTarget();
    this.sessiondLoadRequestSeq += 1;
    this.sessiondLoading = false;
    this.saving = true;
    this.sessiondError = "";
    this.savedMessage = "";
    try {
      const response = await configApi.updateConfig({ ...explicitConfigUpdate(this.sessiondConfigResponse, config), ...resetConfigUpdate(this.sessiondConfigResponse, unset) }, target.id);
      if (!this.isCurrentSettingsTarget(target)) return;
      this.sessiondConfigResponse = response;
      if (target.kind === "local" && this.configResponse !== undefined) this.configResponse = mergeSelectedMachineSessiondConfig(this.configResponse, response);
      const changedPaths = [...Object.keys(config).map((key) => `/${key}`), ...unset];
      const namingOnly = changedPaths.length > 0 && changedPaths.every((path) => path === "/sessionNaming" || path.startsWith("/sessionNaming/"));
      const message = () => namingOnly
        ? settingsDialogMessages.t("namingSaved", { name: target.name })
        : settingsDialogMessages.t("sessiondSaved", { name: target.name, naming: String(config.sessionNaming !== undefined) });
      this.showSavedMessage(message, "sessiond");
    } catch (error) {
      if (this.isCurrentSettingsTarget(target)) {
        const diagnostic = errorMessage(error);
        this.sessiondError = () => settingsDialogMessages.t("saveSessiond", { target: settingsFeedbackTargetLabel(target), error: settingsFeedbackSelectedError(diagnostic, target) });
      }
    } finally {
      this.saving = false;
    }
  }

  private async installPiPackage(source: string): Promise<void> {
    const target = this.packageTarget();
    await this.runPiPackageMutation({ kind: "install", source }, target, () => piPackagesApi.install(source, target.id));
  }

  private async removePiPackage(source: string, scope: PiPackageScope): Promise<void> {
    const target = this.packageTarget();
    await this.runPiPackageMutation({ kind: "remove", source }, target, () => piPackagesApi.remove(source, scope, target.id));
  }

  private async updatePiPackage(source?: string): Promise<void> {
    const target = this.packageTarget();
    await this.runPiPackageMutation(source === undefined ? { kind: "update-all" } : { kind: "update", source }, target, () => piPackagesApi.update(source, target.id));
  }

  private async runPiPackageMutation(operation: PiPackageOperationState, target: PiPackageTargetContext, mutate: () => Promise<PiPackageMutationResponse>): Promise<void> {
    if (this.saving) throw new Error(settingsDialogMessages.t("operationRunning"));
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
      this.packageMessage = () => settingsFeedbackPackageFollowUp(response.action, target);
    } catch (error) {
      if (this.isCurrentPackageMutation(requestSeq, target)) {
        const diagnostic = errorMessage(error);
        this.packageError = () => settingsDialogMessages.t("packageMutationFailure", { operation: operation.kind, target: settingsFeedbackTargetLabel(target), error: settingsFeedbackPackageError(diagnostic, target) });
      }
      throw error;
    } finally {
      if (this.packageMutationSeq === requestSeq) {
        this.packageOperation = undefined;
        this.saving = false;
      }
    }
  }

  private async refreshGatewayPlugins(): Promise<DisplayText | undefined> {
    try {
      this.pluginsResponse = await pluginsApi.plugins();
      return undefined;
    } catch (error) {
      const diagnostic = errorMessage(error);
      return () => settingsDialogMessages.t("refreshGatewayFailure", { error: diagnostic });
    }
  }

  private async refreshPluginsForTarget(target: SettingsMachineTarget): Promise<DisplayText | undefined> {
    try {
      const response = await pluginsApi.plugins(target.id);
      if (this.isCurrentSettingsTarget(target)) this.selectedPluginsResponse = response;
      return undefined;
    } catch (error) {
      if (this.isCurrentSettingsTarget(target)) this.selectedPluginsResponse = undefined;
      const diagnostic = errorMessage(error);
      return () => settingsDialogMessages.t("refreshPluginsFailure", { target: settingsFeedbackTargetLabel(target), error: settingsFeedbackSelectedError(diagnostic, target) });
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

  private showSavedMessage(message: DisplayText, section: SettingsSection): void {
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
    .settings-nav { min-height: 0; border-inline-end: 1px solid var(--pi-border); background: var(--pi-surface); overflow: auto; }
    .settings-nav button { display: grid; justify-content: stretch; gap: 2px; }
    .settings-machine, .machine-switch-confirmation, .settings-nav button { overflow-wrap: anywhere; }
    .settings-machine select { min-width: 0; }
    .settings-nav strong, .settings-nav small { min-width: 0; }
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
      .settings-nav { display: flex; gap: 0; padding: 0; border-inline-end: 0; border-bottom: 1px solid var(--pi-border); overflow-x: auto; overflow-y: hidden; }
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
