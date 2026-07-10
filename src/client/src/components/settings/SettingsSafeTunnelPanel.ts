import { css, html, LitElement, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { safeTunnelApi, type SafeTunnelLoginRequest, type SafeTunnelOperationResponse, type SafeTunnelRuntimeStatus, type SafeTunnelStatusResponse } from "../../api";
import { writeClipboardText } from "../../clipboard";

const operationPollIntervalMs = 2_000;
const defaultControlApiUrl = "http://127.0.0.1:8787";
const defaultLocalPiWebUrl = "http://127.0.0.1:8504";
const defaultMachineName = "My PI WEB machine";
const defaultMachineSlug = "my-pi-web-machine";

export interface SafeTunnelLoginFormFields {
  controlApiUrl: string;
  machineName: string;
  machineSlug: string;
  localPiWebUrl: string;
  frpcPath: string;
}

@customElement("settings-safe-tunnel-panel")
export class SettingsSafeTunnelPanel extends LitElement {
  @state() private status: SafeTunnelStatusResponse | undefined;
  @state() private operation: SafeTunnelOperationResponse | undefined;
  @state() private loading = true;
  @state() private mutating = false;
  @state() private error = "";
  @state() private message = "";
  @state() private controlApiUrl = defaultControlApiUrl;
  @state() private machineName = defaultMachineName;
  @state() private machineSlug = defaultMachineSlug;
  @state() private localPiWebUrl = defaultLocalPiWebUrl;
  @state() private loginFrpcPath = "";
  @state() private startFrpcPath = "";
  private controlApiUrlEdited = false;
  private machineSlugEdited = false;
  private localPiWebUrlEdited = false;
  private operationPollTimer: number | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.loadStatus();
  }

  override disconnectedCallback(): void {
    this.clearOperationPollTimer();
    super.disconnectedCallback();
  }

  override render(): TemplateResult {
    return html`
      <section class="panel" aria-live="polite">
        <header>
          <div>
            <span class="eyebrow">Safe Tunnel</span>
            <h2>Expose this PI WEB safely</h2>
            <p>Register this local PI WEB with PI WEB Safe Tunnels, then start or stop the connector from here.</p>
          </div>
          <button type="button" @click=${() => { void this.loadStatus(); }} ?disabled=${this.loading || this.mutating}>Refresh</button>
        </header>

        ${this.error !== "" ? html`<div class="notice error">${this.error}</div>` : null}
        ${this.message !== "" ? html`<div class="notice success">${this.message}</div>` : null}
        ${this.loading && this.status === undefined ? html`<div class="notice">Loading Safe Tunnel status…</div>` : null}

        ${this.renderStatusCards()}
        ${this.renderCurrentTunnelCard()}
        ${this.renderLoginForm()}
        ${this.renderOperation()}
        ${this.renderConnectorControls()}
      </section>
    `;
  }

  private renderStatusCards(): TemplateResult {
    const status = this.status;
    if (status === undefined) {
      return html`
        <div class="cards placeholder">
          <article><strong>Connector</strong><span>Unknown</span></article>
          <article><strong>Registration</strong><span>Unknown</span></article>
          <article><strong>Runtime</strong><span>Unknown</span></article>
        </div>
      `;
    }

    return html`
      <div class="cards">
        <article>
          <strong>Connector</strong>
          <span class=${connectorStateClass(status.connector.state)}>${connectorStateLabel(status.connector.state)}</span>
          <small>${status.connector.command}</small>
          ${status.connector.install === undefined ? null : html`<small>Will install ${status.connector.install.packageSpec} on first use.</small>`}
          ${status.connector.error === undefined ? null : html`<small class=${status.connector.state === "installable" ? "muted" : "bad"}>${status.connector.error}</small>`}
        </article>
        <article>
          <strong>Registration</strong>
          <span class=${status.config.state === "registered" ? "good" : "muted"}>${configStateLabel(status.config.state)}</span>
          <small>${status.config.path}</small>
          ${status.config.machine === undefined ? null : html`<small>${status.config.machine.controlApiBaseUrl}</small>`}
          ${status.config.error === undefined ? null : html`<small class="bad">${status.config.error}</small>`}
        </article>
        <article>
          <strong>Runtime</strong>
          <span class=${runtimeStateClass(status.runtime.state)}>${runtimeStateLabel(status.runtime.state)}</span>
          <small>${status.runtime.pid === undefined ? status.runtime.pidFilePath : `PID ${String(status.runtime.pid)}`}</small>
          ${status.runtime.error === undefined ? null : html`<small class="bad">${status.runtime.error}</small>`}
          ${status.runtime.logError === undefined ? null : html`<small class="bad">Connector log: ${status.runtime.logError}</small>`}
        </article>
      </div>
    `;
  }

  private renderCurrentTunnelCard(): TemplateResult {
    const status = this.status;
    if (status === undefined) {
      return html`
        <section class="card current-tunnel-card" aria-labelledby="safe-tunnel-current-heading">
          <div class="section-heading">
            <div>
              <h3 id="safe-tunnel-current-heading">Current tunnel</h3>
              <p>Loading connector-owned tunnel metadata…</p>
            </div>
            <span class="status-pill muted">Loading</span>
          </div>
        </section>
      `;
    }

    const machine = status.config.machine;
    const localPiWebUrl = status.config.localPiWebUrl;
    const publicUrl = machine?.publicUrl;
    return html`
      <section class="card current-tunnel-card" aria-labelledby="safe-tunnel-current-heading">
        <div class="section-heading">
          <div>
            <h3 id="safe-tunnel-current-heading">Current tunnel</h3>
            <p>Read-only connector-owned registration and runtime metadata for this PI WEB.</p>
          </div>
          <span class=${`status-pill ${status.config.state === "registered" ? "good" : "muted"}`}>${configStateLabel(status.config.state)}</span>
        </div>
        ${machine === undefined ? html`
          <p class="help empty-state">No registered tunnel is saved in the connector config yet. Use the login form below to register this PI WEB.</p>
          <dl class="detail-list">
            ${this.renderDetailRow("Config path", status.config.path, { copyLabel: "Config path" })}
            ${this.renderDetailRow("Local PI WEB URL", localPiWebUrl, { copyLabel: "Local PI WEB URL", openUrl: localPiWebUrl })}
            ${this.renderRuntimeDetail(status.runtime)}
          </dl>
        ` : html`
          <dl class="detail-list">
            ${this.renderDetailRow("Slug", machine.machineSlug, { copyLabel: "Tunnel slug" })}
            ${this.renderDetailRow("Public URL", publicUrl, { copyLabel: "Public URL", openUrl: publicUrl })}
            ${this.renderDetailRow("Machine ID", machine.machineId, { copyLabel: "Machine ID" })}
            ${this.renderDetailRow("Config path", status.config.path, { copyLabel: "Config path" })}
            ${this.renderDetailRow("Local PI WEB URL", localPiWebUrl, { copyLabel: "Local PI WEB URL", openUrl: localPiWebUrl })}
            ${this.renderRuntimeDetail(status.runtime)}
          </dl>
        `}
        ${status.config.error === undefined ? null : html`<p class="bad">${status.config.error}</p>`}
        ${this.renderCurrentTunnelRuntimeDiagnostics(status.runtime)}
      </section>
    `;
  }

  private renderDetailRow(label: string, value: string | undefined, options: { copyLabel?: string; openUrl?: string | undefined } = {}): TemplateResult {
    const displayValue = value === undefined || value.trim() === "" ? undefined : value;
    const copyLabel = options.copyLabel;
    const openUrl = displayValue === undefined ? undefined : options.openUrl;
    return html`
      <div class="detail-row">
        <dt>${label}</dt>
        <dd>
          ${openUrl === undefined
            ? html`<span class=${displayValue === undefined ? "detail-value muted" : "detail-value"}>${displayValue ?? "Not reported"}</span>`
            : html`<a class="detail-value" href=${openUrl} target="_blank" rel="noreferrer">${displayValue}</a>`}
          ${displayValue === undefined ? null : html`
            <span class="detail-actions">
              ${openUrl === undefined ? null : html`<button type="button" @click=${() => { this.openUrl(openUrl); }}>Open</button>`}
              ${copyLabel === undefined ? null : html`<button type="button" @click=${() => { void this.copyText(displayValue, copyLabel); }}>Copy</button>`}
            </span>
          `}
        </dd>
      </div>
    `;
  }

  private renderRuntimeDetail(runtime: SafeTunnelRuntimeStatus): TemplateResult {
    return html`
      <div class="detail-row">
        <dt>Runtime</dt>
        <dd>
          <span class=${`detail-value ${runtimeStateClass(runtime.state)}`}>${safeTunnelRuntimeSummary(runtime)}</span>
          <small>PID file ${runtime.pidFilePath}</small>
          ${runtime.frpcConfigPath === undefined ? null : html`<small>frpc config ${runtime.frpcConfigPath}${runtime.frpcConfigExists === false ? " (missing)" : ""}</small>`}
        </dd>
      </div>
    `;
  }

  private renderCurrentTunnelRuntimeDiagnostics(runtime: SafeTunnelRuntimeStatus): TemplateResult | null {
    const hasLogTail = runtime.logTail !== undefined && runtime.logTail.trim() !== "";
    const showLogTail = hasLogTail && runtime.state !== "running";
    if (runtime.error === undefined && runtime.logError === undefined && !showLogTail) return null;

    return html`
      <details class="runtime-diagnostics" ?open=${runtime.state === "stale" || runtime.state === "unknown" || runtime.error !== undefined || runtime.logError !== undefined}>
        <summary>Runtime diagnostics</summary>
        ${runtime.error === undefined ? null : html`<p class="bad">${runtime.error}</p>`}
        ${runtime.logError === undefined ? null : html`<p class="bad">Connector log: ${runtime.logError}</p>`}
        ${!showLogTail ? null : html`
          ${runtime.logPath === undefined ? null : html`<p class="help muted">${runtime.logPath}</p>`}
          <pre>${runtime.logTail}</pre>
        `}
      </details>
    `;
  }

  private renderLoginForm(): TemplateResult {
    const validationMessage = safeTunnelLoginValidationMessage(this.loginFields());
    const disabledReason = this.loginDisabledReason(validationMessage);
    const currentMachine = this.status?.config.machine;
    const hasCurrentMachine = currentMachine !== undefined;
    return html`
      <section class="card form-card">
        <div class="section-heading">
          <div>
            <h3>${hasCurrentMachine ? "New / re-register tunnel" : "Register this PI WEB"}</h3>
            <p>${hasCurrentMachine
              ? "Start a fresh connector device login. After hosted approval, the connector saves the new registration and the Current tunnel card updates."
              : "Starts the connector device flow. Approve it in the hosted Safe Tunnels page, then this panel will show the public URL when registration finishes."}</p>
          </div>
        </div>
        ${this.renderRegistrationActionNotice(currentMachine)}
        <form @submit=${(event: Event) => { event.preventDefault(); void this.startLogin(); }}>
          <label>
            Control API URL
            <input .value=${this.controlApiUrl} placeholder="https://control.example.test" @input=${(event: Event) => { this.handleControlApiUrlInput(event); }}>
          </label>
          <label>
            Machine name
            <input .value=${this.machineName} @input=${(event: Event) => { this.handleMachineNameInput(event); }}>
          </label>
          <label>
            Machine slug
            <input .value=${this.machineSlug} spellcheck="false" @input=${(event: Event) => { this.handleMachineSlugInput(event); }}>
          </label>
          ${currentMachine?.machineSlug === undefined
            ? html`<p class="field-help help">Choose a lowercase DNS label for this registration.</p>`
            : html`<p class="field-help help">Current tunnel slug is <code>${currentMachine.machineSlug}</code>. This field is for the new/re-registered tunnel and is intentionally not prefilled from the current tunnel.</p>`}
          <label>
            Local PI WEB URL <small>optional</small>
            <input .value=${this.localPiWebUrl} placeholder="http://127.0.0.1:8504" @input=${(event: Event) => { this.handleLocalPiWebUrlInput(event); }}>
          </label>
          <label>
            frpc path <small>optional</small>
            <input .value=${this.loginFrpcPath} placeholder="/absolute/path/to/frpc" @input=${(event: Event) => { this.loginFrpcPath = inputValue(event); }}>
          </label>
          ${disabledReason === undefined ? null : html`<p class="help bad">${disabledReason}</p>`}
          <div class="actions">
            <button type="submit" ?disabled=${disabledReason !== undefined || this.mutating}>${hasCurrentMachine ? "Start new/re-register login" : "Start login"}</button>
          </div>
        </form>
      </section>
    `;
  }

  private renderRegistrationActionNotice(currentMachine: NonNullable<SafeTunnelStatusResponse["config"]["machine"]> | undefined): TemplateResult | null {
    if (currentMachine === undefined) return null;

    return html`
      <div class="callout registration-action">
        <strong>Current tunnel remains separate</strong>
        <p>Current tunnel: ${currentTunnelDescription(currentMachine)}. The form below starts a new or replacement registration; it does not edit the current tunnel card until hosted approval succeeds.</p>
      </div>
    `;
  }

  private renderOperation(): TemplateResult | null {
    const operation = this.operation ?? this.status?.activeOperation;
    if (operation === undefined) return null;
    const approvalUrl = operation.verificationUriComplete;
    const publicUrl = operation.publicUrl;
    const userCode = operation.userCode;
    return html`
      <section class="card operation-card">
        <div class="section-heading">
          <div>
            <h3>${operationKindLabel(operation.kind)} operation</h3>
            <p>Status: <strong class=${operation.status === "failed" ? "bad" : operation.status === "succeeded" ? "good" : "muted"}>${operationStatusLabel(operation.status)}</strong></p>
          </div>
          ${operation.status === "running" ? html`<button type="button" @click=${() => { void this.pollOperation(operation.id); }}>Poll now</button>` : null}
        </div>
        ${approvalUrl === undefined ? null : html`
          <div class="callout">
            <strong>Approve this connector</strong>
            <a href=${approvalUrl} target="_blank" rel="noreferrer">${approvalUrl}</a>
            <div class="actions compact">
              <button type="button" @click=${() => { this.openUrl(approvalUrl); }}>Open approval page</button>
              <button type="button" @click=${() => { void this.copyText(approvalUrl, "Approval URL"); }}>Copy URL</button>
            </div>
          </div>
        `}
        ${userCode === undefined ? null : html`
          <p class="user-code"><span>User code</span><strong>${userCode}</strong><button type="button" @click=${() => { void this.copyText(userCode, "User code"); }}>Copy</button></p>
        `}
        ${publicUrl === undefined ? null : html`
          <div class="callout public-url">
            <strong>Public URL</strong>
            <a href=${publicUrl} target="_blank" rel="noreferrer">${publicUrl}</a>
            <div class="actions compact">
              <button type="button" @click=${() => { this.openUrl(publicUrl); }}>Open</button>
              <button type="button" @click=${() => { void this.copyText(publicUrl, "Public URL"); }}>Copy</button>
            </div>
          </div>
        `}
        ${operation.connectorProcessId === undefined ? null : html`<p class="help muted">Connector process ${operation.connectorProcessId}</p>`}
        ${operation.error === undefined ? null : html`<p class="bad">${operation.error}</p>`}
        ${operation.logTail === undefined || operation.logTail.trim() === "" ? null : html`
          <details ?open=${operation.kind === "start" && operation.status === "failed"}>
            <summary>Connector log tail</summary>
            ${operation.logPath === undefined ? null : html`<p class="help muted">${operation.logPath}</p>`}
            <pre>${operation.logTail}</pre>
          </details>
        `}
        ${operation.stderr.trim() === "" ? null : html`<details><summary>Connector error output</summary><pre>${operation.stderr}</pre></details>`}
        ${operation.stdout.trim() === "" ? null : html`<details><summary>Connector output</summary><pre>${operation.stdout}</pre></details>`}
      </section>
    `;
  }

  private renderConnectorControls(): TemplateResult {
    const startDisabledReason = this.startDisabledReason();
    const stopDisabledReason = this.stopDisabledReason();
    return html`
      <section class="card">
        <div class="section-heading">
          <div>
            <h3>Connector runtime</h3>
            <p>Start keeps the tunnel process under the connector's PID-file supervision. Stop delegates to <code>pi-web-tunnel stop</code>.</p>
          </div>
        </div>
        <label>
          frpc path override <small>optional for start</small>
          <input .value=${this.startFrpcPath} placeholder="/absolute/path/to/frpc" @input=${(event: Event) => { this.startFrpcPath = inputValue(event); }}>
        </label>
        <div class="actions">
          <button type="button" @click=${() => { void this.startConnector(); }} ?disabled=${startDisabledReason !== undefined || this.mutating}>Start tunnel</button>
          <button type="button" @click=${() => { void this.stopConnector(); }} ?disabled=${stopDisabledReason !== undefined || this.mutating}>Stop tunnel</button>
        </div>
        ${startDisabledReason === undefined ? null : html`<p class="help muted">Start unavailable: ${startDisabledReason}</p>`}
        ${stopDisabledReason === undefined ? null : html`<p class="help muted">Stop unavailable: ${stopDisabledReason}</p>`}
        ${this.renderConnectorLog()}
      </section>
    `;
  }

  private renderConnectorLog(): TemplateResult | null {
    const runtime = this.status?.runtime;
    const logTail = runtime?.logTail;
    if (runtime === undefined || logTail === undefined || logTail.trim() === "") return null;

    const summary = runtime.state === "running" ? "Connector output" : "Last connector output";
    return html`
      <details>
        <summary>${summary}</summary>
        ${runtime.logPath === undefined ? null : html`<p class="help muted">${runtime.logPath}</p>`}
        <pre>${logTail}</pre>
      </details>
    `;
  }

  private loginFields(): SafeTunnelLoginFormFields {
    return {
      controlApiUrl: this.controlApiUrl,
      machineName: this.machineName,
      machineSlug: this.machineSlug,
      localPiWebUrl: this.localPiWebUrl,
      frpcPath: this.loginFrpcPath,
    };
  }

  private async loadStatus(): Promise<void> {
    this.loading = true;
    this.error = "";
    try {
      this.applyStatus(await safeTunnelApi.status());
    } catch (error) {
      this.error = `Failed to load Safe Tunnel status: ${errorMessage(error)}`;
    } finally {
      this.loading = false;
    }
  }

  private applyStatus(status: SafeTunnelStatusResponse): void {
    this.status = status;
    this.applyStatusDefaults(status);
    if (status.activeOperation !== undefined) {
      this.operation = status.activeOperation;
      this.scheduleOperationPoll(status.activeOperation);
    }
  }

  private applyStatusDefaults(status: SafeTunnelStatusResponse): void {
    if (!this.controlApiUrlEdited && this.controlApiUrl === defaultControlApiUrl && status.config.machine !== undefined) this.controlApiUrl = status.config.machine.controlApiBaseUrl;
    // Do not seed the form slug from the current registration: this form starts a new/re-register login.
    if (!this.localPiWebUrlEdited && this.localPiWebUrl === defaultLocalPiWebUrl && status.config.localPiWebUrl !== undefined) this.localPiWebUrl = status.config.localPiWebUrl;
  }

  private async startLogin(): Promise<void> {
    const validationMessage = safeTunnelLoginValidationMessage(this.loginFields());
    if (validationMessage !== undefined) {
      this.error = validationMessage;
      return;
    }

    this.mutating = true;
    this.error = "";
    this.message = "Starting Safe Tunnel login…";
    try {
      const response = await safeTunnelApi.login(createSafeTunnelLoginRequest(this.loginFields()));
      this.applyStatus(response.status);
      this.operation = response.operation;
      this.message = "Safe Tunnel login started. Approve the connector in the hosted page.";
      this.scheduleOperationPoll(response.operation);
    } catch (error) {
      this.error = `Failed to start Safe Tunnel login: ${errorMessage(error)}`;
      this.message = "";
    } finally {
      this.mutating = false;
    }
  }

  private async pollOperation(operationId: string): Promise<void> {
    this.error = "";
    try {
      const operation = await safeTunnelApi.operation(operationId);
      this.operation = operation;
      if (operation.status === "running") {
        this.scheduleOperationPoll(operation);
        return;
      }
      this.clearOperationPollTimer();
      if (operation.status === "succeeded") {
        this.message = operationSucceededMessage(operation);
      } else {
        this.message = "";
      }
      await this.loadStatus();
    } catch (error) {
      this.clearOperationPollTimer();
      this.error = `Failed to refresh Safe Tunnel operation: ${errorMessage(error)}`;
    }
  }

  private scheduleOperationPoll(operation: SafeTunnelOperationResponse): void {
    this.clearOperationPollTimer();
    if (operation.status !== "running") return;
    if (typeof window === "undefined") return;
    this.operationPollTimer = window.setTimeout(() => {
      this.operationPollTimer = undefined;
      void this.pollOperation(operation.id);
    }, operationPollIntervalMs);
  }

  private clearOperationPollTimer(): void {
    if (this.operationPollTimer === undefined) return;
    if (typeof window !== "undefined") window.clearTimeout(this.operationPollTimer);
    this.operationPollTimer = undefined;
  }

  private async startConnector(): Promise<void> {
    const disabledReason = this.startDisabledReason();
    if (disabledReason !== undefined) {
      this.error = `Cannot start Safe Tunnel: ${disabledReason}`;
      return;
    }
    this.mutating = true;
    this.error = "";
    this.message = "Starting Safe Tunnel connector…";
    try {
      const frpcPath = normalizedOptionalString(this.startFrpcPath);
      const response = await safeTunnelApi.start(frpcPath === undefined ? {} : { frpcPath });
      this.applyStatus(response.status);
      this.operation = response.operation;
      this.message = response.connectorProcessId === undefined
        ? "Safe Tunnel connector start operation started."
        : `Safe Tunnel connector start operation started (PID ${String(response.connectorProcessId)}).`;
      this.scheduleOperationPoll(response.operation);
    } catch (error) {
      this.error = `Failed to start Safe Tunnel connector: ${errorMessage(error)}`;
      this.message = "";
    } finally {
      this.mutating = false;
    }
  }

  private async stopConnector(): Promise<void> {
    const disabledReason = this.stopDisabledReason();
    if (disabledReason !== undefined) {
      this.error = `Cannot stop Safe Tunnel: ${disabledReason}`;
      return;
    }
    this.mutating = true;
    this.error = "";
    this.message = "Stopping Safe Tunnel connector…";
    try {
      const response = await safeTunnelApi.stop();
      this.applyStatus(response.status);
      this.message = response.command.exitCode === 0 ? "Safe Tunnel connector stopped." : `Safe Tunnel stop exited with code ${formatExitCode(response.command.exitCode)}.`;
    } catch (error) {
      this.error = `Failed to stop Safe Tunnel connector: ${errorMessage(error)}`;
      this.message = "";
    } finally {
      this.mutating = false;
    }
  }

  private handleControlApiUrlInput(event: Event): void {
    this.controlApiUrlEdited = true;
    this.controlApiUrl = inputValue(event);
  }

  private handleMachineNameInput(event: Event): void {
    this.machineName = inputValue(event);
    if (!this.machineSlugEdited) this.machineSlug = machineSlugFromName(this.machineName);
  }

  private handleMachineSlugInput(event: Event): void {
    this.machineSlugEdited = true;
    this.machineSlug = inputValue(event);
  }

  private handleLocalPiWebUrlInput(event: Event): void {
    this.localPiWebUrlEdited = true;
    this.localPiWebUrl = inputValue(event);
  }

  private loginDisabledReason(validationMessage: string | undefined): string | undefined {
    if (validationMessage !== undefined) return validationMessage;
    const activeOperation = this.activeRunningOperation();
    if (activeOperation !== undefined) return `${operationKindLabel(activeOperation.kind)} operation is already running`;
    if (this.status !== undefined && !connectorCanRun(this.status)) return connectorUnavailableMessage(this.status);
    return undefined;
  }

  private startDisabledReason(): string | undefined {
    const status = this.status;
    if (status === undefined) return "status has not loaded yet";
    const activeOperation = this.activeRunningOperation();
    if (activeOperation !== undefined) return `${operationKindLabel(activeOperation.kind)} operation is already running`;
    if (!connectorCanRun(status)) return connectorUnavailableMessage(status);
    if (status.config.state !== "registered") return "register or log in first";
    if (status.runtime.state === "running") return "connector is already running";
    if (normalizedOptionalString(this.startFrpcPath) === undefined && status.config.frpcPathConfigured !== true) return "configure an frpc path";
    return undefined;
  }

  private activeRunningOperation(): SafeTunnelOperationResponse | undefined {
    if (this.operation?.status === "running") return this.operation;
    const statusOperation = this.status?.activeOperation;
    return statusOperation?.status === "running" ? statusOperation : undefined;
  }

  private stopDisabledReason(): string | undefined {
    const status = this.status;
    if (status === undefined) return "status has not loaded yet";
    if (!connectorCanRun(status)) return connectorUnavailableMessage(status);
    if (status.runtime.state !== "running") return "connector is not running";
    return undefined;
  }

  private async copyText(value: string, label: string): Promise<void> {
    this.error = "";
    try {
      const copied = await writeClipboardText(value);
      if (!copied) throw new Error("Clipboard write was blocked by the browser.");
      this.message = `${label} copied.`;
    } catch (error) {
      this.error = `Failed to copy ${label.toLowerCase()}: ${errorMessage(error)}`;
    }
  }

  private openUrl(url: string): void {
    if (typeof window === "undefined") return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  static override styles = css`
    :host { display: block; color: var(--pi-text); }
    .panel { display: grid; gap: 14px; }
    header, .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    header { padding-bottom: 4px; }
    h2, h3, p { margin: 0; }
    h2 { font-size: 20px; }
    h3 { font-size: 15px; }
    p { color: var(--pi-muted); line-height: 1.45; }
    .eyebrow { display: block; color: var(--pi-muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; font: inherit; cursor: pointer; }
    button:hover:not(:disabled), button:focus:not(:disabled) { background: var(--pi-surface-hover); }
    button:disabled { cursor: not-allowed; opacity: .55; }
    input { box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); padding: 8px 9px; font: inherit; }
    label { display: grid; gap: 5px; color: var(--pi-text); font-weight: 600; }
    label small { display: inline; margin-left: 4px; font-weight: 400; }
    code { border: 1px solid var(--pi-border); border-radius: 4px; background: var(--pi-bg); padding: 1px 4px; }
    pre { max-height: 180px; overflow: auto; margin: 8px 0 0; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); padding: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
    a { color: var(--pi-accent); overflow-wrap: anywhere; }
    .cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .cards article, .card { min-width: 0; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-surface); padding: 12px; }
    .cards article { display: grid; gap: 4px; }
    .cards strong { color: var(--pi-muted); font-size: 12px; text-transform: uppercase; }
    .cards span { font-weight: 700; }
    .cards small, .help, label small { color: var(--pi-muted); overflow-wrap: anywhere; }
    .card { display: grid; gap: 12px; }
    .status-pill { align-self: flex-start; border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-bg); padding: 3px 8px; font-size: 12px; font-weight: 700; }
    .detail-list { display: grid; gap: 8px; margin: 0; }
    .detail-row { display: grid; grid-template-columns: minmax(120px, 180px) minmax(0, 1fr); gap: 10px; border-top: 1px solid var(--pi-border); padding-top: 8px; }
    .detail-row:first-child { border-top: 0; padding-top: 0; }
    .detail-row dt { color: var(--pi-muted); font-weight: 700; }
    .detail-row dd { min-width: 0; display: grid; gap: 5px; margin: 0; }
    .detail-value { overflow-wrap: anywhere; }
    .detail-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .detail-actions button { padding: 4px 7px; font-size: 12px; }
    .empty-state { border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-bg); padding: 10px; }
    .form-card form { display: grid; gap: 10px; }
    .field-help { margin-top: -4px; font-size: 12px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .actions.compact { margin-top: 8px; }
    .notice { border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-bg); padding: 10px 12px; }
    .callout { display: grid; gap: 4px; border: 1px solid var(--pi-accent-border); border-radius: 10px; background: var(--pi-selection-bg); padding: 10px; }
    .public-url { border-color: var(--pi-success-border); background: var(--pi-success-bg); }
    .user-code { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-bg); padding: 10px; color: var(--pi-text); }
    .user-code span { color: var(--pi-muted); }
    .user-code strong { font: 18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .08em; }
    .good { color: var(--pi-success); }
    .bad, .error { color: var(--pi-danger); }
    .success { color: var(--pi-success); }
    .muted { color: var(--pi-muted); }
    @media (max-width: 760px) {
      header, .section-heading { display: grid; }
      .cards { grid-template-columns: minmax(0, 1fr); }
      .detail-row { grid-template-columns: minmax(0, 1fr); }
    }
  `;
}

export function safeTunnelLoginValidationMessage(fields: SafeTunnelLoginFormFields): string | undefined {
  const controlApiUrl = normalizedOptionalString(fields.controlApiUrl);
  if (controlApiUrl === undefined) return "Control API URL is required.";
  const controlApiUrlError = httpUrlValidationMessage(controlApiUrl, "Control API URL");
  if (controlApiUrlError !== undefined) return controlApiUrlError;

  if (normalizedOptionalString(fields.machineName) === undefined) return "Machine name is required.";

  const machineSlug = normalizedOptionalString(fields.machineSlug);
  if (machineSlug === undefined) return "Machine slug is required.";
  if (!isValidMachineSlug(machineSlug)) return "Machine slug must be a lowercase DNS label (letters, numbers, hyphens; no leading or trailing hyphen).";

  const localPiWebUrl = normalizedOptionalString(fields.localPiWebUrl);
  if (localPiWebUrl !== undefined) {
    const localUrlError = httpUrlValidationMessage(localPiWebUrl, "Local PI WEB URL");
    if (localUrlError !== undefined) return localUrlError;
  }

  return undefined;
}

export function createSafeTunnelLoginRequest(fields: SafeTunnelLoginFormFields): SafeTunnelLoginRequest {
  const base: SafeTunnelLoginRequest = {
    controlApiUrl: normalizedRequiredString(fields.controlApiUrl),
    machineName: normalizedRequiredString(fields.machineName),
    machineSlug: normalizedRequiredString(fields.machineSlug),
  };
  const localPiWebUrl = normalizedOptionalString(fields.localPiWebUrl);
  const frpcPath = normalizedOptionalString(fields.frpcPath);
  if (localPiWebUrl !== undefined && frpcPath !== undefined) return { ...base, localPiWebUrl, frpcPath };
  if (localPiWebUrl !== undefined) return { ...base, localPiWebUrl };
  if (frpcPath !== undefined) return { ...base, frpcPath };
  return base;
}

export function machineSlugFromName(name: string): string {
  const slug = name.trim().toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-|-$/gu, "");
  return slug === "" ? defaultMachineSlug : slug.slice(0, 63).replace(/-$/u, "");
}

