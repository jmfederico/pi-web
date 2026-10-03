import { css, html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  SafeTunnelEnableRequest,
  SafeTunnelOperationResponse,
  SafeTunnelRuntimeStatus,
  SafeTunnelStatusResponse,
} from "../../../../shared/apiTypes";
import type { SafeTunnelAccountAccessNotice } from "../../../../shared/safeTunnelTypes";
import {
  isSafeTunnelControlApiTransportAllowed,
} from "../../../../shared/safeTunnelUrlPolicy";
import { safeTunnelApi, type SafeTunnelApi } from "../../api/safeTunnelClient";
import { writeClipboardText } from "../../clipboard";

const operationPollIntervalMs = 2_000;
const productionControlApiUrl = "https://api.tunnels.pi-web.dev";
const maximumBrowserErrorCharacters = 2_000;
const maximumUrlCharacters = 2_048;

export interface SafeTunnelAdvancedFields {
  controlApiUrl: string;
}

export interface SafeTunnelPresentation {
  readonly action: "disable" | "enable";
  readonly description: string;
  readonly label: string;
  readonly tone: "bad" | "good" | "muted";
}

@customElement("settings-safe-tunnel-panel")
export class SettingsSafeTunnelPanel extends LitElement {
  @property({ attribute: false }) api: SafeTunnelApi = safeTunnelApi;
  @state() private status: SafeTunnelStatusResponse | undefined;
  @state() private operation: SafeTunnelOperationResponse | undefined;
  @state() private loading = true;
  @state() private mutating = false;
  @state() private error = "";
  @state() private message = "";
  @state() private controlApiUrl = "";
  private advancedFieldsInitialized = false;
  private advancedFieldsEdited = false;
  private connectionGeneration = 0;
  private operationPollTimer: number | undefined;
  private requestSequence = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    this.connectionGeneration += 1;
    void this.loadStatus();
  }

  override disconnectedCallback(): void {
    this.connectionGeneration += 1;
    this.requestSequence += 1;
    this.loading = false;
    this.mutating = false;
    this.clearOperationPollTimer();
    super.disconnectedCallback();
  }

  override render(): TemplateResult {
    return html`
      <section class="panel" aria-live="polite">
        <header>
          <div>
            <span class="eyebrow">Safe Tunnel</span>
            <h2>Expose this instance through PI WEB Tunnels</h2>
            <p>Enable the tunnel, approve access, and get a public URL. PI WEB handles setup automatically.</p>
          </div>
          <button type="button" @click=${() => { void this.loadStatus(); }} ?disabled=${this.loading || this.mutating}>Refresh</button>
        </header>

        ${this.error === "" ? null : html`<div class="notice error" role="alert">${this.error}</div>`}
        ${this.message === "" ? null : html`<div class="notice success">${this.message}</div>`}
        ${this.loading && this.status === undefined ? html`<div class="notice">Loading Safe Tunnel status…</div>` : null}
        <div class="notice warning" role="note">
          <strong>Protect the public ingress.</strong>
          A tunnel makes this PI WEB reachable outside its local network. The tunnel service must enforce authentication and access control for your instance.
        </div>

        ${this.renderPrimaryCard()}
        ${this.renderOperation()}
        ${this.renderDiagnostics()}
        ${this.renderDevelopmentSettings()}
      </section>
    `;
  }

  private renderPrimaryCard(): TemplateResult {
    const status = this.status;
    if (status === undefined) {
      return html`
        <section class="card hero-card">
          <div>
            <span class="status-pill muted">Loading</span>
            <h3>Checking Safe Tunnel…</h3>
          </div>
        </section>
      `;
    }

    const activeOperation = this.activeRunningOperation();
    const presentation = safeTunnelPresentation(status, activeOperation);
    const registrationRejected = safeTunnelRegistrationRejected(status);
    const publicUrl = activeOperation?.publicUrl
      ?? (registrationRejected
        ? undefined
        : this.operation?.publicUrl ?? status.config.machine?.publicUrl);
    const disabledReason = this.primaryActionDisabledReason(presentation);
    return html`
      <section class="card hero-card" aria-labelledby="safe-tunnel-state-heading">
        <div class="section-heading">
          <div>
            <span class=${`status-pill ${presentation.tone}`}>${presentation.label}</span>
            <h3 id="safe-tunnel-state-heading">${presentation.description}</h3>
          </div>
          <button
            class="primary-action"
            type="button"
            @click=${() => { void this.runPrimaryAction(presentation.action); }}
            ?disabled=${disabledReason !== undefined || this.mutating}
          >${presentation.action === "enable" ? "Enable Safe Tunnel" : "Disable Safe Tunnel"}</button>
        </div>

        ${publicUrl === undefined ? html`
          <p class="help">PI WEB will connect this instance to PI WEB Tunnels. If approval is needed, you will receive a link to authorize it.</p>
        ` : html`
          <div class="public-url">
            <span>Public URL</span>
            <a href=${publicUrl} target="_blank" rel="noreferrer">${publicUrl}</a>
            <div class="actions compact">
              <button type="button" @click=${() => { this.openUrl(publicUrl); }}>Open</button>
              <button type="button" @click=${() => { void this.copyText(publicUrl, "Public URL"); }}>Copy</button>
            </div>
          </div>
        `}
        ${disabledReason === undefined ? null : html`<p class="help bad">${disabledReason}</p>`}
      </section>
    `;
  }

  private renderOperation(): TemplateResult | null {
    const operation = this.operation ?? this.status?.activeOperation;
    if (operation === undefined) return null;
    const approvalUrl = operation.verificationUriComplete;
    const operationAccountAccess = this.status?.runtime.accountAccess === undefined
      ? operation.accountAccess
      : undefined;
    return html`
      <section class="card operation-card" aria-labelledby="safe-tunnel-progress-heading">
        <div class="section-heading">
          <div>
            <span class=${`status-pill ${operationTone(operation)}`}>${operationStatusLabel(operation.status)}</span>
            <h3 id="safe-tunnel-progress-heading">${operationPhaseLabel(operation.phase)}</h3>
            <p>${operationPhaseDescription(operation)}</p>
          </div>
          ${operation.status === "running" ? html`<button type="button" @click=${() => { void this.pollOperation(operation.id); }}>Check now</button>` : null}
        </div>

        ${approvalUrl === undefined || operation.phase !== "awaiting_approval" ? null : html`
          <div class="approval-callout">
            <strong>Approve this PI WEB</strong>
            <p>Open the provider approval page and follow its instructions for this machine. PI WEB continues automatically after approval.</p>
            <a href=${approvalUrl} target="_blank" rel="noreferrer">${approvalUrl}</a>
            ${operation.userCode === undefined ? null : html`
              <p class="user-code"><span>Approval code</span><strong>${operation.userCode}</strong></p>
            `}
            <div class="actions compact">
              <button type="button" @click=${() => { this.openUrl(approvalUrl); }}>Open approval page</button>
              <button type="button" @click=${() => { void this.copyText(approvalUrl, "Approval URL"); }}>Copy approval URL</button>
              ${operation.userCode === undefined ? null : html`<button type="button" @click=${() => { void this.copyText(operation.userCode ?? "", "Approval code"); }}>Copy code</button>`}
            </div>
          </div>
        `}

        ${operationAccountAccess === undefined
          ? null
          : renderAccountAccessNotice(operationAccountAccess)}
        ${operation.error === undefined ? null : html`<p class="bad" role="alert">${operation.error}</p>`}
      </section>
    `;
  }

  private renderDiagnostics(): TemplateResult | null {
    const status = this.status;
    if (status === undefined) return null;
    const rejected = safeTunnelRegistrationRejected(status);
    const runtime = status.runtime;
    if (runtime.accountAccess !== undefined) {
      return html`
        <section class="card diagnostics-card account-access-card">
          ${renderAccountAccessNotice(runtime.accountAccess)}
          ${runtime.error === undefined ? null : html`<p class="bad">${runtime.error}</p>`}
        </section>
      `;
    }
    if (!rejected && runtime.error === undefined && status.config.error === undefined) return null;

    return html`
      <section class=${`card diagnostics-card ${rejected ? "revoked" : ""}`}>
        <div>
          <h3>${rejected ? "Safe Tunnel approval is no longer valid" : "Safe Tunnel diagnostics"}</h3>
          <p>${rejected
            ? "This machine's provider registration was rejected or revoked. Enable Safe Tunnel to approve a replacement registration."
            : "PI WEB is keeping your requested state and reports the current failure below."}</p>
        </div>
        ${status.config.error === undefined ? null : html`<p class="bad">${status.config.error}</p>`}
        ${runtime.error === undefined ? null : html`<p class=${rejected ? "bad" : "help"}>${runtime.error}</p>`}
      </section>
    `;
  }

  private renderDevelopmentSettings(): TemplateResult {
    const validationMessage = safeTunnelAdvancedValidationMessage(this.advancedFields());
    const status = this.status;
    return html`
      <details class="card advanced-card">
        <summary>Advanced development settings</summary>
        <p class="help">Use a development tunnel service for testing. The saved service URL is prefilled; clear it to use production the next time you enable Safe Tunnel.</p>
        <div class="advanced-grid">
          <label>
            Tunnel service API URL
            <input .value=${this.controlApiUrl} placeholder=${productionControlApiUrl} @input=${(event: Event) => { this.advancedFieldsEdited = true; this.controlApiUrl = inputValue(event); }}>
            <small>Blank uses the production tunnel service.</small>
          </label>
        </div>
        ${validationMessage === undefined ? null : html`<p class="bad">${validationMessage}</p>`}
        ${status === undefined ? null : html`
          <details class="technical-diagnostics">
            <summary>Saved technical state</summary>
            <dl class="detail-list">
              ${detailRow("Registration", configStateLabel(status.config.state))}
              ${detailRow("Machine ID", status.config.machine?.machineId)}
              ${detailRow("Machine slug", status.config.machine?.machineSlug)}
              ${detailRow("Public URL", status.config.machine?.publicUrl)}
              ${detailRow("Tunnel service API", status.config.controlApiUrl)}
              ${detailRow("Local target", status.config.localPiWebUrl)}
              ${detailRow("Runtime", safeTunnelRuntimeSummary(status.runtime))}
            </dl>
          </details>
        `}
      </details>
    `;
  }

  private advancedFields(): SafeTunnelAdvancedFields {
    return {
      controlApiUrl: this.controlApiUrl,
    };
  }

  private initializeAdvancedFields(status: SafeTunnelStatusResponse): void {
    if (this.advancedFieldsInitialized) return;
    this.advancedFieldsInitialized = true;
    if (this.advancedFieldsEdited) return;

    const fields = safeTunnelAdvancedPrefill(status);
    this.controlApiUrl = fields.controlApiUrl;
  }

  private async loadStatus(): Promise<void> {
    if (!this.isConnected) return;
    const { connectionGeneration, requestSequence } = this.beginApiRequest();
    this.loading = true;
    this.error = "";
    try {
      const status = await this.api.status();
      if (!this.isCurrentRequest(connectionGeneration, requestSequence)) return;
      this.applyStatus(status);
    } catch (error) {
      if (this.isCurrentRequest(connectionGeneration, requestSequence)) {
        this.error = `Failed to load Safe Tunnel status: ${errorMessage(error)}`;
      }
    } finally {
      if (this.isCurrentRequest(connectionGeneration, requestSequence)) this.loading = false;
    }
  }

  private applyStatus(status: SafeTunnelStatusResponse): void {
    this.initializeAdvancedFields(status);
    this.status = status;
    if (status.activeOperation !== undefined) {
      this.operation = status.activeOperation;
      this.scheduleOperationPoll(status.activeOperation);
    } else if (this.operation?.status === "running") {
      this.operation = undefined;
    }
  }

  private async enableSafeTunnel(): Promise<void> {
    const validationMessage = safeTunnelAdvancedValidationMessage(this.advancedFields());
    if (validationMessage !== undefined) {
      this.error = validationMessage;
      return;
    }

    const { connectionGeneration, requestSequence } = this.beginApiRequest();
    this.mutating = true;
    this.error = "";
    this.message = "Preparing Safe Tunnel enablement…";
    try {
      const response = await this.api.enable(
        createSafeTunnelEnableRequest(this.advancedFields()),
      );
      if (!this.isCurrentRequest(connectionGeneration, requestSequence)) return;
      this.applyStatus(response.status);
      this.operation = response.operation;
      this.message = response.operation.phase === "awaiting_approval"
        ? "Approval is ready. Open the provider page to continue."
        : "Safe Tunnel enablement started.";
      this.scheduleOperationPoll(response.operation);
    } catch (error) {
      if (this.isCurrentRequest(connectionGeneration, requestSequence)) {
        this.error = `Failed to enable Safe Tunnel: ${errorMessage(error)}`;
        this.message = "";
      }
    } finally {
      if (this.isCurrentRequest(connectionGeneration, requestSequence)) this.mutating = false;
    }
  }

  private async disableSafeTunnel(): Promise<void> {
    const { connectionGeneration, requestSequence } = this.beginApiRequest();
    this.mutating = true;
    this.error = "";
    this.message = "Disabling Safe Tunnel…";
    try {
      const response = await this.api.disable();
      if (!this.isCurrentRequest(connectionGeneration, requestSequence)) return;
      this.status = response.status;
      this.operation = undefined;
      this.message = "Safe Tunnel is disabled.";
    } catch (error) {
      if (this.isCurrentRequest(connectionGeneration, requestSequence)) {
        this.error = `Failed to disable Safe Tunnel: ${errorMessage(error)}`;
        this.message = "";
      }
    } finally {
      if (this.isCurrentRequest(connectionGeneration, requestSequence)) this.mutating = false;
    }
  }

  private runPrimaryAction(action: SafeTunnelPresentation["action"]): Promise<void> {
    return action === "enable" ? this.enableSafeTunnel() : this.disableSafeTunnel();
  }

  private async pollOperation(operationId: string): Promise<void> {
    const { connectionGeneration, requestSequence } = this.beginApiRequest();
    this.error = "";
    try {
      const operation = await this.api.operation(operationId);
      if (!this.isCurrentRequest(connectionGeneration, requestSequence)) return;
      this.operation = operation;
      if (operation.status === "running") {
        this.scheduleOperationPoll(operation);
        return;
      }
      if (operation.status === "succeeded") {
        this.message = "Safe Tunnel is enabled. The public URL is ready.";
      } else if (operation.status === "cancelled") {
        this.message = "Safe Tunnel enablement was cancelled.";
      } else {
        this.message = "";
      }
      await this.loadStatus();
    } catch (error) {
      if (!this.isCurrentRequest(connectionGeneration, requestSequence)) return;
      this.clearOperationPollTimer();
      this.error = `Failed to refresh Safe Tunnel progress: ${errorMessage(error)}`;
    }
  }

  private scheduleOperationPoll(operation: SafeTunnelOperationResponse): void {
    this.clearOperationPollTimer();
    if (!this.isConnected || operation.status !== "running" || typeof window === "undefined") return;
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

  private beginApiRequest(): { connectionGeneration: number; requestSequence: number } {
    this.clearOperationPollTimer();
    this.loading = false;
    this.mutating = false;
    return {
      connectionGeneration: this.connectionGeneration,
      requestSequence: ++this.requestSequence,
    };
  }

  private isCurrentConnection(connectionGeneration: number): boolean {
    return this.isConnected && connectionGeneration === this.connectionGeneration;
  }

  private isCurrentRequest(connectionGeneration: number, requestSequence: number): boolean {
    return this.isCurrentConnection(connectionGeneration)
      && requestSequence === this.requestSequence;
  }

  private activeRunningOperation(): SafeTunnelOperationResponse | undefined {
    if (this.operation?.status === "running") return this.operation;
    const statusOperation = this.status?.activeOperation;
    return statusOperation?.status === "running" ? statusOperation : undefined;
  }

  private primaryActionDisabledReason(
    presentation: SafeTunnelPresentation,
  ): string | undefined {
    if (this.status === undefined) return "Safe Tunnel status has not loaded yet.";
    if (presentation.action === "enable") {
      if (this.status.config.state === "invalid") {
        return "Repair the private Safe Tunnel state before enabling.";
      }
      return safeTunnelAdvancedValidationMessage(this.advancedFields());
    }
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
    h3 { margin-top: 5px; font-size: 16px; }
    p { color: var(--pi-muted); line-height: 1.45; }
    .eyebrow { display: block; color: var(--pi-muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; font: inherit; cursor: pointer; }
    button:hover:not(:disabled), button:focus:not(:disabled) { background: var(--pi-surface-hover); }
    button:disabled { cursor: not-allowed; opacity: .55; }
    .primary-action { min-width: 150px; border-color: var(--pi-accent-border); background: var(--pi-selection-bg); font-weight: 700; }
    input { box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); padding: 8px 9px; font: inherit; }
    label { display: grid; gap: 5px; color: var(--pi-text); font-weight: 600; }
    label small, .help { color: var(--pi-muted); font-weight: 400; }
    a { color: var(--pi-accent); overflow-wrap: anywhere; }
    .card { min-width: 0; display: grid; gap: 12px; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-surface); padding: 14px; }
    .hero-card { gap: 14px; }
    .status-pill { display: inline-block; border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-bg); padding: 3px 8px; font-size: 12px; font-weight: 700; }
    .public-url, .approval-callout, .account-access-notice { display: grid; gap: 6px; border: 1px solid var(--pi-success-border); border-radius: 10px; background: var(--pi-success-bg); padding: 11px; }
    .public-url > span { color: var(--pi-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .approval-callout { border-color: var(--pi-accent-border); background: var(--pi-selection-bg); }
    .account-access-notice { border-color: var(--pi-warning-border, var(--pi-border)); background: var(--pi-warning-bg, var(--pi-bg)); }
    .account-access-notice strong { color: var(--pi-warning, var(--pi-text)); }
    .dashboard-action { width: fit-content; font-weight: 700; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .actions.compact { margin-top: 3px; }
    .user-code { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--pi-text); }
    .user-code span { color: var(--pi-muted); }
    .user-code strong { font: 18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .08em; }
    .diagnostics-card.revoked { border-color: var(--pi-danger); }
    .advanced-card > summary { cursor: pointer; font-weight: 700; }
    .advanced-grid { display: grid; gap: 11px; margin-top: 12px; }
    .detail-list { display: grid; gap: 7px; margin: 10px 0 0; }
    .detail-row { display: grid; grid-template-columns: minmax(110px, 160px) minmax(0, 1fr); gap: 10px; border-top: 1px solid var(--pi-border); padding-top: 7px; }
    .detail-row:first-child { border-top: 0; }
    .detail-row dt { color: var(--pi-muted); font-weight: 700; }
    .detail-row dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
    .notice { border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-bg); padding: 10px 12px; }
    .warning { border-color: var(--pi-warning-border, var(--pi-border)); background: var(--pi-warning-bg, var(--pi-bg)); color: var(--pi-text); line-height: 1.45; }
    .warning strong { color: var(--pi-warning); }
    .good, .success { color: var(--pi-success); }
    .bad, .error { color: var(--pi-danger); }
    .muted { color: var(--pi-muted); }
    @media (max-width: 760px) {
      header, .section-heading { display: grid; }
      .primary-action { width: 100%; }
      .detail-row { grid-template-columns: minmax(0, 1fr); }
    }
  `;
}

export function safeTunnelAdvancedPrefill(
  status: SafeTunnelStatusResponse,
): SafeTunnelAdvancedFields {
  return {
    controlApiUrl: status.config.controlApiUrl?.replace(/\/$/u, "") === productionControlApiUrl
      ? ""
      : status.config.controlApiUrl ?? "",
  };
}

export function safeTunnelAdvancedValidationMessage(
  fields: SafeTunnelAdvancedFields,
): string | undefined {
  const controlApiUrl = normalizedOptionalString(fields.controlApiUrl);
  if (controlApiUrl !== undefined) {
    const error = controlApiUrlValidationMessage(controlApiUrl);
    if (error !== undefined) return error;
  }

  return undefined;
}

export function createSafeTunnelEnableRequest(
  fields: SafeTunnelAdvancedFields,
): SafeTunnelEnableRequest {
  const controlApiUrl = normalizedOptionalString(fields.controlApiUrl);
  return controlApiUrl === undefined ? {} : { controlApiUrl };
}

export function safeTunnelPresentation(
  status: SafeTunnelStatusResponse,
  operation?: SafeTunnelOperationResponse,
): SafeTunnelPresentation {
  if (status.runtime.accountAccess !== undefined) {
    const accountAccess = status.runtime.accountAccess;
    const deactivated = accountAccess.status === "account_access_deactivated";
    const runtimeStillRunning = status.runtime.state === "running";
    const enablementStillRunning = operation?.status === "running";
    return {
      action: runtimeStillRunning || enablementStillRunning || deactivated
        ? "disable"
        : "enable",
      description: accountAccessDescription(deactivated, runtimeStillRunning),
      label: accountAccessLabel(accountAccess),
      tone: "bad",
    };
  }
  if (operation?.status === "running") {
    return {
      action: "disable",
      description: operationPhaseDescription(operation),
      label: "Enabling",
      tone: "muted",
    };
  }
  if (status.runtime.state === "running") {
    return {
      action: "disable",
      description: "Safe Tunnel is enabled and supervised by PI WEB.",
      label: "Enabled",
      tone: "good",
    };
  }
  if (safeTunnelRegistrationRejected(status)) {
    return {
      action: "enable",
      description: "Provider access needs your approval again.",
      label: "Approval required",
      tone: "bad",
    };
  }
  if (status.desiredState === "enabled"
    && (status.runtime.diagnosticCode === "registration_required"
      || status.config.state === "missing"
      || status.config.state === "unregistered")) {
    return {
      action: "enable",
      description: "This PI WEB needs approval before Safe Tunnel can start.",
      label: "Approval required",
      tone: "bad",
    };
  }
  if (status.desiredState === "disabled") {
    return {
      action: "enable",
      description: "Safe Tunnel is off.",
      label: "Disabled",
      tone: "muted",
    };
  }
  return {
    action: "disable",
    description: "Safe Tunnel is enabled in settings, but its runtime is not running.",
    label: "Stopped",
    tone: status.runtime.error === undefined ? "muted" : "bad",
  };
}

export function safeTunnelRuntimeSummary(runtime: SafeTunnelRuntimeStatus): string {
  return runtime.accountAccess === undefined
    ? runtimeStateLabel(runtime.state)
    : `${runtimeStateLabel(runtime.state)} — ${accountAccessLabel(runtime.accountAccess)}`;
}

function safeTunnelRegistrationRejected(status: SafeTunnelStatusResponse): boolean {
  return status.config.state === "rejected"
    || status.runtime.diagnosticCode === "credentials_rejected";
}

function renderAccountAccessNotice(
  notice: SafeTunnelAccountAccessNotice,
): TemplateResult {
  return html`
    <div class="account-access-notice" role="alert">
      <strong>${accountAccessHeading(notice)}</strong>
      <p>${notice.message}</p>
      <a
        class="dashboard-action"
        href=${notice.dashboardUrl}
        target="_blank"
        rel="noreferrer"
      >Open hosted dashboard</a>
    </div>
  `;
}

function accountAccessDescription(
  deactivated: boolean,
  runtimeStillRunning: boolean,
): string {
  if (runtimeStillRunning) {
    return deactivated
      ? "This hosted account is permanently deactivated, but the Safe Tunnel runtime is still running. Retry Disable and open the hosted dashboard for details."
      : "Hosted account access is blocked, but the Safe Tunnel runtime is still running. Retry Disable and use the hosted dashboard to restore access.";
  }
  return deactivated
    ? "This hosted account is permanently deactivated. Open the hosted dashboard for details."
    : "Restore account access in the hosted dashboard, then retry Safe Tunnel.";
}

function accountAccessHeading(notice: SafeTunnelAccountAccessNotice): string {
  switch (notice.status) {
    case "account_access_payment_required":
      return "Account access is required";
    case "account_access_suspended":
      return "Account access is suspended";
    case "account_access_deactivated":
      return "Account is permanently deactivated";
  }
}

function accountAccessLabel(notice: SafeTunnelAccountAccessNotice): string {
  switch (notice.status) {
    case "account_access_payment_required":
      return "Payment required";
    case "account_access_suspended":
      return "Suspended";
    case "account_access_deactivated":
      return "Account deactivated";
  }
}

function operationPhaseLabel(phase: SafeTunnelOperationResponse["phase"]): string {
  switch (phase) {
    case "preparing":
      return "Preparing Safe Tunnel";
    case "awaiting_approval":
      return "Waiting for your approval";
    case "registering":
      return "Registering this PI WEB";
    case "starting":
      return "Starting the managed tunnel";
    case "enabled":
      return "Safe Tunnel enabled";
  }
}

function operationPhaseDescription(operation: SafeTunnelOperationResponse): string {
  if (operation.status === "failed") return "Safe Tunnel could not finish enabling.";
  if (operation.status === "cancelled") return "Safe Tunnel enablement was cancelled.";
  switch (operation.phase) {
    case "preparing":
      return "PI WEB is applying production and inferred local defaults.";
    case "awaiting_approval":
      return "Approve this PI WEB in the provider page. Registration and startup continue automatically.";
    case "registering":
      return "Approval received. PI WEB is saving the private machine credential.";
    case "starting":
      return "PI WEB is verifying the managed runtime and starting supervision.";
    case "enabled":
      return "The public URL is ready and PI WEB is supervising the tunnel.";
  }
}

function operationTone(operation: SafeTunnelOperationResponse): SafeTunnelPresentation["tone"] {
  if (operation.status === "failed") return "bad";
  if (operation.status === "succeeded") return "good";
  return "muted";
}

function operationStatusLabel(status: SafeTunnelOperationResponse["status"]): string {
  switch (status) {
    case "running":
      return "In progress";
    case "succeeded":
      return "Enabled";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function configStateLabel(state: SafeTunnelStatusResponse["config"]["state"]): string {
  switch (state) {
    case "missing":
    case "unregistered":
      return "Not registered";
    case "registered":
      return "Registered";
    case "rejected":
      return "Approval required";
    case "invalid":
      return "Invalid state";
  }
}

function runtimeStateLabel(state: SafeTunnelRuntimeStatus["state"]): string {
  switch (state) {
    case "stopped":
      return "Stopped";
    case "running":
      return "Running";
    case "unknown":
      return "Starting";
  }
}

function detailRow(label: string, value: string | undefined): TemplateResult {
  return html`<div class="detail-row"><dt>${label}</dt><dd>${value ?? "Not reported"}</dd></div>`;
}

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : "";
}

function normalizedOptionalString(value: string): string | undefined {
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function controlApiUrlValidationMessage(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Tunnel service API URL must be a valid URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Tunnel service API URL must use http:// or https://.";
  }
  if (value.length > maximumUrlCharacters) {
    return "Tunnel service API URL must be at most 2048 characters.";
  }
  if (!isSafeTunnelControlApiTransportAllowed(url)) {
    return "Tunnel service API URL must use HTTPS unless it is a literal loopback development endpoint.";
  }
  if (url.username !== "" || url.password !== "") {
    return "Tunnel service API URL must not include credentials.";
  }
  if (url.search !== "" || url.hash !== "") {
    return "Tunnel service API URL must not include a query or fragment.";
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= maximumBrowserErrorCharacters
    ? message
    : message.slice(0, maximumBrowserErrorCharacters);
}
