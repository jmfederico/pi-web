import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { LocalizationController, localization } from "../../localization/browser";
import source from "./settingsPlugins.messages";
import type { PiWebConfigResponse, PiWebPluginInfo, PiWebPluginsResponse } from "../../api";
import { PI_WEB_PLUGIN_RECOVERY_COMMANDS } from "../../../../shared/pluginRecoveryCommands";
import { REQUIRED_TERMINAL_PLUGIN_ID } from "../../../../shared/requiredTerminalPlugin";
import { uiButtonStyles } from "../ui/controlStyles";
import { enforcedSetting, settingControls, settingPath } from "./settingsConfigUpdate";
import { uiFormStyles } from "../ui/formStyles";
import { uiSettingsStyles } from "../ui/settingsStyles";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";

export const pluginsMessages = localization.registerMessages("core.settingsPlugins", source);
const strong = (parts: unknown[]): TemplateResult => html`<strong>${parts}</strong>`;
const code = (parts: unknown[]): TemplateResult => html`<code dir="ltr">${parts}</code>`;

export type SettingsPluginRow = PiWebPluginInfo & { configOnly: boolean; editable: boolean };

@customElement("settings-plugins-panel")
export class SettingsPluginsPanel extends LitElement {
  constructor() {
    super();
    new LocalizationController(this);
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) pluginsResponse: PiWebPluginsResponse | undefined;
  @property({ attribute: false }) configResponse: PiWebConfigResponse | undefined;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) saving = false;
  @property({ type: Boolean }) recoveryCommandsSupported = false;
  @property() error = "";
  @property() savedMessage = "";
  @property({ attribute: false }) restartAction: TemplateResult | undefined;
  @property() targetLabel = "";
  private get target(): string { return this.targetLabel || pluginsMessages.t("localTarget"); }
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onResetPlugin?: (pluginId: string) => void | Promise<void>;
  @property({ attribute: false }) onTogglePlugin?: (pluginId: string, enabled: boolean) => void | Promise<void>;

  override render(): TemplateResult {
    const plugins = settingsPluginRows(this.pluginsResponse, this.configResponse);
    const hasPluginResponse = this.pluginsResponse !== undefined;
    return html`
      <settings-panel-frame
        .heading=${pluginsMessages.t("heading")}
        .description=${html`${pluginsMessages.rich("description", { target: this.target, strong })}`}
        .actionLabel=${pluginsMessages.t("refresh")}
        .actionTitle=${pluginsMessages.t("refreshTitle", { target: this.target })}
        .actionDisabled=${this.loading || this.saving}
        .notices=${this.panelNotices(plugins.length > 0)}
        .onAction=${this.onReload}
      >
        ${this.renderPanelContent(plugins, hasPluginResponse)}
      </settings-panel-frame>
    `;
  }

  private panelNotices(showTrustedCodeWarning: boolean): readonly SettingsNotice[] {
    const notices: SettingsNotice[] = [];
    if (this.error !== "") notices.push({ type: "error", content: this.error });
    if (this.shouldShowConfigUnavailableNotice(showTrustedCodeWarning)) {
      notices.push({ type: "availability", content: pluginsMessages.t("unavailableConfig") });
    }
    if (this.savedMessage !== "") notices.push({ type: "success", content: this.savedNotice() });

    const runtime = this.pluginsResponse?.serverRuntime;
    if (runtime?.status === "unavailable") {
      notices.push({
        type: "availability",
        title: pluginsMessages.t("unavailableTitle"),
        content: pluginsMessages.t("unavailableRuntime", { detail: runtime.message ?? pluginsMessages.t("connectionHelp") }),
      });
    } else if (runtime?.status === "incompatible") {
      notices.push({
        type: "error",
        title: pluginsMessages.t("incompatibleTitle"),
        content: pluginsMessages.t("incompatible", { detail: runtime.message ?? pluginsMessages.t("incompatibleFallback") }),
      });
    }
    if (runtime?.safeStart !== undefined) {
      notices.push({
        type: "warning",
        title: pluginsMessages.t("safeTitle"),
        content: html`${pluginsMessages.rich(runtime.safeStart === "bundled-only" ? "safeBundled" : "safeNone", { command: runtime.recovery.clearSafeStart, code })}`,
      });
    }
    if (runtime?.desiredSafeStart !== undefined && runtime.desiredSafeStart !== (runtime.safeStart ?? "off")) {
      notices.push({
        type: "warning",
        title: pluginsMessages.t("pendingTitle"),
        content: runtime.desiredSafeStart === "off"
          ? pluginsMessages.t("pendingOff")
          : pluginsMessages.t("pendingSafe", { mode: runtime.desiredSafeStart }),
      });
    }
    if (runtime?.restartRequired === true) {
      notices.push({
        type: "warning",
        title: pluginsMessages.t("restartTitle"),
        content: this.restartAction ?? pluginsMessages.t("restart", { target: this.target }),
      });
    }
    for (const diagnostic of this.pluginsResponse?.diagnostics ?? []) {
      notices.push({
        type: diagnostic.kind === "conflict" ? "error" : "warning",
        title: pluginsMessages.t(diagnostic.kind === "conflict" ? "conflictTitle" : "diagnosticTitle"),
        content: pluginsMessages.t("diagnostic", { snapshot: diagnostic.snapshot, detail: diagnostic.message }),
      });
    }
    if (showTrustedCodeWarning) {
      notices.push({
        type: "security",
        content: html`${pluginsMessages.rich("trusted", { strong })}`,
      });
    }
    return notices;
  }

  private savedNotice(): string {
    if (this.pluginsResponse?.serverRuntime.status !== "available" || this.pluginsResponse.serverRuntime.restartRequired) {
      return pluginsMessages.t("savedRestart", { saved: this.savedMessage });
    }
    return pluginsMessages.t("savedBrowser", { saved: this.savedMessage });
  }

  private shouldShowConfigUnavailableNotice(hasLoadedPlugins: boolean): boolean {
    return hasLoadedPlugins && this.configResponse === undefined && !this.loading && this.error === "";
  }

  private renderPanelContent(plugins: SettingsPluginRow[], hasPluginResponse: boolean): TemplateResult {
    if (!hasPluginResponse && plugins.length === 0) {
      return html`
        <div class="loading-card ui-settings-summary">${this.loading ? pluginsMessages.t("loading") : pluginsMessages.t("unavailableList", { target: this.target })}</div>
        ${this.renderRecoveryCommands()}
      `;
    }
    if (plugins.length === 0) {
      return html`
        <div class="loading-card ui-settings-summary">${pluginsMessages.t("empty", { target: this.target })}</div>
        ${this.renderRecoveryCommands()}
      `;
    }
    return html`
      <div class="plugin-note ui-settings-summary">${pluginsMessages.t("automatic", { target: this.target })}</div>
      <div class="plugin-list ui-settings-list">
        ${plugins.map((plugin) => this.renderPlugin(plugin))}
      </div>
      ${this.renderRecoveryCommands()}
    `;
  }

  private renderPlugin(plugin: SettingsPluginRow): TemplateResult {
    const path = settingPath("plugins", plugin.id, "enabled");
    const configured = this.configResponse?.config.plugins?.[plugin.id];
    const configuredState = plugin.required === true
      ? pluginsMessages.t("requiredState")
      : !plugin.discovered && configured === undefined
        ? pluginsMessages.t("missingState")
        : pluginsMessages.t(configured?.enabled === false ? "disabledState" : configured?.enabled === true ? "enabledState" : "defaultState");
    return html`
      <article class=${`plugin-card ui-settings-row${plugin.enabled ? "" : " disabled"}`}>
        <div class="plugin-main">
          <strong dir="auto">${plugin.id}</strong>
          <small>${plugin.configOnly ? pluginsMessages.t("configOnly") : pluginsMessages.t("provenance", { source: plugin.source, scope: plugin.scope, machine: plugin.machineSpecific ? "yes" : "no", required: plugin.required === true ? "yes" : "no", discovered: plugin.discovered ? "yes" : "no" })}</small>
          <small>${configuredState}</small>
          ${settingControls(this.configResponse, path, this.loading || this.saving || !plugin.editable, this.onResetPlugin ? () => this.onResetPlugin?.(plugin.id) : undefined)}
          ${this.renderPluginStatuses(plugin)}
          ${plugin.server?.message === undefined ? nothing : html`<small class="diagnostic" dir="auto">${plugin.server.message}</small>`}
          ${plugin.server?.health?.message === undefined ? nothing : html`<small class="diagnostic">${pluginsMessages.t("healthDetail", { detail: plugin.server.health.message })}</small>`}
          ${plugin.server === undefined || plugin.required === true ? nothing : html`<small class="command">${pluginsMessages.rich("offlineDisable", { command: plugin.server.disableCommand, code })}</small>`}
        </div>
        <label class="toggle ui-checkbox-field">
          <input type="checkbox" aria-label=${pluginsMessages.t(plugin.required === true ? "requiredAria" : "enableAria", { id: plugin.id })} .checked=${live(plugin.required === true || (this.configResponse?.effectiveConfig.plugins?.[plugin.id]?.enabled ?? plugin.enabled))} ?disabled=${this.loading || this.saving || this.configResponse === undefined || !plugin.editable || enforcedSetting(this.configResponse, path) !== undefined} @change=${(event: Event) => { void this.togglePlugin(plugin, event); }}>
          <span>${pluginsMessages.t(plugin.required === true ? "required" : "enable")}</span>
        </label>
      </article>
    `;
  }

  private renderPluginStatuses(plugin: SettingsPluginRow): TemplateResult {
    const server = plugin.server;
    return html`
      <div class="status-list" aria-label=${pluginsMessages.t("statesAria", { id: plugin.id })}>
        ${server === undefined ? html`<span class="status neutral">${pluginsMessages.t(plugin.configOnly ? "configuredOnly" : "browserOnly")}</span>` : html`<span class=${`status ${serverStateTone(server.state)}`}>${pluginsMessages.t("serverState", { state: server.state })}</span>`}
        ${plugin.conflict ? html`<span class="status error">${pluginsMessages.t("conflict")}</span>` : nothing}
        ${server?.staleRevision === true ? html`<span class="status warning">${pluginsMessages.t("updatePending")}</span>` : nothing}
        ${server?.restartRequired === true ? html`<span class="status warning">${pluginsMessages.t("restartRequired")}</span>` : nothing}
        ${server?.health === undefined ? nothing : html`<span class=${`status ${healthTone(server.health.status)}`}>${pluginsMessages.t("health", { status: server.health.status })}</span>`}
      </div>
    `;
  }

  private renderRecoveryCommands(): TemplateResult | typeof nothing {
    const runtime = this.pluginsResponse?.serverRuntime;
    const responseRecovery = runtime?.status === "incompatible" && !this.recoveryCommandsSupported ? undefined : runtime?.recovery;
    const recovery = responseRecovery ?? (this.recoveryCommandsSupported ? PI_WEB_PLUGIN_RECOVERY_COMMANDS : undefined);
    if (recovery === undefined) return nothing;
    return html`
      <aside class="recovery ui-settings-summary" aria-label=${pluginsMessages.t("recoveryAria")}>
        <strong>${pluginsMessages.t("recoveryTitle", { target: this.target })}</strong>
        <small>${pluginsMessages.t("recoveryHelp", { target: this.target })}</small>
        <small>${pluginsMessages.rich("recoveryRestart", { code })}</small>
        <span>${pluginsMessages.t("showSafe")}</span><code dir="ltr">${recovery.showSafeStart}</code>
        <span>${pluginsMessages.t("bundledOnly")}</span><code dir="ltr">${recovery.bundledOnly}</code>
        <span>${pluginsMessages.t("noServer")}</span><code dir="ltr">${recovery.noServerPlugins}</code>
        <span>${pluginsMessages.t("clearSafe")}</span><code dir="ltr">${recovery.clearSafeStart}</code>
      </aside>
    `;
  }

  private async togglePlugin(plugin: SettingsPluginRow, event: Event): Promise<void> {
    const enabled = event.target instanceof HTMLInputElement ? event.target.checked : plugin.enabled;
    await this.onTogglePlugin?.(plugin.id, enabled);
  }

  static override styles = [uiButtonStyles, uiFormStyles, uiSettingsStyles, css`
    :host { display: block; overflow-wrap: anywhere; }
    .loading-card, .plugin-note { color: var(--pi-muted); }
    code { color: var(--pi-text); font: 12px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); overflow-wrap: anywhere; }
    .plugin-card { align-items: center; }
    .plugin-card.disabled { opacity: .8; }
    .plugin-main { flex: 1 1 280px; min-width: 0; display: grid; gap: 5px; }
    .plugin-main > strong, .plugin-main > small:not(.command) { overflow-wrap: anywhere; }
    .plugin-main small { color: var(--pi-muted); }
    .diagnostic { color: var(--pi-text) !important; }
    .command { line-height: 1.5; }
    .status-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
    .status { border: 1px solid var(--pi-border-muted); border-radius: 999px; padding: 2px 7px; color: var(--pi-muted); font-size: 11px; line-height: 1.3; }
    .status.success { border-color: var(--pi-success-border); color: var(--pi-success); background: var(--pi-success-surface); }
    .status.warning { border-color: var(--pi-warning-border); color: var(--pi-text); background: var(--pi-warning-surface); }
    .status.error { border-color: var(--pi-danger); color: var(--pi-danger); }
    .toggle { min-width: 0; }
    .recovery small { color: var(--pi-muted); line-height: 1.4; }
    .recovery code { display: block; width: fit-content; max-width: 100%; }

    @media (max-width: 760px) {
      .plugin-main { flex-basis: 100%; }
    }
  `];
}

