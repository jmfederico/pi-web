import { css, html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { PiWebConfigResponse, PiWebPluginInfo, PiWebPluginsResponse } from "../../api";

@customElement("settings-plugins-panel")
export class SettingsPluginsPanel extends LitElement {
  @property({ attribute: false }) pluginsResponse: PiWebPluginsResponse | undefined;
  @property({ attribute: false }) configResponse: PiWebConfigResponse | undefined;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) saving = false;
  @property() error = "";
  @property() savedMessage = "";
  @property() targetLabel = "local (local gateway)";
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onTogglePlugin?: (pluginId: string, enabled: boolean) => void | Promise<void>;

  override render(): TemplateResult {
    const plugins = this.pluginsResponse?.plugins ?? [];
    return html`
      <div class="section-heading">
        <div>
          <h2>PI WEB plugins</h2>
          <p>Enable or disable discovered PI WEB browser plugins on <strong>${this.targetLabel}</strong>. This is separate from installing Pi packages. Reload the browser tab to apply plugin runtime changes.</p>
        </div>
        <button class="secondary" ?disabled=${this.loading} @click=${() => { void this.onReload?.(); }}>Reload</button>
      </div>
      ${this.renderMessages()}
      <div class="trust-warning"><strong>Trusted code warning:</strong> PI WEB plugins and Pi packages can run with your user permissions. Enable plugins only from sources you trust.</div>
      <div class="plugin-note">Config key on ${this.targetLabel}: <code>plugins</code>. Plugins are enabled unless their entry sets <code>enabled</code> to <code>false</code>.</div>
      ${this.configResponse === undefined && !this.loading ? html`<div class="loading-card">Configuration is unavailable. Reload to try again before changing plugin enablement.</div>` : null}
      ${this.loading && plugins.length === 0 ? html`<div class="loading-card">Loading PI WEB plugins…</div>` : plugins.length === 0 ? html`<div class="loading-card">No PI WEB browser plugins discovered on ${this.targetLabel}.</div>` : html`
        <div class="plugin-list">
          ${plugins.map((plugin) => this.renderPlugin(plugin))}
        </div>
      `}
    `;
  }

  private renderMessages(): TemplateResult | null {
    if (this.error !== "") return html`<div class="message error-message">${this.error}</div>`;
    if (this.savedMessage !== "") return html`<div class="message success-message">${this.savedMessage} Reload the browser tab to apply plugin changes.</div>`;
    return null;
  }

  private renderPlugin(plugin: PiWebPluginInfo): TemplateResult {
    const configured = this.configResponse?.config.plugins?.[plugin.id];
    const configuredState = configured?.enabled === false ? "Config disabled" : configured?.enabled === true ? "Config enabled" : "Default enabled";
    return html`
      <article class=${`plugin-card${plugin.enabled ? "" : " disabled"}`}>
        <div class="plugin-main">
          <strong>${plugin.id}</strong>
          <small>${plugin.source} · ${plugin.scope}${plugin.machineSpecific ? " · machine-specific" : ""}</small>
          <small>${configuredState}</small>
        </div>
        <label class="toggle">
          <input type="checkbox" .checked=${plugin.enabled} ?disabled=${this.saving || this.configResponse === undefined} @change=${(event: Event) => { void this.togglePlugin(plugin, event); }}>
          <span>${plugin.enabled ? "Enabled" : "Disabled"}</span>
        </label>
      </article>
    `;
  }

  private async togglePlugin(plugin: PiWebPluginInfo, event: Event): Promise<void> {
    const enabled = event.target instanceof HTMLInputElement ? event.target.checked : plugin.enabled;
    await this.onTogglePlugin?.(plugin.id, enabled);
  }

  static override styles = css`
    :host { display: block; }
    .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
    .section-heading > div { display: grid; gap: 6px; min-width: 0; }
    h2, p { margin: 0; }
    h2 { font-size: 17px; line-height: 1.25; }
    p { color: var(--pi-muted); line-height: 1.45; }
    button, input { font: inherit; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
    button:disabled, input:disabled { opacity: .55; cursor: not-allowed; }
    .secondary { flex: 0 0 auto; }
    .message, .loading-card, .trust-warning, .plugin-note, .plugin-card { border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); padding: 12px; }
    .message, .trust-warning { margin-bottom: 12px; }
    .error-message { border-color: var(--pi-danger); color: var(--pi-danger); background: color-mix(in srgb, var(--pi-danger) 10%, var(--pi-surface)); }
    .success-message { border-color: var(--pi-success-border); color: var(--pi-success); background: var(--pi-success-surface); }
    .loading-card, .plugin-note { color: var(--pi-muted); }
    .trust-warning { border-color: var(--pi-warning-border); color: var(--pi-text); background: var(--pi-warning-surface); line-height: 1.45; }
    .plugin-note { margin-bottom: 14px; }
    code { border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-bg); padding: 1px 4px; color: var(--pi-text); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
    .plugin-list { display: grid; gap: 10px; }
    .plugin-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; }
    .plugin-card.disabled { opacity: .75; }
    .plugin-main { min-width: 0; display: grid; gap: 3px; }
    .plugin-main strong, .plugin-main small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .plugin-main small { color: var(--pi-muted); }
    .toggle { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
    .toggle input { width: 18px; height: 18px; accent-color: var(--pi-accent); }

    @media (max-width: 760px) {
      .section-heading { display: grid; gap: 12px; }
      .section-heading .secondary { justify-self: start; }
      .plugin-card { grid-template-columns: minmax(0, 1fr); align-items: start; }
      .toggle { justify-self: start; }
    }
  `;
}
