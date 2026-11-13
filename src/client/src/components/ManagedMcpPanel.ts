import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ManagedMcpContext, ManagedMcpScope, ManagedMcpServerView, ManagedMcpView } from "../../../shared/managedMcp";
import { managedMcpApi } from "../api/managedMcp";
import { LocalizationController, localization } from "../localization/browser";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { uiButtonStyles } from "./ui/controlStyles";
import { uiFormStyles } from "./ui/formStyles";
import { uiSettingsStyles } from "./ui/settingsStyles";
import { uiNoticeStyles } from "./ui/noticeStyles";
import source from "./managedMcp.messages";
import "./settings/SettingsPanelFrame";

export const managedMcpMessages = localization.registerMessages("core.managedMcp", source);
const m = managedMcpMessages;
const configExample = JSON.stringify({ mcp: { servers: { docs: { url: "https://mcp.example.com/mcp" } } } }, null, 2);
export interface ManagedMcpPanelContext extends ManagedMcpContext { machineId: string }
interface Draft { serverName: string; scope: ManagedMcpScope; enabled: boolean }
function sameContext(a: ManagedMcpPanelContext | undefined, b: ManagedMcpPanelContext | undefined): boolean {
  return a?.machineId === b?.machineId && a?.cwd === b?.cwd && a?.sessionId === b?.sessionId;
}

