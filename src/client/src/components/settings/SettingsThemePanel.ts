import { LocalizationController } from "../../localization/browser";
import { themeMessages as messages } from "./settingsAppearanceMessages";
import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { PiWebConfigResponse } from "../../api";
import { enforcedSetting, settingControls, type ResetSettings } from "./settingsConfigUpdate";
import type { QualifiedThemeContribution } from "../../plugins/types";
import { DEFAULT_THEME_PREFERENCE, type ThemePreference } from "../../theme";
import { uiButtonStyles } from "../ui/controlStyles";
import { uiFormStyles } from "../ui/formStyles";
import { uiSettingsStyles } from "../ui/settingsStyles";

@customElement("settings-theme-panel")
export class SettingsThemePanel extends LitElement {
  constructor() {
    super();
    new LocalizationController(this);
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) configResponse: PiWebConfigResponse | undefined;
  @property({ attribute: false }) onReset?: ResetSettings;
  @property({ attribute: false }) themes: readonly QualifiedThemeContribution[] = [];
  @property({ attribute: false }) preference: ThemePreference = DEFAULT_THEME_PREFERENCE;
  @property({ attribute: false }) defaultPreference: ThemePreference = DEFAULT_THEME_PREFERENCE;
  @property() activeThemeId = "";
  @property({ type: Boolean }) hasLocalOverride = false;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) saving = false;
  @property({ type: Boolean }) catalogLoading = false;
  @property() catalogError = "";
  @property({ attribute: false }) onRetryCatalog?: () => void;
  @property({ attribute: false }) onUseLocal?: (preference: ThemePreference) => void;
  @property({ attribute: false }) onSetDefault?: (preference: ThemePreference) => void | Promise<void>;
  @property({ attribute: false }) onUseDefault?: () => void;
  @state() private draft: ThemePreference = { ...DEFAULT_THEME_PREFERENCE };

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("preference")) this.draft = { ...this.preference };
    if (enforcedSetting(this.configResponse, "/defaultTheme") !== undefined) this.draft = { ...(this.configResponse?.effectiveConfig.defaultTheme ?? this.preference) };
  }

  protected override updated(): void {
    // Select values must be applied after their options have been rendered.
    const select = this.renderRoot.querySelector("select");
    if (select !== null) select.value = this.draft.themeId;
  }

  override render(): TemplateResult {
    const selectedAvailable = this.themes.some((theme) => theme.id === this.draft.themeId);
    const busy = this.loading || this.saving || enforcedSetting(this.configResponse, "/defaultTheme") !== undefined;
    const catalogBusy = busy || this.catalogLoading;
    const selectedUnavailable = !selectedAvailable && !this.catalogLoading && !this.catalogError;
    return html`
      <section class="theme-card ui-settings-section" aria-labelledby="theme-heading">
        <header class="ui-settings-heading">
          <h3 id="theme-heading">${messages.t("heading")}</h3>
          <p>${messages.t("description")}</p>
        </header>
        <div class="current-theme ui-settings-summary" role="status">
          <strong>${messages.t(this.hasLocalOverride ? "local" : "default")}</strong>
          <span>${messages.t("current", { name: this.themeName(this.activeThemeId || this.preference.themeId) })}</span>
          <span>${messages.t("gateway", { name: this.themeName(this.defaultPreference.themeId), auto: this.defaultPreference.auto ? "yes" : "no" })}</span>
        </div>
        ${this.catalogLoading ? html`<p role="status">${messages.t("catalogLoading")}</p>` : this.catalogError ? html`
          <div role="alert">
            <p>${messages.t("catalogError", { error: this.catalogError })}</p>
            ${this.onRetryCatalog ? html`<button class="ui-button ui-button--action" @click=${() => this.onRetryCatalog?.()}>${messages.t("retryCatalog")}</button>` : null}
          </div>
        ` : null}
        <label class="field ui-form-field">
          <span>${messages.t("heading")}</span>
          <select class="ui-input" aria-label=${messages.t("heading")} aria-describedby=${selectedUnavailable ? "theme-unavailable-help theme-scope-help" : "theme-scope-help"} ?disabled=${catalogBusy} @change=${(event: Event) => {
            if (event.target instanceof HTMLSelectElement) this.draft = { ...this.draft, themeId: event.target.value };
          }}>
            ${!selectedAvailable ? html`<option value=${this.draft.themeId}>${selectedUnavailable ? messages.t("unavailable", { id: this.draft.themeId }) : this.draft.themeId}</option>` : null}
            ${this.themes.map((theme) => html`<option value=${theme.id}>${theme.name}</option>`)}
          </select>
        </label>
        ${selectedUnavailable ? html`<p id="theme-unavailable-help" role="status">${messages.t("unavailableHelp")}</p>` : null}
        <label class="auto-field ui-checkbox-field">
          <input type="checkbox" .checked=${this.draft.auto} ?disabled=${catalogBusy} @change=${(event: Event) => {
            if (event.target instanceof HTMLInputElement) this.draft = { ...this.draft, auto: event.target.checked };
          }}>
          <span>${messages.t("auto")} <small>${messages.t("autoHelp")}</small></span>
        </label>
        <div class="theme-actions ui-settings-actions">
          <button class="primary ui-button ui-button--action ui-button--primary" ?disabled=${catalogBusy || !selectedAvailable} @click=${() => this.onUseLocal?.({ ...this.draft })}>${messages.t("useLocal")}</button>
          <button class="ui-button ui-button--action" ?disabled=${catalogBusy || !selectedAvailable} @click=${() => { void this.onSetDefault?.({ ...this.draft }); }}>${messages.t("setDefault")}</button>
          <button class="ui-button ui-button--action" ?disabled=${busy || !this.hasLocalOverride} @click=${() => this.onUseDefault?.()}>${messages.t("useDefault")}</button>
        </div>
        ${settingControls(this.configResponse, "/defaultTheme", this.loading || this.saving, this.onReset)}
        <p class="hint" id="theme-scope-help">${messages.t("scope")}</p>
      </section>
    `;
  }

  private themeName(id: string): string {
    return this.themes.find((theme) => theme.id === id)?.name ?? (this.catalogLoading || this.catalogError ? id : messages.t("unavailable", { id }));
  }

  static override styles = [uiButtonStyles, uiFormStyles, uiSettingsStyles, css`
    :host { display: block; }
    p { margin: 0; }
    p, small { color: var(--pi-muted); line-height: 1.45; }
    .current-theme span { color: var(--pi-text-secondary); font-size: 12px; overflow-wrap: anywhere; }
    .auto-field span { display: grid; gap: 3px; }
    .hint { font-size: 12px; }
  `];
}
