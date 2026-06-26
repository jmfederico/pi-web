import { css, html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";
import { spawnSessionsConfigPatch, subsessionsConfigPatch } from "./settingsSessiondConfig";

@customElement("settings-sessiond-panel")
export class SettingsSessiondPanel extends LitElement {
  @property({ attribute: false }) configResponse: PiWebConfigResponse | undefined;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) saving = false;
  @property() error = "";
  @property() savedMessage = "";
  @property() targetLabel = "local (local gateway)";
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onSave?: (config: PiWebConfigValues) => void | Promise<void>;

  override render(): TemplateResult {
    const config = this.configResponse;
    const spawnOverridden = config?.envOverrides.spawnSessions === true;
    // On by default: the effective config is the source of truth for the toggle
    // state, so an unset config file still shows the feature as enabled.
    const effectiveSpawn = config?.effectiveConfig.spawnSessions !== false;
    const subsessionsOverridden = config?.envOverrides.subsessions === true;
    // Beta, off by default; also requires spawn to be enabled.
    const effectiveSubsessions = config?.effectiveConfig.subsessions === true && effectiveSpawn;
    const agentCommandOverridden = config?.envOverrides.agentCommand === true;
    const agentDirOverridden = config?.envOverrides.agentDir === true;
    const effectiveAgent = config?.effectiveConfig.agent;
    return html`
      <settings-panel-frame
        heading="Session daemon"
        .description=${sessiondDescription(this.targetLabel)}
        actionLabel="Reload"
        .actionDisabled=${this.loading}
        .notices=${this.panelNotices(config)}
        .onAction=${this.onReload}
      >
        ${config === undefined ? this.renderUnavailableConfigState() : html`
          <div class="config-path-card">
            <span>Config file</span>
            <code>${config.path}</code>
          </div>
          <div class="field">
            <span class="field-heading">
              <span>Agent command for diagnostics</span>
              ${agentCommandOverridden ? html`<span class="override-badge">environment override</span>` : null}
            </span>
            <input
              class="text-input"
              type="text"
              autocomplete="off"
              spellcheck="false"
              .value=${config.config.agent?.command ?? ""}
              placeholder="pi"
              ?disabled=${this.loading || this.saving || agentCommandOverridden}
              @change=${(event: Event) => { void this.saveAgentField("command", event); }}
            >
            <small>Use a Pi-compatible CLI command for doctor/status/update checks. PI WEB's embedded session runtime still uses the bundled SDK path, so this does not load a different agent implementation.</small>
          </div>
          <div class="field">
            <span class="field-heading">
              <span>Agent state directory</span>
              ${agentDirOverridden ? html`<span class="override-badge">environment override</span>` : null}
            </span>
            <input
              class="text-input"
              type="text"
              autocomplete="off"
              spellcheck="false"
              .value=${config.config.agent?.dir ?? ""}
              placeholder="~/.pi/agent or /path/to/fork/agent"
              ?disabled=${this.loading || this.saving || agentDirOverridden}
              @change=${(event: Event) => { void this.saveAgentField("dir", event); }}
            >
            <small>Choose which compatible auth, models, settings, and sessions PI WEB reads. Non-<code>pi</code> commands require an explicit state directory, then a session daemon restart.</small>
          </div>
          <div class="field">
            <span class="field-heading">
              <span>Allow agents to start sessions</span>
              ${spawnOverridden ? html`<span class="override-badge">environment override</span>` : null}
            </span>
            <label class="toggle">
              <input
                type="checkbox"
                .checked=${effectiveSpawn}
                ?disabled=${this.loading || this.saving || spawnOverridden}
                @change=${(event: Event) => { void this.toggleSpawnSessions(event); }}
              >
              <span>Enable the <code>spawn_session</code> tool</span>
            </label>
            <small>When enabled, LLMs can start new sessions, constrained to a workspace (any worktree) of the same registered project so every spawned session stays visible here. On by default.</small>
          </div>
          <div class="field">
            <span class="field-heading">
              <span>Allow agents to start tracked subsessions</span>
              <span class="beta-badge">beta</span>
              ${subsessionsOverridden ? html`<span class="override-badge">environment override</span>` : null}
            </span>
            <label class="toggle">
              <input
                type="checkbox"
                .checked=${effectiveSubsessions}
                ?disabled=${this.loading || this.saving || subsessionsOverridden || !effectiveSpawn}
                @change=${(event: Event) => { void this.toggleSubsessions(event); }}
              >
              <span>Enable the <code>spawn_subsession</code> tools</span>
            </label>
            <small>Beta: agents can start child sessions they stay attached to (<code>spawn_subsession</code>, <code>list_subsessions</code>, <code>check_subsession</code>, <code>read_subsession</code>) and are notified when a child finishes. Requires "Allow agents to start sessions". Off by default.</small>
          </div>
          <section class="effective-card" aria-label="Effective configuration summary">
            <h3>Effective after environment overrides</h3>
            <dl>
              <div><dt>Agent command</dt><dd>${effectiveAgent?.command ?? html`<span class="muted">pi default</span>`}</dd></div>
              <div><dt>Agent state</dt><dd>${effectiveAgent?.dir ?? html`<span class="muted">~/.pi/agent default</span>`}</dd></div>
              <div><dt>Spawn sessions</dt><dd>${effectiveSpawn ? "Enabled" : html`<span class="muted">Disabled</span>`}</dd></div>
              <div><dt>Subsessions</dt><dd>${effectiveSubsessions ? "Enabled" : html`<span class="muted">Disabled</span>`}</dd></div>
            </dl>
          </section>
        `}
      </settings-panel-frame>
    `;
  }

  private panelNotices(config: PiWebConfigResponse | undefined): readonly SettingsNotice[] {
    const notices: SettingsNotice[] = [];
    if (this.error !== "") notices.push({ type: "error", content: this.error });
    if (this.savedMessage !== "") notices.push({ type: "success", content: this.savedMessage });
    if (config !== undefined) {
      notices.push({
        type: "warning",
        title: `Restart required on ${this.targetLabel}`,
        content: html`run <code>pi-web restart</code> on that machine (or restart its session daemon service) after changing these settings.`,
      });
    }
    return notices;
  }

  private renderUnavailableConfigState(): TemplateResult {
    return html`<div class="loading-card">${this.loading ? "Loading configuration…" : "Configuration is unavailable. Reload to try again."}</div>`;
  }

  private async saveAgentField(field: "command" | "dir", event: Event): Promise<void> {
    if (!(event.target instanceof HTMLInputElement)) return;
    const value = event.target.value.trim();
    const baseConfig = this.configResponse?.config ?? {};
    const nextConfig: PiWebConfigValues = { ...baseConfig };
    const nextAgent: NonNullable<PiWebConfigValues["agent"]> = { ...(baseConfig.agent ?? {}) };
    if (field === "command") {
      if (value === "") delete nextAgent.command;
      else nextAgent.command = value;
    } else if (value === "") {
      delete nextAgent.dir;
    } else {
      nextAgent.dir = value;
    }
    if (nextAgent.command === undefined && nextAgent.dir === undefined) {
      delete nextConfig.agent;
    } else {
      nextConfig.agent = nextAgent;
    }
    await this.onSave?.(nextConfig);
  }

  private async toggleSpawnSessions(event: Event): Promise<void> {
    const enabled = event.target instanceof HTMLInputElement && event.target.checked;
    await this.onSave?.(spawnSessionsConfigPatch(enabled));
  }

  private async toggleSubsessions(event: Event): Promise<void> {
    const enabled = event.target instanceof HTMLInputElement && event.target.checked;
    await this.onSave?.(subsessionsConfigPatch(enabled));
  }

  static override styles = css`
    :host { display: block; }
    h3 { margin: 0; font-size: 13px; line-height: 1.3; }
    button, input { font: inherit; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .loading-card, .config-path-card, .effective-card { border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); padding: 12px; }
    .loading-card { color: var(--pi-muted); }
    .config-path-card { display: grid; gap: 5px; }
    .config-path-card span, .field-heading, dt { color: var(--pi-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    code { border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-bg); padding: 1px 4px; color: var(--pi-text); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
    .field { display: grid; gap: 7px; }
    .field small { color: var(--pi-muted); line-height: 1.45; }
    .field-heading { display: flex; align-items: center; gap: 8px; }
    .toggle { display: flex; align-items: center; gap: 9px; cursor: pointer; }
    .toggle input { width: 16px; height: 16px; }
    .text-input { width: 100%; box-sizing: border-box; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); padding: 8px 9px; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .text-input:disabled { opacity: .65; cursor: not-allowed; }
    .toggle input:disabled { cursor: not-allowed; }
    .override-badge { border: 1px solid var(--pi-warning-border); border-radius: 999px; color: var(--pi-warning); background: var(--pi-warning-surface); padding: 2px 7px; font-size: 11px; font-weight: 600; text-transform: none; }
    .beta-badge { border: 1px solid var(--pi-border); border-radius: 999px; color: var(--pi-muted); background: var(--pi-bg); padding: 2px 7px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
    .effective-card { display: grid; gap: 10px; }
    .effective-card dl { display: grid; gap: 8px; margin: 0; }
    .effective-card dl > div { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 12px; align-items: baseline; }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .muted { color: var(--pi-muted); }

    @media (max-width: 760px) {
      .effective-card dl > div { grid-template-columns: minmax(0, 1fr); gap: 3px; }
    }
  `;
}

function sessiondDescription(targetLabel: string): string {
  return `These settings affect the long-lived session runtime on ${targetLabel}. Changes are saved immediately but only take effect after the session daemon on that machine restarts.`;
}
