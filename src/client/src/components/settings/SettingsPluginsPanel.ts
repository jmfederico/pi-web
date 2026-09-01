import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { PiWebConfigResponse, PiWebPluginInfo, PiWebPluginsResponse } from "../../api";
import { PI_WEB_PLUGIN_RECOVERY_COMMANDS } from "../../../../shared/pluginRecoveryCommands";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";

export type SettingsPluginRow = PiWebPluginInfo & { configOnly: boolean; editable: boolean };

@customElement("settings-plugins-panel")
export class SettingsPluginsPanel extends LitElement {
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
        actionLabel="Reload"
        actionTitle=${`Reload PI WEB plugins from ${this.targetLabel}`}
        .actionDisabled=${this.loading}
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
      notices.push({ type: "availability", content: "Configuration is unavailable. Reload to try again before changing plugin enablement." });
    }
    if (this.savedMessage !== "") notices.push({ type: "success", content: this.savedNotice() });

    const runtime = this.pluginsResponse?.serverRuntime;
    if (runtime?.status === "unavailable") {
      notices.push({
        type: "availability",
        title: "Active server-plugin state unavailable",
        content: html`Desired config remains editable, but PI WEB cannot verify the sessiond snapshot. ${runtime.message ?? "Restart or reconnect sessiond, then reload."}`,
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
          : html`No server plugins were imported; the kernel folder workspace remains available. Clear safe mode with <code>${runtime.recovery.clearSafeStart}</code>.`,
      });
    }
    if (runtime?.desiredSafeStart !== undefined && runtime.desiredSafeStart !== (runtime.safeStart ?? "off")) {
      notices.push({
        type: "warning",
        title: "Safe-mode restart pending",
        content: runtime.desiredSafeStart === "off"
          ? "Safe start is cleared in offline config but remains active until sessiond restarts."
          : `Offline config requests ${runtime.desiredSafeStart} safe start. It takes effect before plugin import on the next sessiond restart.`,
      });
    }
    if (runtime?.restartRequired === true) {
      notices.push({
        type: "warning",
        title: "Session-daemon restart required",
        content: "Desired plugin config or package revisions differ from sessiond's active startup snapshot. Restarting sessiond may interrupt active sessions.",
      });
    }
    for (const diagnostic of this.pluginsResponse?.diagnostics ?? []) {
      notices.push({
        type: diagnostic.kind === "conflict" ? "error" : "warning",
        title: diagnostic.kind === "conflict" ? "Plugin id conflict" : "Plugin discovery diagnostic",
        content: `${diagnostic.snapshot === "active" ? "Active snapshot" : "Desired catalog"}: ${diagnostic.message}`,
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
      return `${this.savedMessage} Restart the session daemon to apply server-plugin changes; browser-only changes apply after reloading this tab.`;
    }
    return `${this.savedMessage} Reload the browser tab to apply browser-only plugin changes.`;
  }

  private shouldShowConfigUnavailableNotice(hasLoadedPlugins: boolean): boolean {
    return hasLoadedPlugins && this.configResponse === undefined && !this.loading && this.error === "";
  }

  private renderPanelContent(plugins: SettingsPluginRow[], hasPluginResponse: boolean): TemplateResult {
    if (!hasPluginResponse && plugins.length === 0) {
      return html`
        <div class="loading-card">${this.loading ? "Loading PI WEB plugins…" : `PI WEB plugin list unavailable for ${this.targetLabel}. Use Reload to try again.`}</div>
        ${this.renderRecoveryCommands()}
      `;
    }
    if (plugins.length === 0) {
      return html`
        <div class="loading-card">No PI WEB plugins are discovered or active on ${this.targetLabel}.</div>
        ${this.renderRecoveryCommands()}
      `;
    }
    return html`
      <div class="plugin-note">Config key on ${this.targetLabel}: <code>plugins</code>. Browser-only changes apply after a tab reload; server-backed changes follow sessiond's startup snapshot and can require a manual restart.</div>
      <div class="plugin-list">
        ${plugins.map((plugin) => this.renderPlugin(plugin))}
      </div>
      ${this.renderRecoveryCommands()}
    `;
  }

  private renderPlugin(plugin: SettingsPluginRow): TemplateResult {
    const configured = this.configResponse?.config.plugins?.[plugin.id];
    const configuredState = !plugin.discovered && configured === undefined
      ? "Desired package/config absent"
      : configured?.enabled === false ? "Config disabled" : configured?.enabled === true ? "Config enabled" : "Default enabled";
    return html`
      <article class=${`plugin-card${plugin.enabled ? "" : " disabled"}`}>
        <div class="plugin-main">
          <strong>${plugin.id}</strong>
          <small>${plugin.configOnly ? "configured only · package not discovered" : `${plugin.source} · ${plugin.scope}${plugin.machineSpecific ? " · machine-specific" : ""}${plugin.discovered ? "" : " · active snapshot only"}`}</small>
          <small>${configuredState}</small>
          ${this.renderPluginStatuses(plugin)}
          ${plugin.server?.message === undefined ? nothing : html`<small class="diagnostic">${plugin.server.message}</small>`}
          ${plugin.server?.health?.message === undefined ? nothing : html`<small class="diagnostic">Health: ${plugin.server.health.message}</small>`}
          ${plugin.server === undefined ? nothing : html`<small class="command">Offline disable: <code>${plugin.server.disableCommand}</code></small>`}
        </div>
        <label class="toggle">
          <input type="checkbox" .checked=${plugin.enabled} ?disabled=${this.saving || this.configResponse === undefined || !plugin.editable} @change=${(event: Event) => { void this.togglePlugin(plugin, event); }}>
          <span>Enabled</span>
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
        ${server?.staleRevision === true ? html`<span class="status warning">Stale revision</span>` : nothing}
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
      <aside class="recovery" aria-label="Offline server-plugin recovery commands">
        <strong>Offline recovery on ${this.targetLabel}</strong>
        <small>These commands edit config without contacting sessiond or importing plugins. They never include machine credentials.</small>
        <code>${recovery.showSafeStart}</code>
        <code>${recovery.bundledOnly}</code>
        <code>${recovery.noServerPlugins}</code>
        <code>${recovery.clearSafeStart}</code>
      </aside>
    `;
  }

  private async togglePlugin(plugin: SettingsPluginRow, event: Event): Promise<void> {
    const enabled = event.target instanceof HTMLInputElement ? event.target.checked : plugin.enabled;
    await this.onTogglePlugin?.(plugin.id, enabled);
  }

  static override styles = css`
    :host { display: block; }
    input { font: inherit; }
    input:disabled { opacity: .55; cursor: not-allowed; }
    .loading-card, .plugin-note, .plugin-card, .recovery { border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); padding: 12px; }
    .loading-card, .plugin-note { color: var(--pi-muted); }
    code { border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-bg); padding: 1px 4px; color: var(--pi-text); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
    .plugin-list { display: grid; gap: 10px; }
    .plugin-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; }
    .plugin-card.disabled { opacity: .8; }
    .plugin-main { min-width: 0; display: grid; gap: 5px; }
    .plugin-main > strong, .plugin-main > small:not(.command) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .plugin-main small { color: var(--pi-muted); }
    .diagnostic { color: var(--pi-text) !important; }
    .command { line-height: 1.5; }
    .status-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
    .status { border: 1px solid var(--pi-border-muted); border-radius: 999px; padding: 2px 7px; color: var(--pi-muted); font-size: 11px; line-height: 1.3; }
    .status.success { border-color: var(--pi-success-border); color: var(--pi-success); background: var(--pi-success-surface); }
    .status.warning { border-color: var(--pi-warning-border); color: var(--pi-text); background: var(--pi-warning-surface); }
    .status.error { border-color: var(--pi-danger); color: var(--pi-danger); }
    .toggle { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
    .toggle input { width: 18px; height: 18px; accent-color: var(--pi-accent); }
    .recovery { display: grid; gap: 7px; }
    .recovery small { color: var(--pi-muted); line-height: 1.4; }
    .recovery code { display: block; width: fit-content; max-width: 100%; }

    @media (max-width: 760px) {
      .plugin-card { grid-template-columns: minmax(0, 1fr); align-items: start; }
      .toggle { justify-self: start; }
    }
  `;
}

export function settingsPluginRows(
  response: PiWebPluginsResponse | undefined,
  config: PiWebConfigResponse | undefined,
): SettingsPluginRow[] {
  const configuredPlugins = config?.config.plugins ?? {};
  const rows = (response?.plugins ?? []).map((plugin): SettingsPluginRow => {
    const configured = configuredPlugins[plugin.id];
    const enabled = configured?.enabled ?? plugin.enabled;
    return {
      ...plugin,
      enabled,
      configOnly: false,
      editable: plugin.discovered || configured !== undefined,
    };
  });
  const knownIds = new Set(rows.map(({ id }) => id));
  for (const [id, configured] of Object.entries(configuredPlugins)) {
    if (knownIds.has(id)) continue;
    rows.push({
      id,
      source: "config",
      scope: "local",
      machineSpecific: false,
      enabled: configured.enabled !== false,
      discovered: false,
      conflict: false,
      configOnly: true,
      editable: true,
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
  return html`Compare desired plugin config with the active sessiond startup snapshot on <strong>${targetLabel}</strong>. This is separate from installing Pi packages.`;
}