export function safeTunnelRuntimeSummary(runtime: SafeTunnelRuntimeStatus): string {
  const label = runtimeStateLabel(runtime.state);
  return runtime.pid === undefined ? label : `${label} (PID ${String(runtime.pid)})`;
}

function currentTunnelDescription(machine: NonNullable<SafeTunnelStatusResponse["config"]["machine"]>): string {
  if (machine.machineSlug !== undefined && machine.machineSlug.trim() !== "") return `slug ${machine.machineSlug}`;
  if (machine.publicUrl !== undefined && machine.publicUrl.trim() !== "") return machine.publicUrl;
  return `machine ${machine.machineId}`;
}

function inputValue(event: Event): string {
  if (event.target instanceof HTMLInputElement) return event.target.value;
  return "";
}

function connectorCanRun(status: SafeTunnelStatusResponse): boolean {
  return status.connector.state === "available" || status.connector.state === "installable";
}

function connectorUnavailableMessage(status: SafeTunnelStatusResponse): string {
  return status.connector.error ?? `Connector command ${status.connector.command} is unavailable.`;
}

function normalizedRequiredString(value: string): string {
  return value.trim();
}

function normalizedOptionalString(value: string): string | undefined {
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function httpUrlValidationMessage(value: string, label: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return `${label} must use http:// or https://.`;
    if (url.username !== "" || url.password !== "") return `${label} must not include credentials.`;
    return undefined;
  } catch {
    return `${label} must be a valid URL.`;
  }
}

