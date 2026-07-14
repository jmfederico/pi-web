import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ActiveAgentProfileDescriptor, PiWebConfigResponse, PiWebConfigValues } from "../../api";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";
import { agentProfileConfigPatchFromDraft, agentProfileDraftFromConfig, agentProfileDraftMatchesConfig, emptyAgentProfileConfigDraft, type AgentProfileConfigDraft } from "./settingsConfigDraft";
import type { AgentProfileSettingsSupport } from "./settingsMachineTarget";
import { agentDirFieldOverridden, agentProfileActivationState, spawnSessionsConfigPatch, subsessionsConfigPatch } from "./settingsSessiondConfig";

@customElement("settings-sessiond-panel")
export class SettingsSessiondPanel extends LitElement {
  @property({ attribute: false }) configResponse: PiWebConfigResponse | undefined;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) saving = false;
  @property() error = "";
  @property() savedMessage = "";
  @property() targetLabel = "local (local gateway)";
  @property({ attribute: false }) activeAgentProfile: ActiveAgentProfileDescriptor | undefined;
  @property({ attribute: false }) agentProfileSupport: AgentProfileSettingsSupport = { state: "supported" };
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onSave?: (config: PiWebConfigValues) => void | Promise<void>;
  @state() private agentDraft: AgentProfileConfigDraft = emptyAgentProfileConfigDraft();
  @state() private agentDraftDirty = false;
  @state() private agentLocalError = "";

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has("configResponse")) return;
    if (this.configResponse === undefined) {
      this.agentDraft = emptyAgentProfileConfigDraft();
      this.agentDraftDirty = false;
      this.agentLocalError = "";
      return;
    }
    if (!this.agentDraftDirty || agentProfileDraftMatchesConfig(this.agentDraft, this.configResponse.config)) {
      this.agentDraft = agentProfileDraftFromConfig(this.configResponse.config);
      this.agentDraftDirty = false;
      this.agentLocalError = "";
    }
  }

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
    const profileEditingSupported = this.agentProfileSupport.state === "supported";
    const draftCommand = agentCommandOverridden ? (config.effectiveConfig.agent?.command ?? this.agentDraft.command) : this.agentDraft.command;
    const agentDirLocked = agentDirFieldOverridden(config?.envOverrides, draftCommand);
    const effectiveAgentDirOverridden = config?.envOverrides.agentDir === true;
    const effectiveAgent = config?.effectiveConfig.agent;
    const profileActivation = agentProfileActivationState(config, this.activeAgentProfile);
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
          <form class="profile-form" aria-label="Pi-compatible agent profile" @submit=${(event: Event) => { void this.saveAgentProfile(event); }}>
            ${profileEditingSupported ? null : html`<div class="profile-support-message">${this.agentProfileSupport.message ?? "Pi-compatible agent profile editing is unavailable for this machine."}</div>`}
            <label class="field">
              <span class="field-heading">
                <span>Companion CLI command</span>
                ${agentCommandOverridden ? html`<span class="override-badge">environment override</span>` : null}
              </span>
              <input
                class="text-input"
                type="text"
                autocomplete="off"
                spellcheck="false"
                .value=${this.agentDraft.command}
                placeholder="pi"
                ?disabled=${this.loading || this.saving || !profileEditingSupported || agentCommandOverridden}
                @input=${(event: Event) => { this.updateAgentDraft({ command: inputValue(event) }); }}
              >
              <small>Set the Pi-compatible companion CLI used for doctor and update checks. The embedded session runtime remains PI WEB's bundled Pi SDK.</small>
            </label>
            <label class="field">
              <span class="field-heading">
                <span>Profile state directory</span>
                ${effectiveAgentDirOverridden ? html`<span class="override-badge">environment override</span>` : null}
              </span>
              <input
                class="text-input"
                type="text"
                autocomplete="off"
                spellcheck="false"
                .value=${this.agentDraft.dir}
                placeholder="~/.pi/agent or ~/agent-profiles/work"
                ?disabled=${this.loading || this.saving || !profileEditingSupported || agentDirLocked}
                @input=${(event: Event) => { this.updateAgentDraft({ dir: inputValue(event) }); }}
              >
              <small>Choose the Pi-compatible auth, models, settings, and sessions PI WEB reads. An alternate command and its required state directory are saved together.</small>
            </label>
            <footer class="form-actions">
              <button class="primary" type="submit" ?disabled=${this.loading || this.saving || !profileEditingSupported || (agentCommandOverridden && agentDirLocked)}>${this.saving ? "Saving…" : "Save agent profile"}</button>
            </footer>
          </form>
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
          <section class="effective-card" aria-label="Desired and active session daemon configuration summary">
            <h3>Desired after environment overrides</h3>
            <dl>
              <div><dt>Desired command</dt><dd>${effectiveAgent?.command ?? html`<span class="muted">Unavailable</span>`}</dd></div>
              <div><dt>Desired state</dt><dd>${effectiveAgent?.dir ?? html`<span class="muted">Unavailable</span>`}</dd></div>
              <div><dt>Active command</dt><dd>${this.activeAgentProfile?.command ?? html`<span class="muted">Unavailable</span>`}</dd></div>
              <div><dt>Active state</dt><dd>${this.activeAgentProfile?.dir ?? html`<span class="muted">Unavailable</span>`}</dd></div>
              <div><dt>Profile status</dt><dd>${profileActivationLabel(profileActivation)}</dd></div>
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
    const error = this.agentLocalError || this.error;
    if (error !== "") notices.push({ type: "error", content: error });
    if (this.savedMessage !== "") notices.push({ type: "success", content: this.savedMessage });
    const activation = agentProfileActivationState(config, this.activeAgentProfile);
    if (activation === "restart-required") {
      notices.push({
        type: "warning",
        title: `Pi-compatible agent profile restart required on ${this.targetLabel}`,
        content: html`The desired profile differs from the active session-daemon profile. Run <code>pi-web restart</code> on that machine (or restart its session daemon service) to apply the command and state directory together.`,
      });
    } else if (config !== undefined && activation === "unavailable" && this.agentProfileSupport.state === "supported") {
      notices.push({
        type: "info",
        title: `Active Pi-compatible agent profile unavailable on ${this.targetLabel}`,
        content: "PI WEB cannot compare the desired profile with the running session daemon. Reload after the daemon is available.",
      });
    }
    return notices;
  }

  private renderUnavailableConfigState(): TemplateResult {
    return html`<div class="loading-card">${this.loading ? "Loading configuration…" : "Configuration is unavailable. Reload to try again."}</div>`;
  }

  private async saveAgentProfile(event: Event): Promise<void> {
    event.preventDefault();
    this.agentLocalError = "";
    try {
      await this.onSave?.(agentProfileConfigPatchFromDraft(this.agentDraft));
    } catch (error) {
      this.agentLocalError = errorMessage(error);
    }
  }

  private updateAgentDraft(patch: Partial<AgentProfileConfigDraft>): void {
    this.agentDraft = { ...this.agentDraft, ...patch };
    this.agentDraftDirty = true;
    this.agentLocalError = "";
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
    .loading-card, .config-path-card, .effective-card, .profile-support-message { border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); padding: 12px; }
    .loading-card { color: var(--pi-muted); }
    .config-path-card { display: grid; gap: 5px; }
    .profile-form { display: grid; gap: 14px; }
    .profile-support-message { color: var(--pi-muted); line-height: 1.45; }
    .form-actions { display: flex; justify-content: flex-end; }
    .primary { border-color: var(--pi-accent); background: var(--pi-accent); color: var(--pi-accent-contrast); }
    .config-path-card span, .field-heading, dt { color: var(--pi-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    code { border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-bg); padding: 1px 4px; color: var(--pi-text); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
    .field { display: grid; gap: 7px; }
    .field small { color: var(--pi-muted); line-height: 1.45; }
    .field-heading { display: flex; align-items: center; gap: 8px; }
    .toggle { display: flex; align-items: center; gap: 9px; cursor: pointer; }
    .toggle input { width: 16px; height: 16px; }
    .text-input {
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      border: 1px solid var(--pi-border);
      border-radius: 8px;
      background: var(--pi-bg);
      color: var(--pi-text);
      padding: 8px 9px;
      outline: none;
      font: var(--pi-control-font-size, 16px) var(--pi-control-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
    }
    .text-input:focus { border-color: var(--pi-accent); box-shadow: 0 0 0 1px var(--pi-accent-border); }
    .text-input:disabled { opacity: .55; cursor: not-allowed; }
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

function profileActivationLabel(state: ReturnType<typeof agentProfileActivationState>): string | TemplateResult {
  if (state === "active") return "Active";
  if (state === "restart-required") return "Restart required";
  return html`<span class="muted">Unavailable</span>`;
}

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessiondDescription(targetLabel: string): string {
  return `Select the Pi-compatible agent profile and companion CLI for ${targetLabel}. Changes are saved immediately but only take effect after the session daemon on that machine restarts.`;
}
