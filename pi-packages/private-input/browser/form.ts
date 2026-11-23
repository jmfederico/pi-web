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
  @state() private needsStatus = false;
  @state() private delivered = false;
  @state() private active = false;
  @state() private notice = "";
  @state() private multiline = false;
  @state() private revealed = false;
  @state() private canMaskMultiline = false;
  @state() private formatNotice = "";
  private lifetime: AbortController | undefined;
  private releaseStyles: (() => void) | undefined;
  private releaseSignal: (() => void) | undefined;

  static override styles = css`
    :host { display: block; min-width: 0; color: var(--pi-text); font: inherit; }
    section { padding: 12px; display: grid; gap: 12px; }
    h3, p { margin: 0; font: inherit; }
    h3 { font-weight: 600; overflow-wrap: anywhere; }
    .destination { overflow-wrap: anywhere; white-space: pre-wrap; font-family: var(--pi-mono, monospace); }
    .field { display: grid; gap: 6px; }
    /* Avoid iOS focus zoom without restricting user zoom or larger theme fonts. */
    .secret { box-sizing: border-box; width: 100%; padding: 8px; font: inherit;
      font-size: max(16px, 1em); color: var(--pi-text); background: var(--pi-bg);
      border: 1px solid var(--pi-border); border-radius: 4px; }
    textarea.secret { min-height: 100px; resize: vertical; -webkit-text-security: disc; }
    .secret:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .secret[hidden] { display: none; }
    .secret-entry { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 8px; }
    .reveal { grid-column: 2; }
    .concealed .reveal { grid-column: 1; justify-self: start; }
    .format-toggle { justify-self: start; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .help { color: var(--pi-muted); }
    .notice { color: var(--pi-warning, var(--pi-text)); }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("pagehide", this.clearValue);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.canMaskMultiline = typeof CSS !== "undefined" && CSS.supports("-webkit-text-security", "disc");
    // Reconnection can retain the same context property, but never its old request lifetime.
    this.requestUpdate("context");
  }

  override disconnectedCallback(): void {
    this.disposeContext();
    this.releaseStyles?.();
    this.releaseStyles = undefined;
    window.removeEventListener("pagehide", this.clearValue);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("stylesIntegration")) { this.releaseStyles?.(); this.releaseStyles = undefined; }
    if (this.renderRoot instanceof ShadowRoot) {
      this.releaseStyles ??= this.stylesIntegration?.registerRoot(this.renderRoot, { sharedUi: true });
    }
    if (changed.has("context")) this.resetContext();
  }

  private field(): HTMLInputElement | HTMLTextAreaElement | null {
    return this.renderRoot.querySelector<HTMLInputElement | HTMLTextAreaElement>(this.multiline ? "textarea" : "#secret-single-line");
  }

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.hideValue();
  };

  private hideValue(): void {
    this.revealed = false;
    // Conceal synchronously too: privacy cleanup must not wait for a Lit update.
    const password = this.renderRoot.querySelector<HTMLInputElement>("#secret-single-line");
    if (password) password.type = "password";
    const textarea = this.renderRoot.querySelector("textarea");
    if (textarea) {
      textarea.style.setProperty("-webkit-text-security", "disc");
      textarea.hidden = !this.multiline || !this.canMaskMultiline;
    }
  }

  private readonly changeFormat = (): void => {
    if (!this.ready || this.busy) return;
    const nextMultiline = !this.multiline;
    const source = this.field();
    // Password fields natively strip CR/LF. Do not silently reformat an existing
    // multiline value; ordinary typing/paste into password mode stays native.
    if (!nextMultiline && source && /[\r\n]/u.test(source.value)) {
      this.formatNotice = "This secret contains line breaks. Remove them before switching to a single line.";
      return;
    }
    const target = this.renderRoot.querySelector<HTMLInputElement | HTMLTextAreaElement>(nextMultiline ? "textarea" : "#secret-single-line");
    if (!source || !target || source === target) return;
    this.hideValue();
    target.value = source.value;
    source.value = "";
    source.hidden = true;
    this.multiline = nextMultiline;
    this.formatNotice = "";
  };

  private readonly clearValue = (): void => {
    for (const field of this.renderRoot.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".secret")) field.value = "";
    this.hideValue();
    this.formatNotice = "";
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
    this.multiline = false;
    this.busy = false;
    this.delivered = false;
    this.active = false;
    this.needsStatus = false;
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
      this.needsStatus = data["unavailable"] === true || current.status === "writing";
      if (current.status !== "waiting") this.clearValue();
      if (data["unavailable"] === true) {
        this.notice = "The agent is busy or this request is no longer active. Check status when the conversation is idle.";
      } else if (data["delivered"] === false && isFinished(current)) {
        this.notice = "Agent notification wasn’t confirmed. Choose Notify agent to retry when the conversation is idle.";
      }
    } catch {
      if (this.isCurrent(lifetime)) {
        // Transport errors may contain submitted input. Never render, log, or forward them to fail().
        if (operation !== "status") this.clearValue();
        this.needsStatus = true;
        this.notice = "Couldn’t confirm the result. Check status before trying again. Your secret won’t be resent.";
      }
    } finally {
      if (this.lifetime === lifetime) this.busy = false;
    }
  }

  private readonly submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!this.ready || this.busy || this.record?.status !== "waiting") return;
    const field = this.field();
    if (!field || field.value.length === 0) return;
    if (new TextEncoder().encode(field.value).byteLength > MAX_SECRET_BYTES) {
      this.notice = "This secret is too large. Enter no more than 64 KiB of UTF-8 text.";
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
      case "saved": return "File saved.";
      case "cancelled": return "Request cancelled. No file was written.";
      case "writing": return this.active ? "Saving the file. Check status to see if it’s finished."
        : "Saving was interrupted. Choose Report interruption to inform the agent without sending your secret again.";
      case "waiting":
      case undefined: return "";
      case "failed":
        return {
          exists: "The destination already exists. It was not overwritten.",
          destination_changed: "The destination changed after confirmation. No file was written.",
          write_uncertain: "Saving couldn’t be confirmed. The file may exist. Don’t submit the secret again.",
          write_failed: "The file could not be written. Ask the agent for a new request if needed.",
        }[this.record.failure ?? "write_failed"];
    }
  }

  override render() {
    const record = this.record;
    const waiting = record?.status === "waiting";
    const multilineVisible = this.multiline && (this.canMaskMultiline || this.revealed);
    const needsVisibilityWarning = this.multiline && !this.canMaskMultiline;
    const canNotify = record !== undefined && !waiting && !this.delivered;
    return html`<section aria-label="Save a secret" aria-busy=${this.busy}>
      ${record ? html`
        <h3>${record.purpose}</h3>
        <p><span class="help">Save to: </span><span class="destination">${record.destination}</span>
          <span class="help"> (${this.context?.scope.machineId})</span></p>
        ${waiting ? html`<form autocomplete="off" @submit=${this.submit}>
          <div class="field">
            ${this.multiline ? html`<label for="secret-multiline">Secret</label>` : html`<label for="secret-single-line">Secret</label>`}
            ${needsVisibilityWarning ? html`<p id="visibility-help" class="notice">Multiline text is visible while editing in this browser. Choose Show to continue.</p>` : nothing}
            <div class=${this.multiline && !multilineVisible ? "secret-entry concealed" : "secret-entry"}>
              <input id="secret-single-line" class="secret" .type=${this.revealed ? "text" : "password"}
                ?hidden=${this.multiline} ?disabled=${this.multiline || !this.ready || this.busy} required
                autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
              <textarea id="secret-multiline" class="secret" ?hidden=${!multilineVisible}
                style=${this.revealed ? "-webkit-text-security: none" : "-webkit-text-security: disc"}
                ?disabled=${!multilineVisible || !this.ready || this.busy} required
                aria-describedby=${needsVisibilityWarning ? "visibility-help" : nothing}
                autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
              <button class="reveal ui-button ui-button--compact" type="button"
                aria-label=${this.revealed ? "Hide secret" : "Show secret"}
                aria-describedby=${needsVisibilityWarning ? "visibility-help" : nothing}
                ?disabled=${!this.ready || this.busy} @click=${() => {
                  if (this.revealed) this.hideValue(); else this.revealed = true;
                }}>${this.revealed ? "Hide" : "Show"}</button>
            </div>
            <button class="format-toggle ui-button ui-button--compact" type="button"
              ?disabled=${!this.ready || this.busy} @click=${this.changeFormat}>${this.multiline ? "Use single line" : "Use multiline"}</button>
            ${this.formatNotice ? html`<p class="notice" role="alert">${this.formatNotice}</p>` : nothing}
            <div class="actions">
              <button class="ui-button ui-button--primary" type="submit" ?disabled=${!this.ready || this.busy}>Save file</button>
              <button class="ui-button" type="button" ?disabled=${!this.ready || this.busy} @click=${this.cancel}>Cancel</button>
            </div>
          </div>
        </form>` : html`<p role="status">${this.statusText()}</p>`}
        ${this.needsStatus || canNotify ? html`<div class="actions">
          ${this.needsStatus ? html`<button class="ui-button ui-button--compact" ?disabled=${this.busy || !this.lifetime}
            @click=${() => { this.hideValue(); void this.perform("status"); }}>Check status</button>` : nothing}
          ${canNotify ? html`<button class="ui-button ui-button--compact"
            ?disabled=${!this.ready || this.busy || this.active}
            @click=${() => { void this.perform("notify"); }}>${record.status === "writing" ? "Report interruption" : "Notify agent"}</button>` : nothing}
        </div>` : nothing}
      ` : nothing}
      ${this.notice ? html`<p class="notice" role="alert">${this.notice}</p>` : nothing}
    </section>`;
  }
}

export function definePrivateInputForm(): void {
  if (!customElements.get("pi-web-private-input")) customElements.define("pi-web-private-input", PrivateInputForm);
}
