import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { css, html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { LocalizationController, localization } from "../../localization/browser";
import source from "./settingsSessiond.messages";

import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";
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
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onReset?: ResetSettings;
  @property({ attribute: false }) onSave?: (config: PiWebConfigValues, unset?: string[]) => void | Promise<void>;

  override render(): TemplateResult {
    const config = this.configResponse;
    const spawnOverridden = enforcedSetting(config, "/spawnSessions") !== undefined;
    // On by default: use saved effective values, not running daemon state.
    const effectiveSpawn = config?.effectiveConfig.spawnSessions !== false;
    const subsessionsOverridden = enforcedSetting(config, "/subsessions") !== undefined;
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
        .notices=${sessiondPanelNotices({ error: this.error, savedMessage: this.savedMessage })}
        .onAction=${this.onReload}
      >
        <section class="ui-settings-section">
        ${config === undefined ? html`<div class="loading-card">${sessiondMessages.t(this.loading ? "loading" : "unavailable")}</div>` : html`
          <div class="config-path-card ui-settings-path">
            <span>${sessiondMessages.t("configFile")}</span>
            <code dir="ltr">${config.path}</code>
          </div>
          <div class="field ui-form-field">
            <label class="toggle ui-checkbox-field">
              <input type="checkbox" id="spawn-sessions" aria-describedby="spawn-sessions-help"
                .checked=${live(effectiveSpawn)} ?disabled=${this.loading || this.saving || spawnOverridden}
                @change=${(event: Event) => { void this.toggleSpawnSessions(event); }}>
              <span>${sessiondMessages.t("spawn")}</span>
            </label>
            <small id="spawn-sessions-help">
              ${sessiondMessages.rich("spawnHelp", { code: codeTag, tool: "spawn_session" })}
              ${spawnOverridden ? sessiondMessages.rich("envOverride", { variable: "PI_WEB_SPAWN_SESSIONS", code: codeTag }) : null}
            </small>
          </div>
          <div class="field ui-form-field">
            <label class="toggle ui-checkbox-field">
              <input type="checkbox" id="subsessions" aria-describedby="subsessions-help"
                .checked=${live(effectiveSubsessions)} ?disabled=${this.loading || this.saving || subsessionsOverridden || !effectiveSpawn}
                @change=${(event: Event) => { void this.toggleSubsessions(event); }}>
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
              <input type="checkbox" id="session-messages" aria-describedby="session-messages-help"
                .checked=${live(effectiveSessionMessages)} ?disabled=${this.loading || this.saving || sessionMessagesOverridden}
                @change=${(event: Event) => { void this.toggleSessionMessages(event); }}>
              <span>${sessiondMessages.t("sessionMessages")}</span>
            </label>
            <small id="session-messages-help">
              ${sessiondMessages.rich("sessionMessagesHelp", { code: codeTag, tool: "send_session_message" })}
              ${sessionMessagesOverridden ? sessiondMessages.rich("envOverride", { variable: "PI_WEB_SESSION_MESSAGES", code: codeTag }) : null}
            </small>
          </div>
          <div class="field ui-form-field">
            <label class="toggle ui-checkbox-field">
              <input type="checkbox" id="ask-user" aria-describedby="ask-user-help"
                .checked=${live(effectiveAskUser)} ?disabled=${this.loading || this.saving || askUserOverridden}
                @change=${(event: Event) => { void this.toggleAskUser(event); }}>
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
        `}
        </section>
      </settings-panel-frame>
    `;
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

/** Compute error and save feedback in display order. */
export function sessiondPanelNotices(context: SessiondPanelNoticeContext): readonly SettingsNotice[] {
  const notices: SettingsNotice[] = [];
  if (context.error !== "") notices.push({ type: "error", content: context.error });
  if (context.savedMessage !== "") notices.push({ type: "success", content: context.savedMessage });
  return notices;
}
