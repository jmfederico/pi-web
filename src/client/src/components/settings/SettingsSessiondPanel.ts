import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { guard } from "lit/directives/guard.js";
import { LocalizationController, localization } from "../../localization/browser";
import source from "./settingsSessiond.messages";

import type { PiWebConfigResponse, PiWebConfigValues, SessionModel } from "../../api";
import "../CommandPicker";
import { isKnownThinkingLevel, KNOWN_THINKING_LEVELS } from "../../../../shared/thinkingLevels";
import { uiFormStyles } from "../ui/formStyles";
import { uiButtonStyles } from "../ui/controlStyles";
import { uiSettingsStyles } from "../ui/settingsStyles";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";
import { enforcedSetting, settingControls, type ResetSettings } from "./settingsConfigUpdate";
import { askUserConfigPatch, sessionMessagesConfigPatch, spawnSessionsConfigPatch, subsessionsConfigPatch } from "./settingsSessiondConfig";

export const sessiondMessages = localization.registerMessages("core.settingsSessiond", source);
const codeTag = (chunks: unknown[]): TemplateResult => html`<code dir="ltr">${chunks}</code>`;

@customElement("settings-sessiond-panel")
export class SettingsSessiondPanel extends LitElement {
  constructor() {
    super();
    new LocalizationController(this);
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) configResponse: PiWebConfigResponse | undefined;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) saving = false;
  @property() error = "";
  @property() savedMessage = "";
  @property() targetLabel = "";
  @property() targetId = "local";
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onReset?: ResetSettings;
  @property({ attribute: false }) onSave?: (config: PiWebConfigValues, unset?: string[]) => void | Promise<void>;

  @property({ attribute: false }) namingModels: SessionModel[] = [];
  @property({ type: Boolean }) namingModelsLoading = false;
  @property() namingModelsError = "";
  @state() private namingPickerOpen = false;

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("targetId") || (changed.has("loading") && this.loading)) this.namingPickerOpen = false;
  }

  override render(): TemplateResult {
    const response = this.configResponse;
    const inheritedNaming = response?.defaultsConfig?.sessionNaming;
    const config = response?.effectiveConfig.sessionNaming === undefined ? response : { ...response, config: { ...response.config, sessionNaming: response.effectiveConfig.sessionNaming } };
    const namingOptions = this.namingModels.flatMap((model) => {
      if (model.provider === undefined || model.provider === "" || model.id === undefined || model.id === "") return [];
      const value = `${model.provider}/${model.id}`;
      return [{ value, label: model.name ?? model.id, description: value }];
    });
    const spawnOverridden = enforcedSetting(config, "/spawnSessions") !== undefined;
    // On by default: the effective config is the source of truth for the toggle
    // state, so an unset config file still shows the feature as enabled.
    const effectiveSpawn = config?.effectiveConfig.spawnSessions !== false;
    const subsessionsOverridden = enforcedSetting(config, "/subsessions") !== undefined;
    // On by default; also requires spawn to be enabled.
    const effectiveSubsessions = config?.effectiveConfig.subsessions === true && effectiveSpawn;
    const sessionMessagesOverridden = enforcedSetting(config, "/sessionMessages") !== undefined;
    const effectiveSessionMessages = config?.effectiveConfig.sessionMessages !== false;
    const askUserOverridden = enforcedSetting(config, "/askUser") !== undefined;
    const effectiveAskUser = config?.effectiveConfig.askUser === true;
    return html`
      <settings-panel-frame
        .heading=${sessiondMessages.t("heading")}
        .description=${sessiondMessages.t("description", { target: this.targetLabel || sessiondMessages.t("selectedMachine") })}
        .actionLabel=${sessiondMessages.t("refresh")}
        .actionDisabled=${this.loading || this.saving}
        .notices=${this.panelNotices()}
        .onAction=${this.onReload}
      >
        <section class="ui-settings-section">
        ${config === undefined ? this.renderUnavailableConfigState() : html`
          <div class="config-path-card ui-settings-path">
            <span>${sessiondMessages.t("configFile")}</span>
            <code dir="ltr">${config.path}</code>
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
              <span>${sessiondMessages.t("spawn")}</span>
            </label>
            <small id="spawn-sessions-help">
              ${sessiondMessages.rich("spawnHelp", { code: codeTag, tool: "spawn_session" })}
              ${spawnOverridden ? sessiondMessages.rich("envOverride", { variable: "PI_WEB_SPAWN_SESSIONS", code: codeTag }) : null}
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
              <span>${sessiondMessages.t("subsessions")}</span>
            </label>
            <small id="subsessions-help">
              ${sessiondMessages.rich("subsessionsHelp", { code: codeTag, spawn: "spawn_subsession", list: "list_subsessions", check: "check_subsession", read: "read_subsession" })}
              ${sessiondMessages.t(!effectiveSpawn ? "enableSpawn" : "spawnRequired")}
              ${subsessionsOverridden ? sessiondMessages.rich("envOverride", { variable: "PI_WEB_SUBSESSIONS", code: codeTag }) : null}
            </small>
          </div>
          <div class="field ui-form-field">
            <label class="toggle ui-checkbox-field">
              <input
                type="checkbox"
                id="session-messages"
                aria-describedby="session-messages-help"
                .checked=${live(effectiveSessionMessages)}
                ?disabled=${this.loading || this.saving || sessionMessagesOverridden}
                @change=${(event: Event) => { void this.toggleSessionMessages(event); }}
              >
              <span>${sessiondMessages.t("sessionMessages")}</span>
            </label>
            <small id="session-messages-help">
              ${sessiondMessages.rich("sessionMessagesHelp", { code: codeTag, tool: "send_session_message" })}
              ${sessionMessagesOverridden ? sessiondMessages.rich("envOverride", { variable: "PI_WEB_SESSION_MESSAGES", code: codeTag }) : null}
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
              <span>${sessiondMessages.t("askUser")}</span>
            </label>
            <small id="ask-user-help">
              ${sessiondMessages.rich("askUserHelp", { code: codeTag, tool: "ask_user" })}
              ${askUserOverridden ? sessiondMessages.rich("envOverride", { variable: "PI_WEB_ASK_USER", code: codeTag }) : null}
            </small>
          </div>
          ${["spawnSessions", "subsessions", "sessionMessages", "askUser"].map((key) => settingControls(config, `/${key}`, this.loading || this.saving, this.onReset))}
          <section class="effective-card ui-settings-summary" aria-labelledby="restart-summary-heading" aria-describedby="restart-summary-help">
            <h3 id="restart-summary-heading">${sessiondMessages.t("restartHeading")}</h3>
            <small id="restart-summary-help">${sessiondMessages.t("restartHelp")}</small>
            <dl>
              <div><dt>${sessiondMessages.t("spawnSummary")}</dt><dd>${effectiveSpawn ? sessiondMessages.t("enabled") : html`<span class="muted">${sessiondMessages.t("disabled")}</span>`}</dd></div>
              <div><dt>${sessiondMessages.t("subsessionsSummary")}</dt><dd>${effectiveSubsessions ? sessiondMessages.t("enabled") : html`<span class="muted">${sessiondMessages.t("disabled")}</span>`}</dd></div>
              <div><dt>${sessiondMessages.t("sessionMessagesSummary")}</dt><dd>${effectiveSessionMessages ? sessiondMessages.t("enabled") : html`<span class="muted">${sessiondMessages.t("disabled")}</span>`}</dd></div>
              <div><dt>${sessiondMessages.t("askUserSummary")}</dt><dd>${effectiveAskUser ? sessiondMessages.t("enabled") : html`<span class="muted">${sessiondMessages.t("disabled")}</span>`}</dd></div>
            </dl>
          </section>
          <h3>${sessiondMessages.t("naming")}</h3>
          ${settingControls(response, "/sessionNaming", this.loading || this.saving, this.onReset)}
          <fieldset class="naming-fields" aria-label=${sessiondMessages.t("naming")}>
          <div class="field ui-form-field">
            <span id="session-naming-model-label">${sessiondMessages.t("model")}</span>
            <button id="session-naming-model" class="ui-button ui-button--action naming-model"
              type="button" aria-labelledby="session-naming-model-label session-naming-model-value"
              aria-describedby="session-naming-model-help" aria-haspopup="dialog"
              ?disabled=${this.loading || this.saving || this.namingModelsLoading || enforcedSetting(response, "/sessionNaming/model") !== undefined}
              @click=${() => { this.namingPickerOpen = true; }}>
              <span id="session-naming-model-value">${config.config.sessionNaming?.model === undefined ? sessiondMessages.t("useSessionModel") : html`<bdi dir="ltr">${config.config.sessionNaming.model}</bdi>`}</span>
              <span aria-hidden="true">▾</span>
            </button>
            ${settingControls(response, "/sessionNaming/model", this.loading || this.saving, this.onReset)}
            <small id="session-naming-model-help">${sessiondMessages.t("modelHelp")}</small>
            ${this.namingModelsLoading ? html`<small role="status">${sessiondMessages.t("modelsLoading")}</small>` : null}
            ${this.namingModelsError ? html`<small role="status">${sessiondMessages.t("modelsError", { error: this.namingModelsError })}</small>` : null}
            ${!this.namingModelsLoading && !this.namingModelsError && namingOptions.length === 0 ? html`<small role="status">${sessiondMessages.t("modelsEmpty")}</small>` : null}
            ${!this.namingModelsLoading && !this.namingModelsError && config.config.sessionNaming?.model !== undefined && !namingOptions.some((option) => option.value === config.config.sessionNaming?.model) ? html`<small role="status">${sessiondMessages.t("modelUnavailable")}</small>` : null}
          </div>
          <div class="field ui-form-field">
            <label for="session-naming-max-tokens">${sessiondMessages.t("budget")}</label>
            <input id="session-naming-max-tokens" class="ui-input" type="number" min="1" max="9007199254740991" step="1" placeholder="24"
              aria-describedby="session-naming-max-tokens-help"
              ?disabled=${this.loading || this.saving || enforcedSetting(response, "/sessionNaming/maxTokens") !== undefined}
              .value=${guard([this.targetId, config.config.sessionNaming?.maxTokens], () => live(String(config.config.sessionNaming?.maxTokens ?? "")))}
              @change=${(event: Event) => {
                const input = event.target;
                if (!(input instanceof HTMLInputElement)) return;
                if (input.reportValidity()) void this.saveNamingField("maxTokens", input.value === "" ? undefined : input.valueAsNumber);
              }}>
            ${settingControls(response, "/sessionNaming/maxTokens", this.loading || this.saving, this.onReset)}
            <small id="session-naming-max-tokens-help">${sessiondMessages.t("budgetHelp", { tokens: inheritedNaming?.maxTokens ?? 24 })}</small>
          </div>
          <div class="field ui-form-field">
            <label for="session-naming-timeout">${sessiondMessages.t("timeout")}</label>
            <input id="session-naming-timeout" class="ui-input" type="number" min="0.001" max="2147483.647" step="0.001" placeholder="10"
              aria-describedby="session-naming-timeout-help"
              ?disabled=${this.loading || this.saving || enforcedSetting(response, "/sessionNaming/timeoutMs") !== undefined}
              .value=${guard([this.targetId, config.config.sessionNaming?.timeoutMs], () => live(config.config.sessionNaming?.timeoutMs === undefined ? "" : String(config.config.sessionNaming.timeoutMs / 1000)))}
              @change=${(event: Event) => {
                const input = event.target;
                if (!(input instanceof HTMLInputElement)) return;
                if (input.reportValidity()) void this.saveNamingField("timeoutMs", input.value === "" ? undefined : Math.round(input.valueAsNumber * 1000));
              }}>
            ${settingControls(response, "/sessionNaming/timeoutMs", this.loading || this.saving, this.onReset)}
            <small id="session-naming-timeout-help">${sessiondMessages.t("timeoutHelp", { seconds: (inheritedNaming?.timeoutMs ?? 10000) / 1000 })}</small>
          </div>
          <div class="field ui-form-field">
            <label for="session-naming-thinking-level">${sessiondMessages.t("thinking")}</label>
            <select id="session-naming-thinking-level" class="ui-select"
              aria-describedby="session-naming-thinking-level-help"
              ?disabled=${this.loading || this.saving || enforcedSetting(response, "/sessionNaming/thinkingLevel") !== undefined}
              .value=${live(config.config.sessionNaming?.thinkingLevel ?? "")}
              @change=${(event: Event) => {
                const input = event.target;
                if (!(input instanceof HTMLSelectElement)) return;
                if (input.value === "" || isKnownThinkingLevel(input.value)) {
                  void this.saveNamingField("thinkingLevel", input.value === "" ? undefined : input.value);
                }
              }}>
              <option value="">${sessiondMessages.t("defaultThinking", { level: inheritedNaming?.thinkingLevel ?? "minimal" })}</option>
              ${KNOWN_THINKING_LEVELS.map((level) => html`<option value=${level}>${level}</option>`)}
            </select>
            ${settingControls(response, "/sessionNaming/thinkingLevel", this.loading || this.saving, this.onReset)}
            <small id="session-naming-thinking-level-help">${sessiondMessages.t("thinkingHelp")}</small>
          </div>
          </fieldset>
          <section class="effective-card ui-settings-summary" aria-labelledby="naming-summary-heading" aria-describedby="naming-summary-help">
            <h3 id="naming-summary-heading">${sessiondMessages.t("namingSummary")}</h3>
            <small id="naming-summary-help">${sessiondMessages.t("namingSummaryHelp")}</small>
            <dl>
              <div><dt>${sessiondMessages.t("model")}</dt><dd>${config.effectiveConfig.sessionNaming?.model === undefined ? sessiondMessages.t("useSessionModel") : html`<bdi dir="ltr">${config.effectiveConfig.sessionNaming.model}</bdi>`}</dd></div>
              <div><dt>${sessiondMessages.t("budget")}</dt><dd>${localization.number(config.effectiveConfig.sessionNaming?.maxTokens ?? 24)}</dd></div>
              <div><dt>${sessiondMessages.t("timeoutSummary")}</dt><dd>${sessiondMessages.t("seconds", { count: (config.effectiveConfig.sessionNaming?.timeoutMs ?? 10000) / 1000 })}</dd></div>
              <div><dt>${sessiondMessages.t("thinking")}</dt><dd>${config.effectiveConfig.sessionNaming?.thinkingLevel ?? "minimal"}</dd></div>
            </dl>
          </section>
        `}
        </section>
      </settings-panel-frame>
      ${this.namingPickerOpen ? html`
        <command-picker .title=${sessiondMessages.t("selectModel")} searchable
          .options=${[
            { value: "", label: sessiondMessages.t(inheritedNaming?.model === undefined ? "useSessionModel" : "useConfiguredModel"),
              description: inheritedNaming?.model === undefined ? sessiondMessages.t("sessionModelHelp") : sessiondMessages.t("configuredModelHelp", { model: inheritedNaming.model }) },
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
    return html`<div class="loading-card">${sessiondMessages.t(this.loading ? "loading" : "unavailable")}</div>`;
  }

  private async saveNamingField<K extends keyof NonNullable<PiWebConfigValues["sessionNaming"]>>(
    key: K, value: NonNullable<PiWebConfigValues["sessionNaming"]>[K],
  ): Promise<void> {
    const path = `/sessionNaming/${key}`;
    if (this.loading || this.saving || enforcedSetting(this.configResponse, path) !== undefined) return;
    if (value === undefined) await this.onSave?.({}, [path]);
    else if (value !== this.configResponse?.effectiveConfig.sessionNaming?.[key]) await this.onSave?.({ sessionNaming: { [key]: value } });
  }

  private async toggleSpawnSessions(event: Event): Promise<void> {
    const enabled = event.target instanceof HTMLInputElement && event.target.checked;
    await this.onSave?.(spawnSessionsConfigPatch(enabled));
  }

  private async toggleSubsessions(event: Event): Promise<void> {
    const enabled = event.target instanceof HTMLInputElement && event.target.checked;
    await this.onSave?.(subsessionsConfigPatch(enabled));
  }

  private async toggleSessionMessages(event: Event): Promise<void> {
    const enabled = event.target instanceof HTMLInputElement && event.target.checked;
    await this.onSave?.(sessionMessagesConfigPatch(enabled));
  }

  private async toggleAskUser(event: Event): Promise<void> {
    const enabled = event.target instanceof HTMLInputElement && event.target.checked;
    await this.onSave?.(askUserConfigPatch(enabled));
  }

  static override styles = [uiButtonStyles, uiFormStyles, uiSettingsStyles, css`
    :host { display: block; overflow-wrap: anywhere; }
    h3 { margin: 0; font-size: 13px; line-height: 1.3; }
    .loading-card { color: var(--pi-muted); }
    .config-path-card span, dt { color: var(--pi-muted); font-size: 12px; font-weight: 600; }
    code { border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-bg); padding: 1px 4px; color: var(--pi-text); font: 12px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); overflow-wrap: anywhere; }
    .field small, .effective-card small { color: var(--pi-muted); line-height: 1.45; }
    .naming-fields { border: 0; padding: 0; margin: 0; min-width: 0; display: grid; gap: 12px; }
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