@customElement("managed-mcp-panel")
export class ManagedMcpPanel extends LitElement {
  constructor() {
    super();
    new LocalizationController(this);
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false, hasChanged: (a: ManagedMcpPanelContext | undefined, b: ManagedMcpPanelContext | undefined) => !sameContext(a, b) })
  context: ManagedMcpPanelContext | undefined;
  @property() machineLabel = "";
  @property() sessionLabel = "";
  @state() private view: ManagedMcpView | undefined;
  @state() private loading = false;
  @state() private saving: Draft | undefined;
  @state() private drafts: Draft[] = [];
  @state() private failure: { kind: "loadError" | "saveError" | "copyError"; error: string; serverName?: string } | undefined;
  @state() private feedback: "saved" | "copied" | undefined;
  private generation = 0;
  private viewContext: ManagedMcpPanelContext | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.hasUpdated) void this.reload();
  }
  override disconnectedCallback(): void {
    ++this.generation;
    this.view = undefined;
    this.drafts = [];
    super.disconnectedCallback();
  }
  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("context")) void this.reload();
  }
  private current(generation: number, context: ManagedMcpPanelContext): boolean {
    return this.isConnected && generation === this.generation && sameContext(context, this.context);
  }
  private async reload(): Promise<void> {
    const generation = ++this.generation;
    this.view = undefined;
    this.viewContext = undefined;
    this.drafts = [];
    this.failure = undefined;
    this.feedback = undefined;
    this.saving = undefined;
    this.loading = false;
    if (this.context === undefined || !this.isConnected) return;
    const context = { ...this.context };
    this.loading = true;
    try {
      const view = await managedMcpApi.get(context, context.machineId);
      if (this.current(generation, context)) { this.view = view; this.viewContext = context; }
    } catch (error) {
      if (this.current(generation, context)) this.failure = { kind: "loadError", error: errorMessage(error) };
    } finally {
      if (this.current(generation, context)) this.loading = false;
    }
  }
  private scopes(): ManagedMcpScope[] {
    return ["global", ...(this.context?.cwd === undefined ? [] : ["project" as const]), ...(this.context?.sessionId === undefined ? [] : ["session" as const])];
  }
  private lockedReason(server: ManagedMcpServerView, scope: ManagedMcpScope): string | undefined {
    if (server.nativeConflict === true) return m.t("nativeHelp");
    if (scope === "global" && server.definitionScope === "project") return m.t("globalDefinitionOnly");
    if (this.view?.projectTrusted === false && (scope === "project" || server.definitionScope === "project")) return m.t("untrusted");
    if (server.enabled[scope] === undefined) return m.t("unavailable");
    if (this.view?.[`${scope}Writable`] !== true) return m.t("locked");
    return undefined;
  }
  private change(server: ManagedMcpServerView, scope: ManagedMcpScope, enabled: boolean): void {
    if (!sameContext(this.viewContext, this.context) || this.saving !== undefined || this.lockedReason(server, scope) !== undefined) return;
    const draft = { serverName: server.name, scope, enabled };
    this.feedback = undefined;
    if (scope === "session") { void this.save(draft); return; }
    this.drafts = this.drafts.filter((item) => item.serverName !== server.name || item.scope !== scope);
    if (enabled !== server.enabled[scope]) this.drafts = [...this.drafts, draft];
  }
  private async save(draft: Draft): Promise<void> {
    const server = this.view?.servers.find((row) => row.name === draft.serverName);
    if (!sameContext(this.viewContext, this.context) || this.context === undefined || this.view === undefined || server === undefined
      || this.saving !== undefined || this.lockedReason(server, draft.scope) !== undefined) return;
    const context = { ...this.context };
    const generation = this.generation;
    this.saving = draft;
    this.failure = undefined;
    this.feedback = undefined;
    try {
      const view = await managedMcpApi.update({
        ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
        ...draft, revision: this.view.revision,
      }, context.machineId);
      if (!this.current(generation, context)) return;
      this.view = view;
      this.drafts = this.drafts.filter((item) => item.serverName !== draft.serverName || item.scope !== draft.scope);
      this.feedback = "saved";
    } catch (error) {
      if (this.current(generation, context)) this.failure = { kind: "saveError", error: errorMessage(error), serverName: draft.serverName };
    } finally {
      if (this.current(generation, context)) this.saving = undefined;
    }
  }
  private async copyPath(path: string): Promise<void> {
    if (!sameContext(this.viewContext, this.context) || this.context === undefined) return;
    const context = { ...this.context };
    const generation = this.generation;
    try {
      await navigator.clipboard.writeText(path);
      if (this.current(generation, context)) this.feedback = "copied";
    } catch (error) {
      if (this.current(generation, context)) this.failure = { kind: "copyError", error: errorMessage(error) };
    }
  }
  private scopeCell(server: ManagedMcpServerView, scope: ManagedMcpScope): TemplateResult {
    const draft = this.drafts.find((item) => item.serverName === server.name && item.scope === scope);
    const saving = this.saving?.serverName === server.name && this.saving.scope === scope;
    const reason = this.lockedReason(server, scope);
    const checked = saving ? this.saving?.enabled : draft?.enabled ?? server.enabled[scope] ?? false;
    return html`<td>
      <label class="ui-checkbox-field" title=${reason ?? ""}>
        <input type="checkbox" .checked=${checked} ?disabled=${reason !== undefined || this.saving !== undefined}
          aria-label=${m.t("checkbox", { name: server.name, scope: m.t(scope) })}
          @change=${(event: Event) => { if (event.target instanceof HTMLInputElement) this.change(server, scope, event.target.checked); }}>
        <span>${m.t(scope)}</span>
      </label>
      ${reason === undefined || server.nativeConflict === true ? null : html`<p class="scope-help">${reason}</p>`}
      ${saving ? html`<p role="status">${m.t("saving")}</p>` : null}
      ${draft === undefined ? null : html`<p class="scope-help">${m.t(scope === "global" ? "globalImpact" : "projectImpact")}</p>
        <div class="ui-settings-actions">
          <button class="ui-button ui-button--action ui-button--primary" ?disabled=${this.saving !== undefined || reason !== undefined}
            aria-label=${m.t("saveAria", { name: server.name, scope: m.t(scope) })} @click=${() => this.save(draft)}>${m.t("save")}</button>
          <button class="ui-button ui-button--action" ?disabled=${this.saving !== undefined}
            aria-label=${m.t("cancelAria", { name: server.name, scope: m.t(scope) })}
            @click=${() => { this.drafts = this.drafts.filter((item) => item !== draft); }}>${m.t("cancel")}</button>
        </div>`}
    </td>`;
  }
  private configPath(scope: "global" | "project", path: string): TemplateResult {
    return html`<div class="config-path"><strong>${m.t(scope)}</strong><code class="ui-settings-path" dir="ltr">${path}</code>
      <button class="ui-button ui-button--action" aria-label=${m.t("copyAria", { scope: m.t(scope) })} @click=${() => this.copyPath(path)}>${m.t("copy")}</button></div>`;
  }
  override render(): TemplateResult {
    const view = this.view;
    return html`<settings-panel-frame .heading=${m.t("title")} .description=${m.t("description")}
      .actionLabel=${m.t("refresh")} .actionDisabled=${this.loading || this.saving !== undefined || this.context === undefined}
      .onAction=${() => this.reload()}>
      <section class="ui-settings-section">
        ${this.context === undefined ? null : html`<dl class="ui-settings-summary context" aria-label=${m.t("context")}>
          <div><dt>${m.t("machine")}</dt><dd><bdi>${this.machineLabel || this.context.machineId}</bdi></dd></div>
          ${this.context.cwd === undefined ? null : html`<div><dt>${m.t("workspace")}</dt><dd><bdi dir="ltr">${this.context.cwd}</bdi></dd></div>`}
          ${this.context.sessionId === undefined ? null : html`<div><dt>${m.t("session")}</dt><dd><bdi>${this.sessionLabel || this.context.sessionId}</bdi></dd></div>`}
        </dl>`}
        <p>${m.t("intentHelp")}</p>
        ${this.failure === undefined || this.failure.serverName !== undefined ? null : html`<p class="ui-notice error" role="alert">${m.t(this.failure.kind, { error: this.failure.error })}</p>`}
        ${this.feedback === undefined ? null : html`<p role="status">${m.t(this.feedback)}</p>`}
        ${this.loading ? html`<p role="status">${m.t("loading")}</p>` : null}
        ${view === undefined ? null : html`
          ${view.projectTrusted || this.context?.cwd === undefined ? null : html`<p class="ui-notice warning">${m.t("untrusted")}</p>`}
          ${view.issues.map((issue) => html`<p class="ui-notice warning">${issue}</p>`)}
          ${view.servers.length === 0 ? html`<p role="status">${m.t("empty")}</p>` : html`
            <table aria-label=${m.t("title")}><thead><tr><th>${m.t("server")}</th>${this.scopes().map((scope) => html`<th>${m.t(scope)}</th>`)}</tr></thead>
              <tbody>${view.servers.map((server) => html`<tr>
                <th scope="row"><strong dir="auto">${server.name}</strong>
                  ${server.description === undefined ? null : html`<p dir="auto">${server.description}</p>`}
                  <p>${m.t("source", { scope: m.t(server.definitionScope) })}</p>
                  <p>${m.t(server.nativeConflict === true ? "native" : server.effectiveEnabled ? "enabled" : "disabled")}</p>
                  ${server.nativeConflict === true ? html`<p class="scope-help">${m.t("nativeHelp")}</p>` : server.effectiveEnabled ? html`
                    <p>${m.t("enabledBy", { scopes: localization.list(this.scopes().filter((scope) => server.enabled[scope] === true).map((scope) => m.t(scope))) })}</p>
                  ` : null}
                  ${server.pending === true ? html`<p role="status">${m.t("pending")}</p>` : null}
                  ${server.error === undefined ? null : html`<p class="ui-notice error">${server.error}</p>`}
                  ${this.failure?.serverName === server.name ? html`<p role="alert" class="ui-notice error">${m.t(this.failure.kind, { error: this.failure.error })}</p>` : null}
                </th>${this.scopes().map((scope) => this.scopeCell(server, scope))}
              </tr>`)}</tbody>
            </table>`}
        `}
      </section>
      ${view === undefined ? null : html`<section class="ui-settings-section"><details><summary>${m.t("config")}</summary>
        <p>${m.t("configHelp")}</p>
        ${this.configPath("global", view.globalConfigPath)}
        ${view.projectConfigPath === undefined ? null : this.configPath("project", view.projectConfigPath)}
        <p class="ui-notice warning">${m.t("nativeWarning")}</p>
        <details><summary>${m.t("example")}</summary>
          <p>${m.t("exampleHelp")}</p>
          <pre class="ui-settings-path" dir="ltr"><code>${configExample}</code></pre>
        </details>
        <p><a href="https://pi-web.dev/config#managed-mcp" target="_blank" rel="noopener noreferrer">${m.t("configReference")}</a></p>
        <p>${m.t("auth")}</p>
      </details></section>`}
    </settings-panel-frame>`;
  }
  static override styles = [uiButtonStyles, uiFormStyles, uiSettingsStyles, uiNoticeStyles, css`
    :host { display: block; min-width: 0; overflow-wrap: anywhere; container-type: inline-size; }
    p { line-height: 1.45; }
    .context { margin: 0; }
    .context > div { display: flex; flex-wrap: wrap; gap: 6px 12px; }
    .context dt { font-weight: bold; }
    .context dd { margin: 0; min-width: 0; }
    pre { white-space: pre-wrap; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { text-align: start; vertical-align: top; padding: 12px 8px; border-bottom: 1px solid var(--pi-border-muted); }
    tbody th { font-weight: normal; }
    th p, td p { margin: 8px 0; }
    .scope-help { font-size: 0.9em; color: var(--pi-muted); }
    .config-path { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-block: 12px; }
    .config-path code { flex: 1 1 240px; min-width: 0; }
    summary { cursor: pointer; padding-block: 8px; }
    a { color: var(--pi-accent); }
    @container (max-width: 650px) {
      table, tbody, tr, th, td { display: block; }
      thead { display: none; }
      td { border-bottom: 0; padding-block: 8px; }
      tbody th { border-bottom: 0; padding-bottom: 0; }
      tr { border-bottom: 1px solid var(--pi-border-muted); padding-block: 8px; }
    }
  `];
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

declare global { interface HTMLElementTagNameMap { "managed-mcp-panel": ManagedMcpPanel } }