function isValidMachineSlug(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
}

function connectorStateClass(state: SafeTunnelStatusResponse["connector"]["state"]): string {
  if (state === "available") return "good";
  if (state === "installable") return "muted";
  return "bad";
}

function connectorStateLabel(state: SafeTunnelStatusResponse["connector"]["state"]): string {
  if (state === "available") return "Available";
  if (state === "installable") return "Installs on demand";
  return "Unavailable";
}

function configStateLabel(state: SafeTunnelStatusResponse["config"]["state"]): string {
  switch (state) {
    case "missing":
      return "No connector config";
    case "unregistered":
      return "Not registered";
    case "registered":
      return "Registered";
    case "invalid":
      return "Invalid config";
  }
}

function runtimeStateClass(state: SafeTunnelRuntimeStatus["state"]): string {
  if (state === "running") return "good";
  if (state === "stale" || state === "unknown") return "bad";
  return "muted";
}

function runtimeStateLabel(state: SafeTunnelRuntimeStatus["state"]): string {
  switch (state) {
    case "stopped":
      return "Stopped";
    case "running":
      return "Running";
    case "stale":
      return "Stale PID file";
    case "unknown":
      return "Unknown";
  }
}

function operationKindLabel(kind: SafeTunnelOperationResponse["kind"]): string {
  switch (kind) {
    case "login":
      return "Login";
    case "start":
      return "Start";
  }
}

function operationStatusLabel(status: SafeTunnelOperationResponse["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
  }
}

function operationSucceededMessage(operation: SafeTunnelOperationResponse): string {
  if (operation.kind === "login") {
    return operation.publicUrl === undefined ? "Safe Tunnel login completed." : "Safe Tunnel login completed. Public URL is ready.";
  }

  return operation.exitCode === 0 ? "Safe Tunnel connector exited cleanly." : "Safe Tunnel start completed.";
}

function formatExitCode(exitCode: number | null): string {
  return exitCode === null ? "unknown" : exitCode.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
