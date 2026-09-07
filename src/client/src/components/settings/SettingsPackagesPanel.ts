import { css, html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { PiPackageInfo, PiPackageInstallableSuggestion, PiPackageScope, PiPackagesResponse } from "../../api";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";
import { isPiPackageOperationPending, normalizePiPackageSource, piPackageFilteredLabel, piPackageInstalledPathLabel, piPackageScopeLabel, piPackageSourceValidationMessage, piPackageTargetContext, piPackageTargetLabel, piPackageUpdateDisabledReason, updateAllPiPackagesDisabledReason, type PiPackageOperationState, type PiPackageTargetContext } from "./piPackageSettings";

@customElement("settings-packages-panel")
export class SettingsPackagesPanel extends LitElement {
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
        actionLabel="Reload"
        actionTitle=${`Reload Pi packages from ${targetLabel}`}
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
      return html`<div class="loading-card">${this.loading ? `Loading Pi packages from ${targetLabel}…` : `Pi package list unavailable for ${targetLabel}. Use Reload to try again.`}</div>`;
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
      <section class="known-package-section" aria-label="Available known Pi packages">
        <h3>Available packages</h3>
        <p>PI WEB ships these packages so you can install them on ${targetLabel} with one click, with no path to type — including one you previously removed.</p>
        <div class="known-package-list">
          ${suggestions.map((suggestion) => this.renderInstallableKnownPackage(suggestion))}
        </div>
      </section>
    `;
  }

  private renderInstallableKnownPackage(suggestion: PiPackageInstallableSuggestion): TemplateResult {
    const installing = isPiPackageOperationPending(this.operation, "install", suggestion.source);
    return html`
      <article class="known-package-card">
        <div class="package-main">
          <strong>${suggestion.label}</strong>
          <small>${suggestion.description}</small>
        </div>
        <button title=${`Install ${suggestion.label}`} ?disabled=${this.isOperating} @click=${() => { void this.installKnownPackage(suggestion.source); }}>${installing ? "Installing…" : "Install"}</button>
      </article>
    `;
  }

  private renderInstallForm(targetLabel: string): TemplateResult {
    return html`
      <form class="install-card" @submit=${(event: Event) => { void this.installPackage(event); }}>
        <label for="package-source">Pi package source</label>
        <div class="install-row">
          <input id="package-source" .value=${this.installSource} ?disabled=${this.isOperating} placeholder="npm:@scope/package, git URL, or local path" @input=${(event: Event) => { this.updateInstallSource(event); }}>
          <button type="submit" title="Install this Pi package" ?disabled=${this.isOperating}>${isPiPackageOperationPending(this.operation, "install") ? "Installing…" : "Install"}</button>
        </div>
        ${this.validationMessage === "" ? null : html`<div class="field-error">${this.validationMessage}</div>`}
        <small>Installs run on ${targetLabel} and use Pi's default package location, equivalent to <code>pi install &lt;source&gt;</code>. PI WEB does not ask you to choose an install location.</small>
      </form>
    `;
  }

  private renderPackageList(packages: PiPackageInfo[], target: PiPackageTargetContext): TemplateResult {
    const targetLabel = piPackageTargetLabel(target);
    const updateAllReason = updateAllPiPackagesDisabledReason(packages);
    const showUpdateAllReason = updateAllReason !== undefined && packages.length > 0;
    const updateAllTitle = updateAllReason ?? "Update all user-scope Pi packages";
    return html`
      <section class="package-section" aria-label="Configured Pi packages">
        <div class="package-toolbar">
          <div>
            <h3>Configured Pi packages</h3>
            <p>This list comes from Pi's package manager settings on ${targetLabel}.</p>
          </div>
          <button class="secondary" title=${updateAllTitle} ?disabled=${this.isOperating || updateAllReason !== undefined} @click=${() => { void this.updatePackage(); }}>
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
    if (this.loading && packages.length === 0) return html`<div class="loading-card">Loading Pi packages from ${targetLabel}…</div>`;
    if (packages.length === 0) return html`<div class="loading-card">No Pi packages configured in Pi settings on ${targetLabel} yet.</div>`;
    return html`
      <div class="package-list">
        ${packages.map((packageInfo) => this.renderPackage(packageInfo))}
      </div>
    `;
  }

  private renderPackage(packageInfo: PiPackageInfo): TemplateResult {
    const updateReason = piPackageUpdateDisabledReason(packageInfo);
    const updating = isPiPackageOperationPending(this.operation, "update", packageInfo.source);
    const removing = isPiPackageOperationPending(this.operation, "remove", packageInfo.source);
    return html`
      <article class=${`package-card${packageInfo.filtered ? " filtered" : ""}`}>
        <div class="package-main">
          <strong>${packageInfo.source}</strong>
          <small>${piPackageScopeLabel(packageInfo)} · ${piPackageFilteredLabel(packageInfo)}</small>
          <small>Installed path: <code>${piPackageInstalledPathLabel(packageInfo)}</code></small>
          ${updateReason === undefined ? null : html`<small class="action-note">${updateReason}</small>`}
        </div>
        <div class="package-actions">
          <button class="secondary" title=${updateReason ?? "Update this Pi package"} ?disabled=${this.isOperating || updateReason !== undefined} @click=${() => { void this.updatePackage(packageInfo.source); }}>${updating ? "Updating…" : "Update"}</button>
          <button class="danger" title="Remove this Pi package" ?disabled=${this.isOperating} @click=${() => { void this.removePackage(packageInfo); }}>${removing ? "Removing…" : "Remove"}</button>
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

  static override styles = css`
    :host { display: block; }
    .package-toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
    .package-toolbar > div, .package-main { display: grid; gap: 6px; min-width: 0; }
    h3, p { margin: 0; }
    h3 { font-size: 15px; line-height: 1.25; }
    p, small { color: var(--pi-muted); line-height: 1.45; }
    button, input { font: inherit; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
    button:disabled, input:disabled { opacity: .55; cursor: not-allowed; }
    input { box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); padding: 8px 9px; }
    label { font-weight: 700; }
    .secondary { flex: 0 0 auto; }
    .danger { border-color: color-mix(in srgb, var(--pi-danger) 55%, var(--pi-border)); color: var(--pi-danger); }
    .loading-card, .install-card, .package-card { border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); padding: 12px; }
    .field-error { color: var(--pi-danger); font-size: 12px; }
    .install-card { display: grid; gap: 8px; }
    .install-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
    .package-section { display: block; }
    .known-package-section { display: grid; gap: 8px; margin-bottom: 14px; }
    .known-package-list { display: grid; gap: 10px; }
    .known-package-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); padding: 12px; }
    .loading-card, .action-note { color: var(--pi-muted); }
    .action-note { margin-bottom: 10px; font-size: 12px; }
    .package-list { display: grid; gap: 10px; }
    .package-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; }
    .package-card.filtered { opacity: .82; }
    .package-main strong, .package-main small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .package-actions { display: flex; align-items: center; gap: 8px; }
    code { border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-bg); padding: 1px 4px; color: var(--pi-text); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }

    @media (max-width: 760px) {
      .package-toolbar { display: grid; gap: 12px; }
      .package-toolbar .secondary { justify-self: start; }
      .install-row, .package-card, .known-package-card { grid-template-columns: minmax(0, 1fr); align-items: start; }
      .package-actions { justify-self: start; flex-wrap: wrap; }
      .package-main strong, .package-main small { white-space: normal; }
    }
  `;
}

function packagesDescription(targetLabel: string): TemplateResult {
  return html`Managing Pi packages on <strong>${targetLabel}</strong>. Install, remove, and update packages managed by Pi on the selected machine. Pi packages can provide extensions, skills, prompt templates, themes, context/system prompt files, and PI WEB browser plugins.`;
}
