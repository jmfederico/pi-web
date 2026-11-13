import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type { LocalizedMessages, PluginBackend, PluginLocalization, StylesheetIntegrationCapabilityV1 } from "@jmfederico/pi-web/plugin-api";
import type { ManagedMcpScope, ManagedMcpServerView, ManagedMcpView } from "../shared.js";
import { managedMcpApi, type ManagedMcpPanelContext } from "./managedMcp.js";
import type source from "./managedMcp.messages.js";
export type { ManagedMcpPanelContext } from "./managedMcp.js";
const configExample = JSON.stringify({ servers: { docs: { url: "https://mcp.example.com/mcp" } }, enabledServers: [] }, null, 2);
interface Draft { serverName: string; scope: ManagedMcpScope; enabled: boolean }
function sameContext(a: ManagedMcpPanelContext | undefined, b: ManagedMcpPanelContext | undefined): boolean {
  return a?.machineId === b?.machineId && a?.projectId === b?.projectId && a?.workspaceId === b?.workspaceId
    && a?.cwd === b?.cwd && a?.sessionId === b?.sessionId;
}

export class ManagedMcpPanel extends LitElement {
  @property({ attribute: false }) backend: PluginBackend | undefined;
  @property({ attribute: false }) localization!: PluginLocalization;
  @property({ attribute: false }) messages!: LocalizedMessages<typeof source>;
  @property({ attribute: false }) styles: StylesheetIntegrationCapabilityV1 | undefined;
  private releaseStyles: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private requestController = new AbortController();
  private confirmRefresh: ((confirmed: boolean) => void) | undefined;