export function settingsPluginRows(
  response: PiWebPluginsResponse | undefined,
  config: PiWebConfigResponse | undefined,
): SettingsPluginRow[] {
  const configuredPlugins = config?.config.plugins ?? {};
  const rows = (response?.plugins ?? []).map((plugin): SettingsPluginRow => {
    const configured = configuredPlugins[plugin.id];
    const enabled = plugin.required === true ? true : configured?.enabled ?? plugin.enabled;
    return {
      ...plugin,
      enabled,
      configOnly: false,
      editable: plugin.required !== true && (plugin.discovered || configured !== undefined),
    };
  });
  const knownIds = new Set(rows.map(({ id }) => id));
  for (const [id, configured] of Object.entries(configuredPlugins)) {
    if (knownIds.has(id)) continue;
    const required = id === REQUIRED_TERMINAL_PLUGIN_ID;
    rows.push({
      id,
      ...(required ? { required: true as const } : {}),
      source: "config",
      scope: "local",
      machineSpecific: false,
      enabled: required || configured.enabled !== false,
      discovered: false,
      conflict: false,
      configOnly: true,
      editable: !required,
    });
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

function serverStateTone(state: NonNullable<PiWebPluginInfo["server"]>["state"]): "success" | "warning" | "error" | "neutral" {
  switch (state) {
    case "active": return "success";
    case "disabled":
    case "missing": return "warning";
    case "failed":
    case "incompatible": return "error";
    case "unknown": return "neutral";
  }
}

function healthTone(status: NonNullable<NonNullable<PiWebPluginInfo["server"]>["health"]>["status"]): "success" | "warning" | "error" {
  switch (status) {
    case "healthy": return "success";
    case "degraded": return "warning";
    case "unhealthy": return "error";
  }
}
