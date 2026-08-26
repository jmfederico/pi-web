import { css, html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { PiWebBreadcrumbMode, PiWebConfigResponse, PiWebConfigValues } from "../../api";
import type { QualifiedContributionId } from "../../plugins/types";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";

/** The minimum a workspace tool needs to appear in the pin list. */
export interface WorkspaceToolSummary {
  id: QualifiedContributionId;
  title: string;
  icon?: TemplateResult;
}

interface BreadcrumbOption {
  mode: PiWebBreadcrumbMode;
  label: string;
  detail: string;
}

const BREADCRUMB_OPTIONS: BreadcrumbOption[] = [
  { mode: "expanded", label: "Expanded", detail: "Show the full machine › project › workspace › session path." },
  { mode: "compact", label: "Compact", detail: "Show only the deepest level; tap it to open the rest." },
];

/**
 * Display & theme settings. Two gateway-wide preferences, persisted in
 * config.json: the context-bar breadcrumb style, and which workspace tools are
 * pinned to the tool bar. Both round-trip through the same PUT /api/config path
 * as the other gateway settings.
 */
@customElement("settings-display-panel")
export class SettingsDisplayPanel extends LitElement {
  @property({ attribute: false }) configResponse: PiWebConfigResponse | undefined;
  @property({ attribute: false }) tools: WorkspaceToolSummary[] = [];
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) saving = false;
  @property() error = "";
  @property() savedMessage = "";
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onSave?: (config: PiWebConfigValues) => void | Promise<void>;

  override render(): TemplateResult {
    return html`
      <settings-panel-frame
        heading="Display & theme"
        description="Appearance preferences saved in the gateway config. They apply to this gateway across your devices."
        actionLabel="Reload"
        .actionDisabled=${this.loading}
        .notices=${this.panelNotices()}
        .onAction=${() => { void this.onReload?.(); }}
      >
        <div class="settings-sections">
          ${this.renderBreadcrumbCard()}
          ${this.renderPinnedToolsCard()}
        </div>
      </settings-panel-frame>
    `;
  }

  private renderBreadcrumbCard(): TemplateResult {
    const current = this.currentBreadcrumbMode();
    return html`
      <section class="settings-card" aria-label="Breadcrumb settings">
        <div class="card-heading">
          <h3>Breadcrumb</h3>
          <p>How the mobile top bar shows your current location.</p>
        </div>
        <div class="options" role="radiogroup" aria-label="Breadcrumb style">
          ${BREADCRUMB_OPTIONS.map((option) => this.renderBreadcrumbOption(option, current))}
        </div>
      </section>
    `;
  }

  private renderBreadcrumbOption(option: BreadcrumbOption, current: PiWebBreadcrumbMode): TemplateResult {
    const selected = option.mode === current;
    return html`
      <label class=${`option${selected ? " selected" : ""}`}>
        <input
          type="radio"
          name="breadcrumb-mode"
          .checked=${selected}
          ?disabled=${this.saving || this.loading}
          @change=${() => { void this.selectBreadcrumbMode(option.mode); }}
        >
        <span class="option-copy">
          <strong>${option.label}</strong>
          <small>${option.detail}</small>
        </span>
      </label>
    `;
  }

  private renderPinnedToolsCard(): TemplateResult {
    const pinned = this.pinnedSet();
    const allPinned = this.configResponse?.config.pinnedWorkspaceTools === undefined;
    return html`
      <section class="settings-card" aria-label="Pinned workspace tools">
        <div class="card-heading">
          <h3>Tool bar</h3>
          <p>Which workspace tools stay one tap away on the mobile tool bar. When none are customized, every tool is pinned.</p>
        </div>
        ${this.tools.length === 0 ? html`<div class="loading-card">${this.loading ? "Loading tools…" : "No workspace tools are available to pin."}</div>` : html`
          <div class="tool-list">
            ${this.tools.map((tool) => this.renderToolRow(tool, pinned.has(tool.id)))}
          </div>
          <footer class="card-actions">
            <button class="secondary" ?disabled=${allPinned || this.saving} @click=${() => { void this.resetPins(); }}>Pin all tools</button>
          </footer>
        `}
      </section>
    `;
  }

  private renderToolRow(tool: WorkspaceToolSummary, pinned: boolean): TemplateResult {
    return html`
      <label class="tool-row">
        <input type="checkbox" .checked=${pinned} ?disabled=${this.saving || this.loading} @change=${() => { void this.togglePin(tool.id); }}>
        ${tool.icon === undefined ? null : html`<span class="tool-icon" aria-hidden="true">${tool.icon}</span>`}
        <span class="tool-name">${tool.title}</span>
      </label>
    `;
  }

  private panelNotices(): readonly SettingsNotice[] {
    const notices: SettingsNotice[] = [];
    if (this.error !== "") notices.push({ type: "error", content: this.error });
    if (this.savedMessage !== "") notices.push({ type: "success", content: this.savedMessage });
    return notices;
  }

  private currentBreadcrumbMode(): PiWebBreadcrumbMode {
    return this.configResponse?.config.breadcrumbMode ?? "expanded";
  }

  // The effective pin set: the stored list, or every tool when unset ("all").
  private pinnedSet(): Set<string> {
    const stored = this.configResponse?.config.pinnedWorkspaceTools;
    return new Set<string>(stored ?? this.tools.map((tool) => tool.id));
  }

  private async selectBreadcrumbMode(mode: PiWebBreadcrumbMode): Promise<void> {
    if (mode === this.currentBreadcrumbMode()) return;
    const next = this.baseConfig();
    // "expanded" is the default, so store it as an absent key.
    if (mode === "expanded") delete next.breadcrumbMode;
    else next.breadcrumbMode = mode;
    await this.onSave?.(next);
  }

  private async togglePin(id: QualifiedContributionId): Promise<void> {
    const pinned = this.pinnedSet();
    if (pinned.has(id)) pinned.delete(id);
    else pinned.add(id);
    const next = this.baseConfig();
    // Cover every tool → store as absent ("all"), so tools added later stay pinned.
    if (this.tools.every((tool) => pinned.has(tool.id))) delete next.pinnedWorkspaceTools;
    else next.pinnedWorkspaceTools = this.tools.filter((tool) => pinned.has(tool.id)).map((tool) => tool.id);
    await this.onSave?.(next);
  }

  private async resetPins(): Promise<void> {
    const next = this.baseConfig();
    delete next.pinnedWorkspaceTools;
    await this.onSave?.(next);
  }

  private baseConfig(): PiWebConfigValues {
    return { ...(this.configResponse?.config ?? {}) };
  }

  static override styles = css`
    :host { display: block; }
    .settings-sections { display: grid; gap: 14px; }
    .settings-card, .loading-card { border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); padding: 12px; }
    .settings-card { display: grid; gap: 12px; }
    .card-heading { display: grid; gap: 6px; min-width: 0; }
    h3, p { margin: 0; }
    h3 { font-size: 13px; line-height: 1.3; }
    p { color: var(--pi-muted); line-height: 1.45; }
    .loading-card { color: var(--pi-muted); }
    .options { display: grid; gap: 8px; }
    .option { display: flex; align-items: flex-start; gap: 10px; border: 1px solid var(--pi-border); border-radius: 9px; background: var(--pi-bg); padding: 10px 12px; cursor: pointer; }
    .option.selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .option input { margin: 2px 0 0; }
    .option-copy { display: grid; gap: 2px; min-width: 0; }
    .option-copy strong { font-weight: 600; }
    .option-copy small { color: var(--pi-muted); }
    .tool-list { display: grid; gap: 2px; }
    .tool-row { display: flex; align-items: center; gap: 10px; padding: 8px 6px; border-radius: 8px; cursor: pointer; }
    .tool-row:hover { background: var(--pi-surface-hover); }
    .tool-icon { flex: 0 0 auto; width: 18px; height: 18px; display: inline-grid; place-items: center; color: var(--pi-muted); }
    .tool-icon svg { width: 18px; height: 18px; }
    .tool-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    input { accent-color: var(--pi-accent); }
    input:disabled { cursor: not-allowed; }
    .card-actions { display: flex; justify-content: flex-end; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; font: inherit; cursor: pointer; }
    button:disabled { opacity: .55; cursor: not-allowed; }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-display-panel": SettingsDisplayPanel;
  }
}