  private bindServices(): void {
    this.releaseStyles?.();
    this.unsubscribe?.();
    this.releaseStyles = this.shadowRoot === null ? undefined : this.styles?.registerRoot(this.shadowRoot, { sharedUi: true });
    this.unsubscribe = this.localization.subscribe(() => { this.requestUpdate(); });
  }
  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("styles") || changed.has("localization")) this.bindServices();
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
  @state() private feedback: { kind: "saved"; serverName: string; scope: ManagedMcpScope } | { kind: "copied" } | undefined;
  private generation = 0;
  private viewContext: ManagedMcpPanelContext | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.hasUpdated) { this.bindServices(); void this.reload(); }
  }
  override disconnectedCallback(): void {
    ++this.generation;
    this.requestController.abort();
    this.confirmRefresh?.(false);
    this.confirmRefresh = undefined;
    this.shadowRoot?.querySelector("dialog")?.close();
    this.releaseStyles?.();
    this.releaseStyles = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.view = undefined;
    this.drafts = [];
    super.disconnectedCallback();
  }
  protected override willUpdate(changed: PropertyValues<this>): void {
    // The host creates fresh backend facades on render; identity alone must not discard drafts.
    if (changed.has("context") || (changed.has("backend") && changed.get("backend") === undefined)) void this.reload();
  }
  private current(generation: number, context: ManagedMcpPanelContext): boolean {
    return this.isConnected && generation === this.generation && sameContext(context, this.context);
  }
  private async refresh(): Promise<void> {
    if (this.context === undefined || this.loading || this.saving !== undefined) return;
    const context = { ...this.context };
    const generation = this.generation;
    if (this.drafts.length > 0) {
      const dialog = this.shadowRoot?.querySelector("dialog");
      if (!dialog || this.confirmRefresh !== undefined) return;
      const confirmed = await new Promise<boolean>((resolve) => {
        this.confirmRefresh = resolve;
        dialog.showModal();
        dialog.querySelector<HTMLButtonElement>("#confirmation-cancel")?.focus();
      });
      if (!confirmed || !this.current(generation, context)) return;
    }
    await this.reload();
  }
  private async reload(): Promise<void> {
    const generation = ++this.generation;
    this.requestController.abort();
    this.requestController = new AbortController();
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
      const view = await managedMcpApi.get(this.backend, context, this.requestController.signal);
      if (this.current(generation, context)) { this.view = view; this.viewContext = context; }
    } catch (error) {
      if (this.current(generation, context)) this.failure = { kind: "loadError", error: errorMessage(error) };
    } finally {
      if (this.current(generation, context)) this.loading = false;
    }
  }
  private scopes(): ManagedMcpScope[] {
    return ["global", ...(this.context?.workspaceId === undefined ? [] : ["project" as const]), ...(this.context?.sessionId === undefined ? [] : ["session" as const])];
  }
  private lockedReason(server: ManagedMcpServerView, scope: ManagedMcpScope): string | undefined {
    const m = this.messages;
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
      const view = await managedMcpApi.update(this.backend, context, {
        ...draft, revision: this.view.revision,
      }, this.requestController.signal);
      if (!this.current(generation, context)) return;
      this.view = view;
      this.drafts = this.drafts.filter((item) => item.serverName !== draft.serverName || item.scope !== draft.scope);
      this.feedback = { kind: "saved", serverName: draft.serverName, scope: draft.scope };
    } catch (error) {
      if (this.current(generation, context)) this.failure = { kind: "saveError", error: errorMessage(error), serverName: draft.serverName };
    } finally {
      if (this.current(generation, context)) this.saving = undefined;
    }
  }
  private async copyInstruction(instruction: string): Promise<void> {
    if (!sameContext(this.viewContext, this.context) || this.context === undefined) return;
    const context = { ...this.context };
    const generation = this.generation;
    this.failure = undefined;
    this.feedback = undefined;
    try {
      await navigator.clipboard.writeText(instruction);
      if (this.current(generation, context)) this.feedback = { kind: "copied" };
    } catch (error) {
      if (this.current(generation, context)) this.failure = { kind: "copyError", error: errorMessage(error) };
    }
  }
  private scopeCell(server: ManagedMcpServerView, scope: ManagedMcpScope): TemplateResult {
    const m = this.messages;
    const localization = this.localization;
    const draft = this.drafts.find((item) => item.serverName === server.name && item.scope === scope);
    const saving = this.saving?.serverName === server.name && this.saving.scope === scope;
    const reason = this.lockedReason(server, scope);
    const checked = saving ? this.saving?.enabled : draft?.enabled ?? server.enabled[scope] ?? false;
    const otherScopes = this.scopes().filter((other) => other !== scope && server.enabled[other] === true);
    const saved = this.feedback?.kind === "saved" && this.feedback.serverName === server.name && this.feedback.scope === scope;
    return html`<td>
      <label class="ui-checkbox-field" title=${reason ?? ""}>
        <input type="checkbox" .checked=${checked} ?disabled=${reason !== undefined || this.saving !== undefined}
          aria-label=${m.t("checkbox", { name: server.name, scope: m.t(scope) })}
          aria-description=${reason ?? m.t(`${scope}Help`)}
          @change=${(event: Event) => { if (event.target instanceof HTMLInputElement) this.change(server, scope, event.target.checked); }}>
        <span>${m.t(scope)}<span class="scope-description">${m.t(`${scope}Help`)}</span></span>
      </label>
      ${reason === undefined || server.nativeConflict === true ? null : html`<p class="scope-help">${reason}</p>`}
      ${saving ? html`<p role="status">${m.t("saving")}</p>` : saved ? html`<p role="status">${m.t("saved")}</p>` : null}
      ${draft === undefined ? null : html`<p role="status">${m.t("unsaved")}</p>
        <p class="scope-help">${m.t(scope === "global" ? "globalImpact" : "projectImpact")}</p>
        ${draft.enabled || otherScopes.length === 0 ? null : html`<p class="scope-help">${m.t("remainsEnabled", { scopes: localization.list(otherScopes.map((other) => m.t(other))) })}</p>`}
        <div class="ui-settings-actions">
          <button class="ui-button ui-button--action ui-button--primary" ?disabled=${this.saving !== undefined || reason !== undefined}
            aria-label=${m.t("saveAria", { name: server.name, scope: m.t(scope) })} @click=${() => this.save(draft)}>${m.t("save")}</button>
          <button class="ui-button ui-button--action" ?disabled=${this.saving !== undefined}
            aria-label=${m.t("cancelAria", { name: server.name, scope: m.t(scope) })}
            @click=${() => { this.drafts = this.drafts.filter((item) => item !== draft); }}>${m.t("cancel")}</button>
        </div>`}
    </td>`;
  }
  private setupInstruction(view: ManagedMcpView): string {
    const m = this.messages;
    return [
      m.t("instruction"),
      m.t("instructionMachine", { machine: this.machineLabel || (this.context?.machineId ?? "") }),
      [
        m.t("globalConfigPath", { path: view.globalConfigPath }),
        ...(this.context?.workspaceId === undefined || view.projectConfigPath === undefined ? []
          : [m.t("projectConfigPath", { path: view.projectConfigPath })]),
      ].join("\n"),
      m.t("instructionPlaceholder"),
    ].join("\n\n");
  }
  private answerRefresh(confirmed: boolean): void {
    const resolve = this.confirmRefresh;
    this.confirmRefresh = undefined;
    this.shadowRoot?.querySelector("dialog")?.close();
    resolve?.(confirmed);
  }
  override render(): TemplateResult {
    const m = this.messages;
    const localization = this.localization;
    const view = this.view;
    const instruction = view === undefined ? "" : this.setupInstruction(view);
    return html`<header>
      <div><h2>${m.t("title")}</h2><p>${m.t("description")}</p></div>
      <button class="ui-button" ?disabled=${this.loading || this.saving !== undefined || this.context === undefined}
        @click=${() => this.refresh()}>${m.t("refresh")}</button>
    </header>
      <section class="ui-settings-section">
        ${this.context === undefined ? null : html`<dl class="ui-settings-summary context" aria-label=${m.t("context")}>
          <div><dt>${m.t("machine")}</dt><dd><bdi>${this.machineLabel || this.context.machineId}</bdi></dd></div>
          ${this.context.cwd === undefined ? null : html`<div><dt>${m.t("workspace")}</dt><dd><bdi dir="ltr">${this.context.cwd}</bdi></dd></div>`}
          ${this.context.sessionId === undefined ? null : html`<div><dt>${m.t("session")}</dt><dd><bdi>${this.sessionLabel || this.context.sessionId}</bdi></dd></div>`}
        </dl>`}

        ${this.failure === undefined || this.failure.kind === "copyError" || this.failure.serverName !== undefined ? null : html`<p class="ui-notice error" role="alert">${m.t(this.failure.kind, { error: this.failure.error })}</p>`}
        ${this.loading ? html`<p role="status">${m.t("loading")}</p>` : null}
        ${view === undefined ? null : html`
          ${view.projectTrusted || this.context?.cwd === undefined ? null : html`<p class="ui-notice warning">${m.t("untrusted")}</p>`}
          ${view.issues.map((issue) => html`<p class="ui-notice warning">${issue}</p>`)}
          ${view.servers.length === 0 ? html`<p role="status">${m.t("empty")}</p>` : html`
            <p>${m.t("scopeHelp")}</p>
            <table aria-label=${m.t("title")}><thead><tr><th>${m.t("server")}</th>${this.scopes().map((scope) => html`<th>${m.t(scope)}</th>`)}</tr></thead>
              <tbody>${view.servers.map((server) => html`<tr>
                <th scope="row"><strong dir="auto">${server.name}</strong>
                  ${server.description === undefined ? null : html`<p dir="auto">${server.description}</p>`}
                  <p class="server-state">${server.nativeConflict === true ? m.t("native") : server.effectiveEnabled
                    ? m.t("enabledBy", { scopes: localization.list(this.scopes().filter((scope) => server.enabled[scope] === true).map((scope) => m.t(scope))) })
                    : m.t("disabled")}</p>
                  ${server.nativeConflict === true ? html`<p class="scope-help">${m.t("nativeHelp")}</p>` : null}
                  <p class="scope-help">${m.t("source", { scope: m.t(server.definitionScope) })}</p>
                  ${server.pending === true ? html`<p role="status">${m.t("pending")}</p>` : null}
                  ${server.error === undefined ? null : html`<p class="ui-notice error">${server.error}</p>`}
                  ${this.failure?.serverName === server.name ? html`<p role="alert" class="ui-notice error">${m.t(this.failure.kind, { error: this.failure.error })}</p>` : null}
                </th>${this.scopes().map((scope) => this.scopeCell(server, scope))}
              </tr>`)}</tbody>
            </table>`}
        `}
      </section>
      ${view === undefined ? null : html`<section class="ui-settings-section"><details .open=${view.servers.length === 0}><summary>${m.t("config")}</summary>
        <p>${m.t("configHelp")}</p>
        <pre class="ui-settings-path" id="agent-instruction" aria-label=${m.t("instructionLabel")} dir="auto"><code>${instruction}</code></pre>
        <div class="ui-settings-actions">
          <button class="ui-button ui-button--action ui-button--primary" @click=${() => this.copyInstruction(instruction)}>${m.t("copy")}</button>
        </div>
        ${this.feedback?.kind === "copied" ? html`<p role="status">${m.t("copied")}</p>` : null}
        ${this.failure?.kind === "copyError" ? html`<p class="ui-notice error" role="alert">${m.t("copyError", { error: this.failure.error })}</p>` : null}
        <p>${m.t("afterSetup")}</p>
        <details><summary>${m.t("nativeConfig")}</summary><p>${m.t("nativeWarning")}</p></details>
        <details><summary>${m.t("example")}</summary>
          <p>${m.t("exampleHelp")}</p>
          <pre class="ui-settings-path" dir="ltr"><code>${configExample}</code></pre>
        </details>
        <p><a href="https://pi-web.dev/config#managed-mcp" target="_blank" rel="noopener noreferrer">${m.t("configReference")}</a></p>
      </details></section>
      ${view.servers.length === 0 ? null : html`<section class="ui-settings-section"><details><summary>${m.t("usageHelp")}</summary>
        <p>${m.t("connectionHelp")}</p>
        <p>${m.t("deferredHelp")}</p>
        <p>${m.t("inheritanceHelp")}</p>
      </details></section>`}`}
    <dialog aria-labelledby="discard-title" aria-describedby="discard-help"
      @cancel=${(event: Event) => { event.preventDefault(); this.answerRefresh(false); }}
      @close=${() => { this.answerRefresh(false); }}>
      <h2 id="discard-title">${m.t("discardTitle")}</h2><p id="discard-help">${m.t("discardHelp")}</p>
      <footer><button id="confirmation-cancel" class="ui-button" @click=${() => { this.answerRefresh(false); }}>${m.t("keepEditing")}</button>
        <button id="confirmation-confirm" class="ui-button ui-button--primary" @click=${() => { this.answerRefresh(true); }}>${m.t("discardConfirm")}</button></footer>
    </dialog>`;
  }
  static override styles = [css`
    header { display: flex; align-items: start; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: 1px solid var(--pi-border-muted); }
    header > button { flex: 0 0 auto; }
    header h2 { margin: 0; font-size: 1.1em; }
    header p { margin: 8px 0 0; color: var(--pi-muted); }
    .ui-settings-section { padding: 16px; border-bottom: 1px solid var(--pi-border-muted); }
    .ui-settings-summary, .ui-settings-path { padding: 10px; background: var(--pi-surface); }
    .ui-settings-actions, footer { display: flex; flex-wrap: wrap; gap: 8px; }
    .ui-settings-actions .ui-button { border: 1px solid var(--pi-border); }
    .ui-checkbox-field { display: flex; align-items: start; gap: 8px; cursor: pointer; }
    input[type=checkbox] { flex: 0 0 auto; margin: 3px 0 0; accent-color: var(--pi-accent); }
    .ui-notice { padding: 10px; border-inline-start: 3px solid var(--pi-muted); }
    .error { border-color: var(--pi-danger); }
    .warning { border-color: var(--pi-warning); }
    dialog { box-sizing: border-box; width: min(480px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 24px; color: var(--pi-text); background: var(--pi-bg); border: 1px solid var(--pi-border); border-radius: 8px; }
    dialog::backdrop { background: var(--pi-overlay, #0008); }
    dialog h2 { margin-top: 0; font-size: 1.2em; }
    footer { justify-content: end; margin-top: 20px; }
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
    .scope-help, .scope-description { font-size: 0.9em; color: var(--pi-muted); }
    .scope-description { display: block; margin-block-start: 4px; }
    .server-state { font-weight: bold; }
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

export function defineManagedMcpPanel(): void {
  if (!customElements.get("managed-mcp-panel")) customElements.define("managed-mcp-panel", ManagedMcpPanel);
}

declare global { interface HTMLElementTagNameMap { "managed-mcp-panel": ManagedMcpPanel } }
