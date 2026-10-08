import { css, html, LitElement, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { mcpApi, type Machine, type McpCheckResponse, type McpServerInfo, type McpServersResponse, type McpWorkspaceTarget, type Workspace } from "../../api";
import { HttpRequestError } from "../../api/http";
import { friendlySelectedMachineSettingsErrorMessage, settingsMachineTarget, settingsMachineTargetLabel } from "./settingsMachineTarget";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";

type Operation = "load" | "save" | "check";

@customElement("settings-mcp-panel")
export class SettingsMcpPanel extends LitElement {
  @property({ attribute: false }) machine: Machine | undefined;
  @property({ attribute: false }) workspace: Workspace | undefined;
  @property({ attribute: false }) apiClient: typeof mcpApi = mcpApi;
  @state() private selection: "machine" | "workspace" = "machine";
  @state() private response: McpServersResponse | undefined;
  @state() private checkResponse: McpCheckResponse | undefined;
  @state() private operation: Operation | undefined;
  @state() private error = "";
  @state() private savedMessage = "";
  private activeTargetKey = "";
  private requestSeq = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    ++this.requestSeq;
    this.activeTargetKey = "";
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (!this.isConnected) return;
    if (this.workspace === undefined) this.selection = "machine";
    const key = this.targetKey();
    if (key === this.activeTargetKey && !changed.has("apiClient")) return;
    ++this.requestSeq;
    this.activeTargetKey = key;
    this.response = undefined;
    this.checkResponse = undefined;
    this.operation = undefined;
    this.error = "";
    this.savedMessage = "";
    void this.load();
  }

  override render(): TemplateResult {
    const busy = this.operation !== undefined;
    return html`
      <settings-panel-frame
        heading="MCP servers"
        .description=${`MCP adds service tools to Pi and is not required for ordinary coding. Configuration on ${settingsMachineTargetLabel(settingsMachineTarget(this.machine))}.`}
        actionLabel="Refresh configuration"
        .actionDisabled=${busy}
        .onAction=${() => this.load()}
        .notices=${this.notices()}
      >
        <div class="toolbar">
          <label>Configuration scope
            <select aria-label="MCP configuration scope" .value=${this.selection} @change=${(event: Event) => { this.selectScope(event); }}>
              <option value="machine">Machine-wide</option>
              ${this.workspace === undefined ? nothing : html`<option value="workspace">Selected workspace</option>`}
            </select>
          </label>
          <button title="Temporarily start enabled local servers or connect to their services" ?disabled=${busy || this.response === undefined} @click=${() => { void this.check(); }}>
            ${this.operation === "check" ? "Checking connections…" : "Check connections"}
          </button>
        </div>
        ${this.selection === "workspace" ? html`<p>Selected workspace: ${this.workspace?.label}</p>` : nothing}
        <p class="help">New sessions pick up saved configuration. Run <code>/reload</code> in each idle session to reload it there. Disabling configuration does not stop connections in other already-running sessions.</p>
        ${this.renderConfiguration()}
        ${this.renderCheck()}
        <details class="help">
          <summary>Setup and connection checks</summary>
          <p>Credentials remain in Pi files. To add, edit, or remove servers, use <code>pi mcp add</code> / <code>pi mcp remove</code> on this machine or edit those files; this panel only saves enabled flags.</p>
          <p>Use <code>/mcp</code> to inspect session status, or <code>/mcp reconnect &lt;name&gt;</code> to reconnect.</p>
          <p>Check connections is an explicit, temporary test, not live session status. It may start configured servers; check only configurations you trust. Detailed errors stay on the machine: run <code>pi mcp list</code> there to inspect them.</p>
          <p>Pi CLI checks do not use <code>auth.provider</code> credentials; verify those servers with <code>/mcp</code> inside a session instead.</p>
        </details>
      </settings-panel-frame>
    `;
  }

  private notices(): readonly SettingsNotice[] {
    const notices: SettingsNotice[] = [];
    if (this.error !== "") notices.push({ type: "error", content: this.error });
    if (this.savedMessage !== "") notices.push({ type: "success", content: this.savedMessage });
    for (const error of this.response?.errors ?? []) notices.push({ type: "error", content: error });
    if (this.response?.projectTrusted === false) {
      notices.push({ type: "security", title: "Untrusted project configuration", content: "Project MCP servers can run code or access services. Review the Pi configuration and trust the project in a session only if you trust its servers. Saved/default trust here is not a running session's trust decision." });
    }
    return notices;
  }

  private renderConfiguration(): TemplateResult {
    if (this.response === undefined) {
      return html`<p role="status">${this.operation === "load" ? "Loading MCP configuration…" : "MCP configuration unavailable. Refresh configuration to try again."}</p>`;
    }
    return html`
      <section aria-label="MCP configuration">
        <p>User config: <code>${this.response.userConfigPath}</code></p>
        ${this.response.projectConfigPath === undefined ? nothing : html`<p>Project config: <code>${this.response.projectConfigPath}</code></p>`}
        ${this.response.servers.length === 0 ? html`<p>No MCP servers configured.</p>` : this.response.servers.map((server) => this.renderServer(server))}
      </section>
    `;
  }

  private renderServer(server: McpServerInfo): TemplateResult {
    return html`
      <article class="card" aria-label=${`${server.scope} MCP server ${server.name}`}>
        <div class="toolbar">
          <strong>${server.name}</strong>
          <label><input type="checkbox" aria-label=${`Enabled: ${server.scope} MCP server ${server.name}`}
            .checked=${live(server.enabled)}
            ?disabled=${this.operation !== undefined || !canToggle(server)}
            @change=${(event: Event) => { if (event.currentTarget instanceof HTMLInputElement) void this.setEnabled(server, event.currentTarget.checked); }}
          > Enabled</label>
        </div>
        <p>Scope: ${server.scope} · ${server.enabled ? "Enabled" : "Disabled"} · Transport: ${server.transport}</p>
        <p>Source: <code>${server.source}</code></p>
        ${server.description === undefined ? nothing : html`<p>${server.description}</p>`}
        <p>Exposure: ${server.exposure}</p>
        ${server.overridden ? html`<p class="warning">Overridden by project configuration; this user entry is not effective and cannot be toggled here.</p>` : nothing}
        ${server.error === undefined ? nothing : html`<p role="alert">${server.error}</p>`}
        ${server.transport === "unknown" && server.error === undefined ? html`<p role="alert">Invalid or unknown transport; fix the Pi configuration before toggling.</p>` : nothing}
        <p>Inspect status with <code>/mcp</code> in a session. To reconnect: <code>${`/mcp reconnect ${server.name}`}</code></p>
      </article>
    `;
  }

  private renderCheck(): TemplateResult | typeof nothing {
    if (this.checkResponse === undefined) return nothing;
    return html`
      <section aria-label="Temporary MCP connection test" aria-live="polite">
        <h3>Temporary connection test — not live session status</h3>
        <p>Checked: ${this.checkResponse.checkedAt}</p>
        ${this.checkResponse.note === undefined ? nothing : html`<p>${this.checkResponse.note}</p>`}
        ${this.checkResponse.errors.map((error) => html`<p role="alert">${error}</p>`)}
        ${this.checkResponse.servers.length === 0 ? html`<p>No connections tested.</p>` : this.checkResponse.servers.map((server) => html`
          <article class="card">
            <strong>${server.name}</strong>
            <p>Scope: ${server.scope} · Status: ${server.state}</p>
            ${server.error === undefined ? nothing : html`<p role="alert">${server.error}</p>`}
            <p>Tools (${server.tools.length}): ${server.tools.length === 0 ? "None" : nothing}</p>
            <ul>${server.tools.map((tool) => html`<li><code>${tool}</code></li>`)}</ul>
            ${server.state === "needs-auth" ? html`<p>Inspect session status with <code>/mcp</code> inside a session.</p>` : nothing}
            ${server.state === "failed" || server.state === "disconnected" ? html`<p>Reconnect inside a session: <code>${`/mcp reconnect ${server.name}`}</code></p>` : nothing}
          </article>
        `)}
      </section>
    `;
  }

  private selectScope(event: Event): void {
    if (!(event.currentTarget instanceof HTMLSelectElement)) return;
    this.selection = event.currentTarget.value === "workspace" && this.workspace !== undefined ? "workspace" : "machine";
  }

  private workspaceTarget(): McpWorkspaceTarget | undefined {
    return this.selection === "workspace" && this.workspace !== undefined
      ? { projectId: this.workspace.projectId, workspaceId: this.workspace.id }
      : undefined;
  }

  private targetKey(): string {
    // Include workspace identity even in machine-wide view so changing the
    // selected workspace clears prior diagnostics, as changing machines does.
    return JSON.stringify([settingsMachineTarget(this.machine).id, this.workspace?.projectId, this.workspace?.id, this.selection]);
  }

  private async load(): Promise<void> {
    if (this.operation !== undefined) return;
    this.checkResponse = undefined;
    const machineId = settingsMachineTarget(this.machine).id;
    const workspace = this.workspaceTarget();
    await this.runRequest("load", () => this.apiClient.list(machineId, workspace), (response) => { this.response = response; });
  }

  private async setEnabled(server: McpServerInfo, enabled: boolean): Promise<void> {
    if (this.operation !== undefined || this.activeTargetKey !== this.targetKey() || !canToggle(server)) return;
    // A save changes only durable configuration, never running connections.
    // Clear diagnostics even on failure: a failed request may have reached Pi.
    this.checkResponse = undefined;
    const machineId = settingsMachineTarget(this.machine).id;
    const workspace = this.workspaceTarget();
    await this.runRequest("save", () => this.apiClient.setEnabled(server.name, server.scope, enabled, machineId, workspace), (response) => {
      this.response = response;
      this.savedMessage = "Configuration saved. New sessions pick it up; run /reload in each idle session.";
    });
  }

  private async check(): Promise<void> {
    if (this.operation !== undefined || this.response === undefined || this.activeTargetKey !== this.targetKey()) return;
    this.checkResponse = undefined;
    const machineId = settingsMachineTarget(this.machine).id;
    const workspace = this.workspaceTarget();
    await this.runRequest("check", () => this.apiClient.check(machineId, workspace), (response) => { this.checkResponse = response; });
  }

  private async runRequest<T>(operation: Operation, request: () => Promise<T>, accept: (response: T) => void): Promise<void> {
    const key = this.targetKey();
    const seq = ++this.requestSeq;
    const current = () => this.isConnected && seq === this.requestSeq && key === this.targetKey();
    this.operation = operation;
    this.error = "";
    this.savedMessage = "";
    try {
      const response = await request();
      if (current()) accept(response);
    } catch (error) {
      if (current()) {
        const target = settingsMachineTarget(this.machine);
        const message = error instanceof Error ? error.message : String(error);
        this.error = error instanceof HttpRequestError && error.status === 404
          ? `MCP settings are not available on ${target.name}. If it runs an older PI WEB version, update PI WEB on that machine and restart its web/API service and session daemon, then retry. Also verify the selected workspace still exists. No gateway fallback is used.`
          : `Failed to ${operation === "load" ? "load MCP configuration" : operation === "save" ? "save MCP configuration" : "check MCP connections"} on ${target.name}: ${friendlySelectedMachineSettingsErrorMessage(message, target)}`;
      }
    } finally {
      if (current()) this.operation = undefined;
    }
  }

  static override styles = css`
    :host { display: block; }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
    label { display: flex; align-items: center; gap: 8px; }
    button, select { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; font: inherit; }
    button { cursor: pointer; }
    button:disabled, input:disabled { opacity: .55; cursor: not-allowed; }
    .help { color: var(--pi-muted); }
    p { margin: 8px 0; line-height: 1.45; }
    .card { border: 1px solid var(--pi-border); border-radius: 10px; padding: 12px; margin: 12px 0; }
    .warning { background: var(--pi-warning-surface); border: 1px solid var(--pi-warning-border); border-radius: 8px; padding: 8px; }
    [role="alert"] { color: var(--pi-danger); }
    h3 { font-size: 15px; }
    code { overflow-wrap: anywhere; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  `;
}

function canToggle(server: McpServerInfo): boolean {
  return !server.overridden && server.error === undefined && server.transport !== "unknown";
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-mcp-panel": SettingsMcpPanel;
  }
}
