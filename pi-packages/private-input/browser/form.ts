import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { StylesheetIntegrationCapabilityV1, TranscriptToolRendererInput } from "@jmfederico/pi-web/plugin-api";
import { isFinished, MAX_SECRET_BYTES, parseRecord, recordObject, type PrivateInputRecord } from "../protocol.js";

/** Only the native field and the in-flight request hold the value; never a Lit property or draft. */
export class PrivateInputForm extends LitElement {
  @property({ attribute: false }) context: TranscriptToolRendererInput | undefined;
  @property({ attribute: false }) stylesIntegration: StylesheetIntegrationCapabilityV1 | undefined;
  @state() private record: PrivateInputRecord | undefined;
  @state() private busy = false;
  @state() private ready = false;
  @state() private confirmed = false;
  @state() private delivered = false;
  @state() private active = false;
  @state() private notice = "";
  private lifetime: AbortController | undefined;
  private releaseStyles: (() => void) | undefined;
  private releaseSignal: (() => void) | undefined;

  static override styles = css`
    :host { display: block; min-width: 0; color: var(--pi-text); font: inherit; }
    section { padding: 12px; display: grid; gap: 12px; }
    h3, p { margin: 0; font: inherit; }
    h3 { font-weight: 600; }
    .destination { overflow-wrap: anywhere; white-space: pre-wrap; font-family: var(--pi-mono, monospace); }
    .field { display: grid; gap: 6px; }
    textarea { box-sizing: border-box; width: 100%; min-height: 100px; resize: vertical;
      padding: 8px; font: inherit; color: var(--pi-text); background: var(--pi-bg);
      border: 1px solid var(--pi-border); border-radius: 4px; }
    textarea:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .confirmation { display: flex; align-items: flex-start; gap: 8px; }
    .confirmation input { flex: none; margin-top: 3px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .help { color: var(--pi-muted); }
    .notice { color: var(--pi-warning, var(--pi-text)); }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("pagehide", this.clearValue);
    // Reconnection can retain the same context property, but never its old request lifetime.
    this.requestUpdate("context");
  }

  override disconnectedCallback(): void {
    this.disposeContext();
    this.releaseStyles?.();
    this.releaseStyles = undefined;
    window.removeEventListener("pagehide", this.clearValue);
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("stylesIntegration")) { this.releaseStyles?.(); this.releaseStyles = undefined; }
    if (this.renderRoot instanceof ShadowRoot) {
      this.releaseStyles ??= this.stylesIntegration?.registerRoot(this.renderRoot, { sharedUi: true });
    }
    if (changed.has("context")) this.resetContext();
  }

  private readonly clearValue = (): void => {
    const field = this.renderRoot.querySelector("textarea");
    if (field) field.value = "";
    const checkbox = this.renderRoot.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (checkbox) checkbox.checked = false;
    this.confirmed = false;
  };

  private disposeContext(): void {
    this.clearValue();
    this.releaseSignal?.();
    this.releaseSignal = undefined;
    this.lifetime?.abort();
    this.lifetime = undefined;
    this.ready = false;
  }

  private resetContext(): void {
    this.disposeContext();
    this.record = undefined;
    this.busy = false;
    this.delivered = false;
    this.active = false;
    this.notice = "";
    const context = this.context;
    if (!context || context.signal.aborted || !this.isConnected) return;
    try {
      const record = parseRecord(recordObject(context.entry.details)["privateInput"]);
      if (record.sessionId !== context.scope.sessionId) throw new Error("Different session");
      this.record = record;
    } catch {
      this.notice = "This private input request is not available in this conversation.";
      return;
    }
    const lifetime = new AbortController();
    this.lifetime = lifetime;
    const abort = () => { this.disposeContext(); };
    context.signal.addEventListener("abort", abort, { once: true });
    this.releaseSignal = () => { context.signal.removeEventListener("abort", abort); };
    void this.perform("status");
  }

  private isCurrent(lifetime: AbortController): boolean {
    return this.lifetime === lifetime && !lifetime.signal.aborted;
  }

  private async perform(operation: "status" | "submit" | "cancel" | "notify", secret?: string): Promise<void> {
    const context = this.context;
    const record = this.record;
    const lifetime = this.lifetime;
    if (!context || !record || !lifetime || !this.isCurrent(lifetime) || this.busy) return;
    this.busy = true;
    this.ready = false;
    this.notice = "";
    try {
      const { projectId, workspaceId } = context.scope;
      if (projectId === undefined || workspaceId === undefined || !context.backend) throw new Error("Backend unavailable");
      const peer = context.backend.forScope({ kind: "workspace", projectId, workspaceId });
      if (!peer.request) throw new Error("Backend unavailable");
      const response = await peer.request(operation, {
        sessionId: record.sessionId, requestId: record.requestId,
        ...(operation === "submit" ? { confirmedDestination: record.destination, secret: secret ?? "" } : {}),
      }, { signal: lifetime.signal });
      if (!this.isCurrent(lifetime)) return;
      const data = recordObject(response);
      const current = parseRecord(data["record"]);
      if (current.requestId !== record.requestId || current.sessionId !== record.sessionId
        || current.destination !== record.destination) throw new Error("Unexpected response");
      this.record = current;
      this.active = data["active"] === true;
      this.delivered = data["delivered"] === true || this.delivered;
      this.ready = true;
      if (current.status !== "waiting") this.clearValue();
      if (data["unavailable"] === true) {
        this.notice = "The agent is busy or the request is no longer active. Refresh status when the conversation is idle.";
      } else if (data["delivered"] === false && isFinished(current)) {
        this.notice = "The outcome is saved, but agent notification was not confirmed. Retry Notify agent when the conversation is idle.";
      }
    } catch {
      if (this.isCurrent(lifetime)) {
        // Transport errors may contain submitted input. Never render, log, or forward them to fail().
        this.clearValue();
        this.notice = "The operation could not be confirmed. Refresh status before trying again; the value will not be resent.";
      }
    } finally {
      if (this.lifetime === lifetime) this.busy = false;
    }
  }

  private readonly submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!this.ready || this.busy || !this.confirmed || this.record?.status !== "waiting") return;
    const field = this.renderRoot.querySelector("textarea");
    if (!field || field.value.length === 0) return;
    if (new TextEncoder().encode(field.value).byteLength > MAX_SECRET_BYTES) {
      this.notice = "The value is too large. Enter no more than 64 KiB of UTF-8 text.";
      return;
    }
    const value = field.value;
    this.clearValue();
    void this.perform("submit", value);
  };

  private readonly cancel = (): void => {
    this.clearValue();
    void this.perform("cancel");
  };

  private statusText(): string {
    switch (this.record?.status) {
      case "saved": return "File saved. The value was not added to the conversation.";
      case "cancelled": return "Request cancelled. No file was written.";
      case "writing": return this.active ? "Saving the file. Refresh status to check the outcome."
        : "The write was interrupted. Recover the outcome without resubmitting the value.";
      case "waiting":
      case undefined: return "";
      case "failed":
        return {
          exists: "The destination already exists. It was not overwritten.",
          destination_changed: "The destination changed after confirmation. No file was written.",
          write_uncertain: "The write could not be confirmed. A file may exist; do not resubmit the value.",
          write_failed: "The file could not be written. Ask the agent for a new request if needed.",
        }[this.record.failure ?? "write_failed"];
    }
  }

  override render() {
    const record = this.record;
    const waiting = record?.status === "waiting";
    return html`<section aria-label="Private input" aria-busy=${this.busy}>
      <h3>Private input</h3>
      ${record ? html`
        <p>${record.purpose}</p>
        <div><p>Save on machine: ${this.context?.scope.machineId}</p>
          <p class="destination">${record.destination}</p></div>
        ${waiting ? html`<form autocomplete="off" @submit=${this.submit}>
          <div class="field">
            <label for="private-value">Private value</label>
            <textarea id="private-value" aria-describedby="privacy-help" autocomplete="off"
              autocapitalize="off" autocorrect="off" spellcheck="false" required ?disabled=${!this.ready || this.busy}></textarea>
            <p id="privacy-help" class="help">Saved exactly as entered, up to 64 KiB. No chat message or saved browser draft. Visible while you type.</p>
            <label class="confirmation"><input type="checkbox" .checked=${this.confirmed}
              ?disabled=${!this.ready || this.busy} @change=${(event: Event) => {
                if (event.target instanceof HTMLInputElement) this.confirmed = event.target.checked;
              }}>I confirm this destination. Create a new file; never overwrite an existing file.</label>
            <div class="actions">
              <button class="ui-button ui-button--primary" type="submit" ?disabled=${!this.ready || this.busy || !this.confirmed}>Save file</button>
              <button class="ui-button" type="button" ?disabled=${!this.ready || this.busy} @click=${this.cancel}>Cancel request</button>
            </div>
          </div>
        </form>` : html`<p role="status">${this.statusText()}</p>`}
        <div class="actions">
          <button class="ui-button ui-button--compact" ?disabled=${this.busy || !this.lifetime}
            @click=${() => { this.clearValue(); void this.perform("status"); }}>Refresh status</button>
          ${!waiting && !this.delivered ? html`<button class="ui-button ui-button--compact"
            ?disabled=${!this.ready || this.busy || this.active}
            @click=${() => { void this.perform("notify"); }}>${record.status === "writing" ? "Recover outcome" : "Notify agent"}</button>` : nothing}
        </div>
        ${this.delivered ? html`<p class="help" role="status">Agent notified.</p>` : nothing}
      ` : nothing}
      ${this.notice ? html`<p class="notice" role="alert">${this.notice}</p>` : nothing}
    </section>`;
  }
}

export function definePrivateInputForm(): void {
  if (!customElements.get("pi-web-private-input")) customElements.define("pi-web-private-input", PrivateInputForm);
}
