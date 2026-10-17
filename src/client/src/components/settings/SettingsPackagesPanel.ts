import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { css, html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { PiPackageInfo, PiPackageInstallableSuggestion, PiPackageScope, PiPackagesResponse } from "../../api";
import { uiButtonStyles } from "../ui/controlStyles";
import { uiFormStyles } from "../ui/formStyles";
import { uiSettingsStyles } from "../ui/settingsStyles";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";
import { isPiPackageOperationPending, normalizePiPackageSource, piPackageFilteredLabel, piPackageInstalledPathLabel, piPackageScopeLabel, piPackageSourceValidationMessage, piPackageTargetContext, piPackageTargetLabel, piPackageUpdateDisabledReason, updateAllPiPackagesDisabledReason, type PiPackageOperationState, type PiPackageTargetContext } from "./piPackageSettings";

@customElement("settings-packages-panel")
export class SettingsPackagesPanel extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) packagesResponse: PiPackagesResponse | undefined;
  @property({ type: Boolean }) loading = false;
  @property({ attribute: false }) operation: PiPackageOperationState | undefined;
  @property({ attribute: false }) targetMachine: PiPackageTargetContext | undefined;
  @property() error = "";
  @property() operationMessage = "";
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onInstallPackage?: (source: string) => void | Promise<void>;
  @property({ attribute: false }) onRemovePackage?: (source: string, scope: PiPackageScope) => void | Promise<void>;
  @property({ attribute: false }) onUpdatePackage?: (source?: string) => void | Promise<void>;
  @state() private installSource = "";
  @state() private validationMessage = "";

  override render(): TemplateResult {
    const packages = this.packagesResponse?.packages ?? [];
    const target = this.packageTarget;
    const targetLabel = piPackageTargetLabel(target);
    const showPackageControls = this.packagesResponse !== undefined;
    return html`
      <settings-panel-frame
        heading="Pi packages"
        .description=${packagesDescription(targetLabel)}
        actionLabel="Refresh package list"
        actionTitle=${`Refresh Pi packages from ${targetLabel}`}
        .actionDisabled=${this.loading || this.isOperating}
        .notices=${this.panelNotices(showPackageControls)}
        .onAction=${this.onReload}
      >
        ${this.renderPanelContent(packages, target, targetLabel)}
      </settings-panel-frame>
    `;
  }

  private panelNotices(showTrustedCodeWarning: boolean): readonly SettingsNotice[] {
    const notices: SettingsNotice[] = [];
    if (this.error !== "") {
      notices.push({ type: "error", content: this.error });
    }
    if (this.operationMessage !== "") notices.push({ type: "success", content: this.operationMessage });
    if (showTrustedCodeWarning) {
      notices.push({
        type: "security",
        content: html`<strong>Trusted code warning:</strong> Pi packages and PI WEB plugins can run with your user permissions. Install packages and enable plugins only from sources you trust.`,
      });
    }
    return notices;
  }

  private renderPanelContent(packages: PiPackageInfo[], target: PiPackageTargetContext, targetLabel: string): TemplateResult | null {
    if (this.packagesResponse === undefined) {
      return html`<div class="loading-card ui-settings-summary">${this.loading ? `Loading Pi packages from ${targetLabel}…` : `Pi package list unavailable for ${targetLabel}. Choose Refresh package list to try again.`}</div>`;
    }
    return html`
      ${this.renderInstallableKnownPackages(targetLabel)}
      ${this.renderInstallForm(targetLabel)}
      ${this.renderPackageList(packages, target)}
    `;
  }

  private renderInstallableKnownPackages(targetLabel: string): TemplateResult | null {
    const suggestions = this.packagesResponse?.installableKnownPackages ?? [];
    if (suggestions.length === 0) return null;
    return html`
      <section class="known-package-section ui-settings-section" aria-label="Available known Pi packages">
        <div class="ui-settings-heading">
          <h3>Available packages</h3>
          <p>Install a package included with PI WEB on ${targetLabel}.</p>
        </div>
        <div class="known-package-list ui-settings-list">
          ${suggestions.map((suggestion) => this.renderInstallableKnownPackage(suggestion))}
        </div>
      </section>
    `;
  }

  private renderInstallableKnownPackage(suggestion: PiPackageInstallableSuggestion): TemplateResult {
    const installing = isPiPackageOperationPending(this.operation, "install", suggestion.source);
    return html`
      <article class="known-package-card ui-settings-row">
        <div class="package-main">
          <strong>${suggestion.label}</strong>
          <small>${suggestion.description}</small>
        </div>
        <button class="ui-button ui-button--action ui-button--primary" title=${`Install ${suggestion.label}`} aria-label=${`Install ${suggestion.label}`} ?disabled=${this.isOperating} @click=${() => { void this.installKnownPackage(suggestion.source); }}>${installing ? "Installing…" : "Install"}</button>
      </article>
    `;
  }

  private renderInstallForm(targetLabel: string): TemplateResult {
    return html`
      <form class="install-card ui-settings-section" @submit=${(event: Event) => { void this.installPackage(event); }}>
        <label class="ui-form-field" for="package-source">Pi package source</label>
        <div class="install-row">
          <input class="ui-input" id="package-source" aria-describedby="package-source-help package-source-error" aria-invalid=${this.validationMessage !== "" ? "true" : "false"} .value=${this.installSource} ?disabled=${this.isOperating} placeholder="npm:@scope/package, git URL, or local path" @input=${(event: Event) => { this.updateInstallSource(event); }}>
          <button class="ui-button ui-button--action ui-button--primary" type="submit" title="Install this Pi package" ?disabled=${this.isOperating}>${isPiPackageOperationPending(this.operation, "install") ? "Installing…" : "Install"}</button>
        </div>
        <div id="package-source-error" class="field-error" role="alert">${this.validationMessage}</div>
        <small id="package-source-help">Enter an npm package, Git URL, or path on ${targetLabel}. Packages install in Pi’s default location, as with <code>pi install &lt;source&gt;</code>.</small>
      </form>
    `;
  }

  private renderPackageList(packages: PiPackageInfo[], target: PiPackageTargetContext): TemplateResult {
    const targetLabel = piPackageTargetLabel(target);
    const updateAllReason = updateAllPiPackagesDisabledReason(packages);
    const showUpdateAllReason = updateAllReason !== undefined && packages.length > 0;
    const updateAllTitle = updateAllReason ?? "Update all user-scope Pi packages";
    return html`
      <section class="package-section ui-settings-section" aria-label="Configured Pi packages">
        <div class="package-toolbar">
          <div class="ui-settings-heading">
            <h3>Configured Pi packages</h3>
            <p>This list comes from Pi's package manager settings on ${targetLabel}.</p>
          </div>
          <button class="secondary ui-button ui-button--action" title=${updateAllTitle} ?disabled=${this.isOperating || updateAllReason !== undefined} @click=${() => { void this.updatePackage(); }}>
            ${isPiPackageOperationPending(this.operation, "update-all") ? "Updating…" : "Update all"}
          </button>
        </div>
        ${showUpdateAllReason ? html`<div class="action-note">${updateAllReason}</div>` : null}
        ${this.loading && packages.length > 0 ? html`<div class="action-note">Refreshing Pi packages from ${targetLabel}…</div>` : null}
        ${this.renderPackageListContent(packages, targetLabel)}
      </section>
    `;
  }

  private renderPackageListContent(packages: PiPackageInfo[], targetLabel: string): TemplateResult {
    if (this.loading && packages.length === 0) return html`<div class="loading-card ui-settings-summary">Loading Pi packages from ${targetLabel}…</div>`;
    if (packages.length === 0) return html`<div class="loading-card ui-settings-summary">No Pi packages configured in Pi settings on ${targetLabel} yet.</div>`;
    return html`
      <div class="package-list ui-settings-list">
        ${packages.map((packageInfo) => this.renderPackage(packageInfo))}
      </div>
    `;
  }

  private renderPackage(packageInfo: PiPackageInfo): TemplateResult {
    const updateReason = piPackageUpdateDisabledReason(packageInfo);
    const updating = isPiPackageOperationPending(this.operation, "update", packageInfo.source);
    const removing = isPiPackageOperationPending(this.operation, "remove", packageInfo.source);
    return html`
      <article class=${`package-card ui-settings-row${packageInfo.filtered ? " filtered" : ""}`}>
        <div class="package-main">
          <strong>${packageInfo.source}</strong>
          <small>${piPackageScopeLabel(packageInfo)} · ${piPackageFilteredLabel(packageInfo)}</small>
          <small>Installed path: <code>${piPackageInstalledPathLabel(packageInfo)}</code></small>
          ${updateReason === undefined ? null : html`<small class="action-note">${updateReason}</small>`}
        </div>
        <div class="package-actions ui-settings-actions">
          <button class="secondary ui-button ui-button--action" aria-label=${`Update ${packageInfo.source}`} title=${updateReason ?? "Update this Pi package"} ?disabled=${this.isOperating || updateReason !== undefined} @click=${() => { void this.updatePackage(packageInfo.source); }}>${updating ? "Updating…" : "Update"}</button>
          <button class="danger ui-button ui-button--action" aria-label=${`Remove ${packageInfo.source}`} title="Remove this Pi package" ?disabled=${this.isOperating} @click=${() => { void this.removePackage(packageInfo); }}>${removing ? "Removing…" : "Remove"}</button>
        </div>
      </article>
    `;
  }

  private updateInstallSource(event: Event): void {
    this.installSource = event.target instanceof HTMLInputElement ? event.target.value : "";
    this.validationMessage = "";
  }

  private async installPackage(event: Event): Promise<void> {
    event.preventDefault();
    const validationMessage = piPackageSourceValidationMessage(this.installSource);
    if (validationMessage !== undefined) {
      this.validationMessage = validationMessage;
      return;
    }

    const source = normalizePiPackageSource(this.installSource);
    try {
      await this.onInstallPackage?.(source);
      this.installSource = "";
      this.validationMessage = "";
    } catch {
      // The parent owns network error presentation so package errors are consistent across Settings.
    }
  }

  private async removePackage(packageInfo: PiPackageInfo): Promise<void> {
    try {
      await this.onRemovePackage?.(packageInfo.source, packageInfo.scope);
    } catch {
      // The parent owns network error presentation so package errors are consistent across Settings.
    }
  }

  private async installKnownPackage(source: string): Promise<void> {
    try {
      await this.onInstallPackage?.(source);
    } catch {
      // The parent owns network error presentation so package errors are consistent across Settings.
    }
  }

  private async updatePackage(source?: string): Promise<void> {
    try {
      await this.onUpdatePackage?.(source);
    } catch {
      // The parent owns network error presentation so package errors are consistent across Settings.
    }
  }

  private get packageTarget(): PiPackageTargetContext {
    return this.targetMachine ?? piPackageTargetContext(undefined);
  }

  private get isOperating(): boolean {
    return this.operation !== undefined;
  }

  static override styles = [uiButtonStyles, uiFormStyles, uiSettingsStyles, css`
    :host { display: block; }
    .package-toolbar { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 14px; }
    .package-toolbar > div { flex: 1 1 240px; min-width: 0; }
    .package-main { flex: 1 1 240px; display: grid; gap: 6px; min-width: 0; }
    small { color: var(--pi-muted); line-height: 1.45; }
    .secondary { flex: 0 0 auto; }
    .field-error { color: var(--pi-danger); font-size: 12px; }
    .field-error:empty { display: none; }
    .install-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
    .known-package-section, .package-section { padding: 0; gap: 0; }
    .known-package-section > .ui-settings-heading, .package-toolbar { padding: 16px; }
    .loading-card, .action-note { color: var(--pi-muted); }
    .action-note { font-size: 12px; }
    .package-section > .action-note { padding: 0 16px 12px; }
    .package-card, .known-package-card { align-items: center; }
    .package-card.filtered { opacity: .82; }
    .package-main strong, .package-main small { overflow-wrap: anywhere; }
    code { color: var(--pi-text); font: 12px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); overflow-wrap: anywhere; }

    @media (max-width: 760px) {
      .install-row { grid-template-columns: minmax(0, 1fr); }
      .install-row > .ui-button { justify-self: start; }
      .package-main { flex-basis: 100%; }
    }
  `];
}

function packagesDescription(targetLabel: string): TemplateResult {
  return html`Managing Pi packages on <strong>${targetLabel}</strong>. Install, remove, and update packages managed by Pi on the selected machine. Pi packages can provide extensions, skills, prompt templates, themes, context/system prompt files, and PI WEB browser plugins.`;
}
