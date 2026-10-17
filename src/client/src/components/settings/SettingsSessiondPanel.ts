import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import type { PiWebConfigResponse, PiWebConfigValues, SessionModel } from "../../api";
import "../CommandPicker";
import { isKnownThinkingLevel, KNOWN_THINKING_LEVELS } from "../../../../shared/thinkingLevels";
import { uiFormStyles } from "../ui/formStyles";
import { uiButtonStyles } from "../ui/controlStyles";
import { uiSettingsStyles } from "../ui/settingsStyles";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";
import { askUserConfigPatch, spawnSessionsConfigPatch, subsessionsConfigPatch } from "./settingsSessiondConfig";

@customElement("settings-sessiond-panel")
export class SettingsSessiondPanel extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) configResponse: PiWebConfigResponse | undefined;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) saving = false;
  @property() error = "";
  @property() savedMessage = "";
  @property() targetLabel = "local (local gateway)";
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onSave?: (config: PiWebConfigValues) => void | Promise<void>;

  @property({ attribute: false }) namingModels: SessionModel[] = [];
  @property({ type: Boolean }) namingModelsLoading = false;
  @property() namingModelsError = "";
  @state() private namingPickerOpen = false;

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("targetLabel") || (changed.has("loading") && this.loading)) this.namingPickerOpen = false;
  }

  override render(): TemplateResult {
    const config = this.configResponse;
    const namingOptions = this.namingModels.flatMap((model) => {
      if (model.provider === undefined || model.provider === "" || model.id === undefined || model.id === "") return [];
      const value = `${model.provider}/${model.id}`;
      return [{ value, label: model.name ?? model.id, description: value }];
    });
    const spawnOverridden = config?.envOverrides.spawnSessions === true;
    // On by default: the effective config is the source of truth for the toggle
    // state, so an unset config file still shows the feature as enabled.
    const effectiveSpawn = config?.effectiveConfig.spawnSessions !== false;
    const subsessionsOverridden = config?.envOverrides.subsessions === true;
    // On by default; also requires spawn to be enabled.
    const effectiveSubsessions = config?.effectiveConfig.subsessions === true && effectiveSpawn;
    const askUserOverridden = config?.envOverrides.askUser === true;
    const effectiveAskUser = config?.effectiveConfig.askUser === true;
    return html`
      <settings-panel-frame
        heading="Session daemon"
        .description=${sessiondDescription(this.targetLabel)}
        actionLabel="Refresh settings"
        .actionDisabled=${this.loading || this.saving}
        .notices=${this.panelNotices()}
        .onAction=${this.onReload}
      >
        <section class="ui-settings-section">
        ${config === undefined ? this.renderUnavailableConfigState() : html`
          <div class="config-path-card ui-settings-path">
            <span>Config file</span>
            <code>${config.path}</code>
          </div>
          <div class="field ui-form-field">
            <label class="toggle ui-checkbox-field">
              <input
                type="checkbox"
                id="spawn-sessions"
                aria-describedby="spawn-sessions-help"
                .checked=${live(effectiveSpawn)}
                ?disabled=${this.loading || this.saving || spawnOverridden}
                @change=${(event: Event) => { void this.toggleSpawnSessions(event); }}
              >
              <span>Allow agents to start sessions</span>
            </label>
            <small id="spawn-sessions-help">
              Agents can start sessions in any workspace of the same registered project with <code>spawn_session</code>.
              ${spawnOverridden ? html`Read-only because <code>PI_WEB_SPAWN_SESSIONS</code> overrides this setting. Change or remove it in the daemon environment to edit here.` : null}
            </small>
          </div>
          <div class="field ui-form-field">
            <label class="toggle ui-checkbox-field">
              <input
                type="checkbox"
                id="subsessions"
                aria-describedby="subsessions-help"
                .checked=${live(effectiveSubsessions)}
                ?disabled=${this.loading || this.saving || subsessionsOverridden || !effectiveSpawn}
                @change=${(event: Event) => { void this.toggleSubsessions(event); }}
              >
              <span>Allow agents to track child sessions</span>
            </label>
            <small id="subsessions-help">
              Agents can start child sessions, check progress, and receive completion notifications with <code>spawn_subsession</code>, <code>list_subsessions</code>, <code>check_subsession</code>, and <code>read_subsession</code>.
              ${!effectiveSpawn ? html`Enable “Allow agents to start sessions” first.` : html`Requires “Allow agents to start sessions”.`}
              ${subsessionsOverridden ? html`Read-only because <code>PI_WEB_SUBSESSIONS</code> overrides this setting. Change or remove it in the daemon environment to edit here.` : null}
            </small>
          </div>
          <div class="field ui-form-field">
            <label class="toggle ui-checkbox-field">
              <input
                type="checkbox"
                id="ask-user"
                aria-describedby="ask-user-help"
                .checked=${live(effectiveAskUser)}
                ?disabled=${this.loading || this.saving || askUserOverridden}
                @change=${(event: Event) => { void this.toggleAskUser(event); }}
              >
              <span>Allow agents to ask you questions</span>
            </label>
            <small id="ask-user-help">
              Agents can show a question form and wait for your answers with <code>ask_user</code>.
              ${askUserOverridden ? html`Read-only because <code>PI_WEB_ASK_USER</code> overrides this setting. Change or remove it in the daemon environment to edit here.` : null}
            </small>
          </div>
          <section class="effective-card ui-settings-summary" aria-labelledby="restart-summary-heading" aria-describedby="restart-summary-help">
            <h3 id="restart-summary-heading">After the next daemon restart</h3>
            <small id="restart-summary-help">Saved agent permissions with environment overrides applied. This does not show the running daemon’s active settings.</small>
            <dl>
              <div><dt>Spawn sessions</dt><dd>${effectiveSpawn ? "Enabled" : html`<span class="muted">Disabled</span>`}</dd></div>
              <div><dt>Subsessions</dt><dd>${effectiveSubsessions ? "Enabled" : html`<span class="muted">Disabled</span>`}</dd></div>
              <div><dt>Ask questions</dt><dd>${effectiveAskUser ? "Enabled" : html`<span class="muted">Disabled</span>`}</dd></div>
            </dl>
          </section>
          <h3>Session naming</h3>
          <div class="field ui-form-field">
            <span id="session-naming-model-label">Naming model</span>
            <button id="session-naming-model" class="ui-button ui-button--action naming-model"
              type="button" aria-labelledby="session-naming-model-label session-naming-model-value"
              aria-describedby="session-naming-model-help" aria-haspopup="dialog"
              ?disabled=${this.loading || this.saving || this.namingModelsLoading}
              @click=${() => { this.namingPickerOpen = true; }}>
              <span id="session-naming-model-value">${config.config.sessionNaming?.model ?? "Use session model"}</span>
              <span aria-hidden="true">▾</span>
            </button>
            <small id="session-naming-model-help">Search models available on this machine, or use the session model.</small>
            ${this.namingModelsLoading ? html`<small role="status">Loading naming models…</small>` : null}
            ${this.namingModelsError ? html`<small role="status">${this.namingModelsError} Refresh settings to try again. Your saved model is unchanged.</small>` : null}
            ${!this.namingModelsLoading && !this.namingModelsError && namingOptions.length === 0 ? html`<small role="status">No naming models are available. Configure a provider on this machine, then refresh settings.</small>` : null}
            ${!this.namingModelsLoading && !this.namingModelsError && config.config.sessionNaming?.model !== undefined && !namingOptions.some((option) => option.value === config.config.sessionNaming?.model) ? html`<small role="status">The saved naming model is unavailable. Choose another model or use the session model.</small>` : null}
          </div>
          <div class="field ui-form-field">
            <label for="session-naming-max-tokens">Naming token budget</label>
            <input id="session-naming-max-tokens" class="ui-input" type="number" min="1" max="9007199254740991" step="1" placeholder="24"
              aria-describedby="session-naming-max-tokens-help"
              .value=${live(String(config.config.sessionNaming?.maxTokens ?? ""))}
              ?disabled=${this.loading || this.saving}
              @change=${(event: Event) => {
                const input = event.target;
                if (!(input instanceof HTMLInputElement)) return;
                if (input.reportValidity()) void this.saveNamingField("maxTokens", input.value === "" ? undefined : input.valueAsNumber);
              }}>
            <small id="session-naming-max-tokens-help">Use a positive whole number. Clear to use 24 tokens, regardless of the model.</small>
          </div>
          <div class="field ui-form-field">
            <label for="session-naming-timeout">Naming timeout (seconds)</label>
            <input id="session-naming-timeout" class="ui-input" type="number" min="0.001" max="2147483.647" step="0.001" placeholder="10"
              aria-describedby="session-naming-timeout-help"
              .value=${live(config.config.sessionNaming?.timeoutMs === undefined ? "" : String(config.config.sessionNaming.timeoutMs / 1000))}
              ?disabled=${this.loading || this.saving}
              @change=${(event: Event) => {
                const input = event.target;
                if (!(input instanceof HTMLInputElement)) return;
                if (input.reportValidity()) void this.saveNamingField("timeoutMs", input.value === "" ? undefined : Math.round(input.valueAsNumber * 1000));
              }}>
            <small id="session-naming-timeout-help">Total timeout includes model loading. Increase it for cold local engines. Clear to use 10 seconds.</small>
          </div>
          <div class="field ui-form-field">
            <label for="session-naming-thinking-level">Naming thinking level</label>
            <select id="session-naming-thinking-level" class="ui-select"
              aria-describedby="session-naming-thinking-level-help"
              .value=${live(config.config.sessionNaming?.thinkingLevel ?? "")}
              ?disabled=${this.loading || this.saving}
              @change=${(event: Event) => {
                const input = event.target;
                if (!(input instanceof HTMLSelectElement)) return;
                if (input.value === "" || isKnownThinkingLevel(input.value)) {
                  void this.saveNamingField("thinkingLevel", input.value === "" ? undefined : input.value);
                }
              }}>
              <option value="">Default (minimal)</option>
              ${KNOWN_THINKING_LEVELS.map((level) => html`<option value=${level}>${level}</option>`)}
            </select>
            <small id="session-naming-thinking-level-help">Controls reasoning for naming only. Off disables optional thinking where supported; model support varies.</small>
          </div>
          <section class="effective-card ui-settings-summary" aria-labelledby="naming-summary-heading" aria-describedby="naming-summary-help">
            <h3 id="naming-summary-heading">For the next naming request</h3>
            <small id="naming-summary-help">Saved naming settings apply without a restart. Existing names and in-progress naming requests are unchanged.</small>
            <dl>
              <div><dt>Naming model</dt><dd>${config.effectiveConfig.sessionNaming?.model ?? "Use session model"}</dd></div>
              <div><dt>Naming token budget</dt><dd>${config.effectiveConfig.sessionNaming?.maxTokens ?? 24}</dd></div>
              <div><dt>Naming timeout</dt><dd>${(config.effectiveConfig.sessionNaming?.timeoutMs ?? 10000) / 1000} seconds</dd></div>
              <div><dt>Naming thinking level</dt><dd>${config.effectiveConfig.sessionNaming?.thinkingLevel ?? "minimal"}</dd></div>
            </dl>
          </section>
        `}
        </section>
      </settings-panel-frame>
      ${this.namingPickerOpen ? html`
        <command-picker title="Select naming model" searchable
          .options=${[
            { value: "", label: "Use session model", description: "Use the conversation’s model for naming." },
            ...(this.namingModelsLoading || this.namingModelsError ? [] : namingOptions),
          ]}
          .selectedValue=${config?.config.sessionNaming?.model ?? ""}
          .onCancel=${() => { this.namingPickerOpen = false; }}
          .onPick=${(value: string) => {
            if (this.loading || this.saving) return;
            if (value !== "" && (this.namingModelsLoading || this.namingModelsError || !namingOptions.some((option) => option.value === value))) return;
            this.namingPickerOpen = false;
            void this.saveNamingField("model", value === "" ? undefined : value);
          }}
        ></command-picker>
      ` : null}
    `;
  }

  private panelNotices(): readonly SettingsNotice[] {
    return sessiondPanelNotices({
      error: this.error,
      savedMessage: this.savedMessage,
    });
  }

  private renderUnavailableConfigState(): TemplateResult {
    return html`<div class="loading-card">${this.loading ? "Loading configuration…" : "Configuration is unavailable. Refresh settings to try again."}</div>`;
  }

  private async saveNamingField<K extends keyof NonNullable<PiWebConfigValues["sessionNaming"]>>(
    key: K, value: NonNullable<PiWebConfigValues["sessionNaming"]>[K],
  ): Promise<void> {
    const current = { ...this.configResponse?.config.sessionNaming, [key]: value };
    const sessionNaming = {
      ...(current.model === undefined ? {} : { model: current.model }),
      ...(current.maxTokens === undefined ? {} : { maxTokens: current.maxTokens }),
      ...(current.thinkingLevel === undefined ? {} : { thinkingLevel: current.thinkingLevel }),
      ...(current.timeoutMs === undefined ? {} : { timeoutMs: current.timeoutMs }),
    };
    await this.onSave?.({ sessionNaming });
  }

  private async toggleSpawnSessions(event: Event): Promise<void> {
    const enabled = event.target instanceof HTMLInputElement && event.target.checked;
    await this.onSave?.(spawnSessionsConfigPatch(enabled));
  }

  private async toggleSubsessions(event: Event): Promise<void> {
    const enabled = event.target instanceof HTMLInputElement && event.target.checked;
    await this.onSave?.(subsessionsConfigPatch(enabled));
  }

  private async toggleAskUser(event: Event): Promise<void> {
    const enabled = event.target instanceof HTMLInputElement && event.target.checked;
    await this.onSave?.(askUserConfigPatch(enabled));
  }

  static override styles = [uiButtonStyles, uiFormStyles, uiSettingsStyles, css`
    :host { display: block; }
    h3 { margin: 0; font-size: 13px; line-height: 1.3; }
    .loading-card { color: var(--pi-muted); }
    .config-path-card span, dt { color: var(--pi-muted); font-size: 12px; font-weight: 600; }
    code { border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-bg); padding: 1px 4px; color: var(--pi-text); font: 12px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); overflow-wrap: anywhere; }
    .field small, .effective-card small { color: var(--pi-muted); line-height: 1.45; }
    .naming-model { justify-content: space-between; text-align: start; gap: 12px; }
    #session-naming-model-value { min-width: 0; overflow-wrap: anywhere; }
    .effective-card dl { display: grid; gap: 8px; margin: 0; }
    .effective-card dl > div { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 12px; align-items: baseline; }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .muted { color: var(--pi-muted); }

    @media (max-width: 760px) {
      .effective-card dl > div { grid-template-columns: minmax(0, 1fr); gap: 3px; }
    }
  `];
}

export function sessiondDescription(targetLabel: string): string {
  return `Configure agent permissions and session naming on ${targetLabel}. Naming changes apply to the next naming request without a restart. Agent permission changes require that machine’s session daemon to restart. Restarting interrupts active sessions and running work.`;
}

export interface SessiondPanelNoticeContext {
  readonly error: string;
  readonly savedMessage: string;
}

/**
 * Compute the session-daemon panel's notice stack (error, then saved
 * confirmation) as a pure, publicly testable seam so tests assert the dynamic
 * notice logic and ordering here instead of scraping rendered `TemplateResult`
 * internals.
 */
export function sessiondPanelNotices(context: SessiondPanelNoticeContext): readonly SettingsNotice[] {
  const notices: SettingsNotice[] = [];
  if (context.error !== "") notices.push({ type: "error", content: context.error });
  if (context.savedMessage !== "") notices.push({ type: "success", content: context.savedMessage });
  return notices;
}
