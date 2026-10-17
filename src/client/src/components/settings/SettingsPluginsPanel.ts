import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import type { PiWebConfigResponse, PiWebPluginInfo, PiWebPluginsResponse } from "../../api";
import { PI_WEB_PLUGIN_RECOVERY_COMMANDS } from "../../../../shared/pluginRecoveryCommands";
import { REQUIRED_TERMINAL_PLUGIN_ID } from "../../../../shared/requiredTerminalPlugin";
import { uiFormStyles } from "../ui/formStyles";
import { uiSettingsStyles } from "../ui/settingsStyles";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";

export type SettingsPluginRow = PiWebPluginInfo & { configOnly: boolean; editable: boolean };

@customElement("settings-plugins-panel")
export class SettingsPluginsPanel extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) pluginsResponse: PiWebPluginsResponse | undefined;
  @property({ attribute: false }) configResponse: PiWebConfigResponse | undefined;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) saving = false;
  @property({ type: Boolean }) recoveryCommandsSupported = false;
  @property() error = "";
  @property() savedMessage = "";
  @property() targetLabel = "local (local gateway)";
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onTogglePlugin?: (pluginId: string, enabled: boolean) => void | Promise<void>;

  override render(): TemplateResult {
    const plugins = settingsPluginRows(this.pluginsResponse, this.configResponse);
    const hasPluginResponse = this.pluginsResponse !== undefined;
    return html`
      <settings-panel-frame
        heading="PI WEB plugins"
        .description=${pluginsDescription(this.targetLabel)}
        actionLabel="Refresh plugins"
        actionTitle=${`Refresh plugin settings and status from ${this.targetLabel}`}
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
      notices.push({ type: "availability", content: "Plugin settings are unavailable. Choose Refresh plugins to try again before making changes." });
    }
    if (this.savedMessage !== "") notices.push({ type: "success", content: this.savedNotice() });

    const runtime = this.pluginsResponse?.serverRuntime;
    if (runtime?.status === "unavailable") {
      notices.push({
        type: "availability",
        title: "Running plugin status unavailable",
        content: html`You can edit saved settings, but PI WEB cannot verify which server plugins are running. ${runtime.message ?? "Check the machine connection, then choose Refresh plugins."}`,
      });
    } else if (runtime?.status === "incompatible") {
      notices.push({
        type: "error",
        title: "Plugin lifecycle version mismatch",
        content: html`${runtime.message ?? "The web process and session daemon do not support the same plugin lifecycle protocol."} Update and restart both components before loading server-backed browser plugins.`,
      });
    }
    if (runtime?.safeStart !== undefined) {
      notices.push({
        type: "warning",
        title: "Server-plugin safe mode active",
        content: runtime.safeStart === "bundled-only"
          ? html`Only bundled server plugins were imported. Clear safe mode with <code>${runtime.recovery.clearSafeStart}</code>.`
          : html`No server plugins were loaded. Terminal is unavailable; use the folder workspace to investigate. Clear safe mode with <code>${runtime.recovery.clearSafeStart}</code>.`,
      });
    }
    if (runtime?.desiredSafeStart !== undefined && runtime.desiredSafeStart !== (runtime.safeStart ?? "off")) {
      notices.push({
        type: "warning",
        title: "Safe-mode restart pending",
        content: runtime.desiredSafeStart === "off"
          ? "Safe mode is turned off in saved settings, but remains active until the session daemon restarts."
          : `Saved settings request ${runtime.desiredSafeStart} safe mode. It takes effect on the next session daemon restart.`,
      });
    }
    if (runtime?.restartRequired === true) {
      notices.push({
        type: "warning",
        title: "Saved changes aren’t active yet",
        content: `Restart the session daemon on ${this.targetLabel} to apply server-plugin settings or package updates. Restarting interrupts active sessions.`,
      });
    }
    for (const diagnostic of this.pluginsResponse?.diagnostics ?? []) {
      notices.push({
        type: diagnostic.kind === "conflict" ? "error" : "warning",
        title: diagnostic.kind === "conflict" ? "Plugin id conflict" : "Plugin discovery diagnostic",
        content: `${diagnostic.snapshot === "active" ? "Running plugins" : "Available plugins"}: ${diagnostic.message}`,
      });
    }
    if (showTrustedCodeWarning) {
      notices.push({
        type: "security",
        content: html`<strong>Trusted code warning:</strong> PI WEB plugins and Pi packages can run with your user permissions. Enable plugins only from sources you trust.`,
      });
    }
    return notices;
  }

  private savedNotice(): string {
    if (this.pluginsResponse?.serverRuntime.status !== "available" || this.pluginsResponse.serverRuntime.restartRequired) {
      return `${this.savedMessage} Restart the session daemon to apply server-plugin changes. Restarting interrupts active sessions. Reload this browser tab to apply browser-only changes.`;
    }
    return `${this.savedMessage} Reload this browser tab to apply browser-only plugin changes.`;
  }

  private shouldShowConfigUnavailableNotice(hasLoadedPlugins: boolean): boolean {
    return hasLoadedPlugins && this.configResponse === undefined && !this.loading && this.error === "";
  }

  private renderPanelContent(plugins: SettingsPluginRow[], hasPluginResponse: boolean): TemplateResult {
    if (!hasPluginResponse && plugins.length === 0) {
      return html`
        <div class="loading-card ui-settings-summary">${this.loading ? "Loading PI WEB plugins…" : `PI WEB plugin list unavailable for ${this.targetLabel}. Choose Refresh plugins to try again.`}</div>
        ${this.renderRecoveryCommands()}
      `;
    }
    if (plugins.length === 0) {
      return html`
        <div class="loading-card ui-settings-summary">No PI WEB plugins are discovered or active on ${this.targetLabel}.</div>
        ${this.renderRecoveryCommands()}
      `;
    }
    return html`
      <div class="plugin-note ui-settings-summary">Changes save automatically on ${this.targetLabel}. Toggles show saved settings, not whether a plugin is running. Reload this browser tab for browser-only changes; server-plugin changes require a session daemon restart.</div>
      <div class="plugin-list ui-settings-list">
        ${plugins.map((plugin) => this.renderPlugin(plugin))}
      </div>
      ${this.renderRecoveryCommands()}
    `;
  }

  private renderPlugin(plugin: SettingsPluginRow): TemplateResult {
    const configured = this.configResponse?.config.plugins?.[plugin.id];
    const configuredState = plugin.required === true
      ? "Required · cannot be disabled here"
      : !plugin.discovered && configured === undefined
        ? "Package no longer available in saved settings"
        : configured?.enabled === false ? "Saved: disabled" : configured?.enabled === true ? "Saved: enabled" : "Enabled by default";
    return html`
      <article class=${`plugin-card ui-settings-row${plugin.enabled ? "" : " disabled"}`}>
        <div class="plugin-main">
          <strong>${plugin.id}</strong>
          <small>${plugin.configOnly ? "Saved settings only · package not found" : `${plugin.source} · ${plugin.scope}${plugin.machineSpecific ? " · machine-specific" : ""}${plugin.required === true ? " · required" : ""}${plugin.discovered ? "" : " · running version only"}`}</small>
          <small>${configuredState}</small>
          ${this.renderPluginStatuses(plugin)}
          ${plugin.server?.message === undefined ? nothing : html`<small class="diagnostic">${plugin.server.message}</small>`}
          ${plugin.server?.health?.message === undefined ? nothing : html`<small class="diagnostic">Health: ${plugin.server.health.message}</small>`}
          ${plugin.server === undefined || plugin.required === true ? nothing : html`<small class="command">Offline disable: <code>${plugin.server.disableCommand}</code></small>`}
        </div>
        <label class="toggle ui-checkbox-field">
          <input type="checkbox" aria-label=${plugin.required === true ? `${plugin.id} is required` : `Enable ${plugin.id}`} .checked=${live(plugin.enabled)} ?disabled=${this.loading || this.saving || this.configResponse === undefined || !plugin.editable} @change=${(event: Event) => { void this.togglePlugin(plugin, event); }}>
          <span>${plugin.required === true ? "Required" : "Enable plugin"}</span>
        </label>
      </article>
    `;
  }

  private renderPluginStatuses(plugin: SettingsPluginRow): TemplateResult {
    const server = plugin.server;
    return html`
      <div class="status-list" aria-label=${`${plugin.id} plugin states`}>
        ${server === undefined ? html`<span class="status neutral">${plugin.configOnly ? "Configured only" : "Browser only"}</span>` : html`<span class=${`status ${serverStateTone(server.state)}`}>${serverStateLabel(server.state)}</span>`}
        ${plugin.conflict ? html`<span class="status error">Conflict</span>` : nothing}
        ${server?.staleRevision === true ? html`<span class="status warning">Package update pending</span>` : nothing}
        ${server?.restartRequired === true ? html`<span class="status warning">Restart required</span>` : nothing}
        ${server?.health === undefined ? nothing : html`<span class=${`status ${healthTone(server.health.status)}`}>Health ${server.health.status}</span>`}
      </div>
    `;
  }

  private renderRecoveryCommands(): TemplateResult | typeof nothing {
    const runtime = this.pluginsResponse?.serverRuntime;
    const responseRecovery = runtime?.status === "incompatible" && !this.recoveryCommandsSupported ? undefined : runtime?.recovery;
    const recovery = responseRecovery ?? (this.recoveryCommandsSupported ? PI_WEB_PLUGIN_RECOVERY_COMMANDS : undefined);
    if (recovery === undefined) return nothing;
    return html`
      <aside class="recovery ui-settings-summary" aria-label="Offline server-plugin recovery commands">
        <strong>Offline recovery on ${this.targetLabel}</strong>
        <small>Run these commands in a terminal on ${this.targetLabel}. They edit settings without connecting to the session daemon or loading plugins. They never include machine credentials.</small>
        <small>Commands with <code>--restart</code> restart services and interrupt active sessions.</small>
        <span>Check safe mode</span><code>${recovery.showSafeStart}</code>
        <span>Start with bundled server plugins only</span><code>${recovery.bundledOnly}</code>
        <span>Start without server plugins (including Terminal)</span><code>${recovery.noServerPlugins}</code>
        <span>Clear safe mode and start normally</span><code>${recovery.clearSafeStart}</code>
      </aside>
    `;
  }

  private async togglePlugin(plugin: SettingsPluginRow, event: Event): Promise<void> {
    const enabled = event.target instanceof HTMLInputElement ? event.target.checked : plugin.enabled;
    await this.onTogglePlugin?.(plugin.id, enabled);
  }

  static override styles = [uiFormStyles, uiSettingsStyles, css`
    :host { display: block; }
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
    .toggle { white-space: nowrap; }
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

function serverStateLabel(state: NonNullable<PiWebPluginInfo["server"]>["state"]): string {
  switch (state) {
    case "active": return "Active";
    case "failed": return "Failed";
    case "incompatible": return "Incompatible";
    case "disabled": return "Disabled";
    case "missing": return "Not active";
    case "unknown": return "Active state unavailable";
  }
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

function pluginsDescription(targetLabel: string): TemplateResult {
  return html`Manage saved plugin settings and check running server plugins on <strong>${targetLabel}</strong>. This is separate from installing Pi packages.`;
}
