import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AppAction } from "../actions";
import { configApi, piPackagesApi, pluginsApi, type Machine, type PiPackageMutationResponse, type PiPackageScope, type PiPackagesResponse, type PiWebConfigResponse, type PiWebConfigValues, type PiWebPluginsResponse } from "../api";
import type { SettingsSection } from "../settingsRoute";
import "./settings/SettingsGeneralPanel";
import "./settings/SettingsSessiondPanel";
import "./settings/SettingsPackagesPanel";
import "./settings/SettingsPluginsPanel";
import "./settings/SettingsShortcutsPanel";
import { friendlyPiPackageErrorMessage, piPackageMutationFollowUpMessage, piPackageTargetContext, piPackageTargetLabel, shouldRefreshGatewayPluginsAfterPiPackageMutation, type PiPackageOperationState, type PiPackageTargetContext } from "./settings/piPackageSettings";

@customElement("settings-dialog")
export class SettingsDialog extends LitElement {
  @property({ attribute: false }) section: SettingsSection = "general";
  @property({ attribute: false }) actions: AppAction[] = [];
  @property({ attribute: false }) machine: Machine | undefined;
  @property({ attribute: false }) onNavigate?: (section: SettingsSection) => void;
  @property({ attribute: false }) onClose?: () => void;
  @property({ attribute: false }) onConfigSaved?: (config: PiWebConfigValues) => void;
  @state() private configResponse: PiWebConfigResponse | undefined;
  @state() private pluginsResponse: PiWebPluginsResponse | undefined;
  @state() private packagesResponse: PiPackagesResponse | undefined;
  @state() private loading = true;
  @state() private saving = false;
  @state() private packageOperation: PiPackageOperationState | undefined;
  @state() private error = "";
  @state() private packageError = "";
  @state() private savedMessage = "";
  @state() private packageMessage = "";
  private savedMessageTimer: number | undefined;
  private loadRequestSeq = 0;
  private packageMutationSeq = 0;
  private lastRequestedPackageTargetId: string | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.loadConfig();
  }

  override disconnectedCallback(): void {
    if (this.savedMessageTimer !== undefined) window.clearTimeout(this.savedMessageTimer);
    this.savedMessageTimer = undefined;
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!changed.has("machine")) return;
    const previousTarget = piPackageTargetContext(changed.get("machine"));
    const currentTarget = this.packageTarget();
    if (previousTarget.id === currentTarget.id) return;
    this.resetPackageStateForTargetChange();
    if (this.isConnected && this.lastRequestedPackageTargetId !== currentTarget.id) void this.loadConfig();
  }

  override render(): TemplateResult {
    return html`
      <div class="backdrop" @mousedown=${() => this.onClose?.()}>
        <section class="settings-shell" role="dialog" aria-modal="true" aria-label="PI WEB settings" @mousedown=${(event: MouseEvent) => { event.stopPropagation(); }} @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}>
          <header class="settings-header">
            <div>
              <span class="eyebrow">Settings</span>
              <h1>PI WEB</h1>
            </div>
            <button class="close-button" title="Close settings" aria-label="Close settings" @click=${() => this.onClose?.()}>×</button>
          </header>
          <div class="settings-body">
            <nav class="settings-nav" aria-label="Settings sections">
              ${this.renderNavButton("general", "General", "Gateway config")}
              ${this.renderNavButton("sessiond", "Session daemon", "Gateway runtime")}
              ${this.renderNavButton("packages", "Pi packages", "Selected machine")}
              ${this.renderNavButton("plugins", "PI WEB plugins", "Gateway plugins")}
              ${this.renderNavButton("shortcuts", "Keyboard", "Gateway shortcuts")}
            </nav>
            <main class="settings-content">
              ${this.renderScopeNote()}
              ${this.renderActiveSection()}
            </main>
          </div>
        </section>
      </div>
    `;
  }

  private renderActiveSection(): TemplateResult {
    if (this.section === "sessiond") {
      return html`
        <settings-sessiond-panel
          .configResponse=${this.configResponse}
          .loading=${this.loading}
          .saving=${this.saving}
          .error=${this.error}
          .savedMessage=${this.savedMessage}
          .onReload=${() => this.loadConfig()}
          .onSave=${(config: PiWebConfigValues) => this.saveConfig(config)}
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
          .savedMessage=${this.savedMessage}
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
          .loading=${this.loading}
          .operation=${this.packageOperation}
          .error=${this.packageError}
          .operationMessage=${this.packageMessage}
          .onReload=${() => this.loadConfig()}
          .onInstallPackage=${(source: string) => this.installPiPackage(source)}
          .onRemovePackage=${(source: string, scope: PiPackageScope) => this.removePiPackage(source, scope)}
          .onUpdatePackage=${(source?: string) => this.updatePiPackage(source)}
        ></settings-packages-panel>
      `;
    }
    if (this.section === "plugins") {
      return html`
        <settings-plugins-panel
          .configResponse=${this.configResponse}
          .pluginsResponse=${this.pluginsResponse}
          .loading=${this.loading}
          .saving=${this.saving}
          .error=${this.error}
          .savedMessage=${this.savedMessage}
          .onReload=${() => this.loadConfig()}
          .onTogglePlugin=${(pluginId: string, enabled: boolean) => this.togglePlugin(pluginId, enabled)}
        ></settings-plugins-panel>
      `;
    }
    return html`
      <settings-general-panel
        .configResponse=${this.configResponse}
        .loading=${this.loading}
        .saving=${this.saving}
        .error=${this.error}
        .savedMessage=${this.savedMessage}
        .onReload=${() => this.loadConfig()}
        .onSave=${(config: PiWebConfigValues) => this.saveConfig(config)}
      ></settings-general-panel>
    `;
  }

  private renderNavButton(section: SettingsSection, label: string, detail: string): TemplateResult {
    const selected = this.section === section;
    return html`
      <button class=${selected ? "selected" : ""} aria-current=${selected ? "page" : "false"} @click=${() => { this.navigate(section); }}>
        <strong>${label}</strong>
        <small>${detail}</small>
      </button>
    `;
  }

  private renderScopeNote(): TemplateResult {
    return html`
      <div class="scope-note" role="note">
        <strong>This tab edits:</strong> ${this.settingsScopeMessage()}
      </div>
    `;
  }

  private settingsScopeMessage(): string {
    if (this.section === "packages") return `Selected machine packages: ${piPackageTargetLabel(this.packageTarget())}.`;
    if (this.section === "sessiond") return "Local gateway session-daemon config.";
    if (this.section === "plugins") return "Local gateway PI WEB plugin enablement.";
    if (this.section === "shortcuts") return "Local gateway keyboard shortcuts.";
    return "Local gateway config.";
  }

  private navigate(section: SettingsSection): void {
    this.onNavigate?.(section);
  }

  private async loadConfig(): Promise<void> {
    const target = this.packageTarget();
    const requestSeq = ++this.loadRequestSeq;
    this.lastRequestedPackageTargetId = target.id;
    this.loading = true;
    this.error = "";
    this.packageError = "";
    try {
      const [config, plugins, packages] = await Promise.allSettled([configApi.config(), pluginsApi.plugins(), piPackagesApi.packages(target.id)]);
      if (!this.isCurrentLoad(requestSeq, target)) return;

      const errors: string[] = [];
      if (config.status === "fulfilled") this.configResponse = config.value;
      else errors.push(`config: ${errorMessage(config.reason)}`);

      if (plugins.status === "fulfilled") this.pluginsResponse = plugins.value;
      else errors.push(`PI WEB plugins: ${errorMessage(plugins.reason)}`);

      if (packages.status === "fulfilled") this.packagesResponse = packages.value;
      else {
        this.packagesResponse = undefined;
        this.packageError = `Failed to load Pi packages from ${piPackageTargetLabel(target)}: ${friendlyPiPackageErrorMessage(errorMessage(packages.reason), target)}`;
      }

      if (errors.length > 0) this.error = `Failed to load settings: ${errors.join("; ")}`;
    } finally {
      if (this.isCurrentLoad(requestSeq, target)) this.loading = false;
    }
  }

  private async togglePlugin(pluginId: string, enabled: boolean): Promise<void> {
    const baseConfig = this.configResponse?.config ?? {};
    const currentPlugins = baseConfig.plugins ?? {};
    const currentPluginConfig = currentPlugins[pluginId] ?? {};
    await this.saveConfig({
      ...baseConfig,
      plugins: {
        ...currentPlugins,
        [pluginId]: { ...currentPluginConfig, enabled },
      },
    });
    const pluginRefreshError = await this.refreshPlugins();
    if (pluginRefreshError !== undefined) this.error = pluginRefreshError;
  }

  private async saveConfig(config: PiWebConfigValues): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.error = "";
    this.savedMessage = "";
    this.packageMessage = "";
    this.packageError = "";
    try {
      const response = await configApi.saveConfig(config);
      this.configResponse = response;
      this.onConfigSaved?.(response.effectiveConfig);
      this.showSavedMessage();
    } catch (error) {
      this.error = `Failed to save config: ${errorMessage(error)}`;
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
    this.saving = true;
    this.packageOperation = operation;
    this.error = "";
    this.packageError = "";
    this.savedMessage = "";
    this.packageMessage = "";
    try {
      const response = await mutate();
      if (!this.isCurrentPackageMutation(requestSeq, target)) return;
      this.packagesResponse = { packages: response.packages };
      const pluginRefreshError = shouldRefreshGatewayPluginsAfterPiPackageMutation(target) ? await this.refreshPlugins() : undefined;
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

  private async refreshPlugins(): Promise<string | undefined> {
    try {
      this.pluginsResponse = await pluginsApi.plugins();
      return undefined;
    } catch (error) {
      return `Failed to refresh PI WEB plugins: ${errorMessage(error)}`;
    }
  }

  private packageTarget(): PiPackageTargetContext {
    return piPackageTargetContext(this.machine);
  }

  private isCurrentLoad(requestSeq: number, target: PiPackageTargetContext): boolean {
    return requestSeq === this.loadRequestSeq && this.isCurrentPackageTarget(target);
  }

  private isCurrentPackageMutation(requestSeq: number, target: PiPackageTargetContext): boolean {
    return requestSeq === this.packageMutationSeq && this.isCurrentPackageTarget(target);
  }

  private isCurrentPackageTarget(target: PiPackageTargetContext): boolean {
    return this.packageTarget().id === target.id;
  }

  private resetPackageStateForTargetChange(): void {
    const hadPackageOperation = this.packageOperation !== undefined;
    this.packageMutationSeq += 1;
    this.packageOperation = undefined;
    this.packageMessage = "";
    this.packageError = "";
    this.packagesResponse = undefined;
    if (hadPackageOperation) this.saving = false;
  }

  private showSavedMessage(): void {
    this.savedMessage = "Config saved.";
    if (this.savedMessageTimer !== undefined) window.clearTimeout(this.savedMessageTimer);
    this.savedMessageTimer = window.setTimeout(() => {
      if (this.savedMessage === "Config saved.") this.savedMessage = "";
      this.savedMessageTimer = undefined;
    }, 3000);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.onClose?.();
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 30; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    .backdrop { box-sizing: border-box; width: 100%; height: 100dvh; display: grid; place-items: center; padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); background: var(--pi-overlay); overflow: hidden; }
    .settings-shell { width: min(980px, 100%); max-height: min(760px, 100%); min-height: min(620px, 100%); display: grid; grid-template-rows: auto minmax(0, 1fr); border: 1px solid var(--pi-border); border-radius: 14px; background: var(--pi-bg); box-shadow: 0 20px 60px var(--pi-shadow-strong); overflow: hidden; }
    .settings-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--pi-border); }
    .eyebrow { display: block; color: var(--pi-muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 0; font-size: 20px; line-height: 1.2; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; font: inherit; cursor: pointer; }
    .close-button { width: 34px; height: 34px; display: grid; place-items: center; border: 0; background: transparent; color: var(--pi-muted); padding: 0; font-size: 24px; }
    .close-button:hover, .close-button:focus { color: var(--pi-text); background: var(--pi-surface-hover); }
    .settings-body { min-height: 0; display: grid; grid-template-columns: 220px minmax(0, 1fr); }
    .settings-nav { min-height: 0; padding: 10px; border-right: 1px solid var(--pi-border); background: var(--pi-surface); overflow: auto; }
    .settings-nav button { display: grid; gap: 2px; width: 100%; margin: 0 0 6px; text-align: left; border-color: transparent; background: transparent; }
    .settings-nav button:hover, .settings-nav button:focus { background: var(--pi-surface-hover); }
    .settings-nav button.selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .settings-nav small { color: var(--pi-muted); }
    .settings-content { min-width: 0; min-height: 0; overflow: auto; padding: 18px; }
    .scope-note { margin-bottom: 14px; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); color: var(--pi-text); padding: 10px 12px; line-height: 1.45; }

    @media (max-width: 760px) {
      .backdrop { padding: 0; place-items: stretch; }
      .settings-shell { width: 100%; height: 100dvh; max-height: none; min-height: 0; border: 0; border-radius: 0; }
      .settings-header { padding: max(12px, env(safe-area-inset-top)) 12px 12px; }
      .settings-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
      .settings-nav { display: flex; gap: 8px; padding: 8px; border-right: 0; border-bottom: 1px solid var(--pi-border); overflow-x: auto; overflow-y: hidden; }
      .settings-nav button { flex: 0 0 auto; width: auto; min-width: 128px; margin: 0; }
      .settings-content { padding: 14px 12px calc(18px + env(safe-area-inset-bottom)); }
    }
  `;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
