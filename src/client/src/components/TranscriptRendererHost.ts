import { LitElement, css, html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { TranscriptMessageEntry, TranscriptRendererScope, TranscriptToolEntry, TranscriptToolRenderer } from "../../../plugin-api";
import { resolveTranscriptToolRenderer, type RegisteredTranscriptRenderer } from "../plugins/transcriptRenderers";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { localization, LocalizationController } from "../localization/browser";
import definitions from "./transcriptRenderer.messages";

const messages = localization.registerMessages("core.transcript-renderer", definitions);

type MessageRenderer = Extract<RegisteredTranscriptRenderer, { target: "custom-message" }>;
export type TranscriptRenderRequest =
  | { kind: "tool"; renderers: readonly RegisteredTranscriptRenderer[]; entry: TranscriptToolEntry }
  | { kind: "custom-message"; renderer: MessageRenderer; entry: TranscriptMessageEntry };

/** Plugin presentation is replaceable; the slotted default remains host-owned. */
@customElement("pi-web-transcript-renderer")
export class TranscriptRendererHost extends LitElement {
  constructor() {
    super();
    new LocalizationController(this);
    stylesheetIntegrationCapability.createController(this, { sharedUi: true });
  }

  @property({ attribute: false }) request: TranscriptRenderRequest | undefined;
  @property({ attribute: false }) scope: TranscriptRendererScope | undefined;
  /** Stable across streaming snapshots, different for another transcript item. */
  @property() itemKey = "";
  @property({ attribute: false }) entryId: string | undefined;
  @state() private defaultView = false;
  private controller: AbortController | undefined;
  private preview: TemplateResult | undefined;
  private attempted = false;
  private hasCustomView = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    this.cancel();
    super.disconnectedCallback();
  }

  protected override willUpdate(changes: PropertyValues<this>): void {
    if (changes.has("itemKey")) this.defaultView = false;
    const previous = changes.get("request");
    const selectionChanged = rendererSelection(previous) !== rendererSelection(this.request);
    const requestChanged = changes.has("request") && (selectionChanged
      || previous?.entry !== this.request?.entry || previous?.kind !== this.request?.kind);
    if (requestChanged || changes.has("scope") || changes.has("itemKey") || changes.has("entryId")) {
      this.cancel();
      if (selectionChanged || changes.has("itemKey")) this.defaultView = false;
      if (!this.defaultView) this.hasCustomView = false;
    }
  }

  private cancel(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.preview = undefined;
    this.attempted = false;
  }

  private renderPreview(): void {
    const request = this.request;
    if (!this.isConnected || this.defaultView || this.attempted || request === undefined || this.scope === undefined) return;
    this.attempted = true;
    const controller = new AbortController();
    this.controller = controller;
    const fail = (error: unknown): void => {
      if (controller.signal.aborted || this.controller !== controller) return;
      console.warn(`Transcript renderer for ${request.kind === "tool" ? request.entry.toolName : request.entry.customType} failed`, error);
      controller.abort();
      this.preview = undefined;
      this.hasCustomView = false;
      this.requestUpdate();
    };
    try {
      const input = { scope: Object.freeze({ ...this.scope }), signal: controller.signal, fail };
      let preview: unknown;
      if (request.kind === "tool") {
        const { toolCallId, toolName, args, status, content, details, resultText } = request.entry;
        const coreDefault: TranscriptToolRenderer = Object.freeze({ render: () => html`<slot></slot>` });
        const renderer = resolveTranscriptToolRenderer(toolName, request.renderers, () => coreDefault);
        // Unchanged delegation is still the ordinary view, not a custom presentation.
        preview = renderer === coreDefault ? undefined : renderer?.render({ ...input, entry: Object.freeze({ toolName, args, status, content, details,
          ...(toolCallId === undefined ? {} : { toolCallId }), ...(resultText === undefined ? {} : { resultText }) }) });
      } else {
        const { customType, content, details } = request.entry;
        preview = request.renderer.render({ ...input, entry: Object.freeze({ customType, content, details, ...(this.entryId === undefined ? {} : { entryId: this.entryId }) }) });
      }
      // Consume contract-violating async returns so a rejection cannot escape fallback.
      if (isPromiseLike(preview)) void Promise.resolve(preview).catch(fail);
      if (preview !== undefined && !isTemplateResult(preview)) throw new Error("Transcript renderer must return a Lit template or undefined synchronously");
      if (!controller.signal.aborted) {
        this.preview = preview;
        this.hasCustomView = preview !== undefined;
        if (preview === undefined) controller.abort();
      }
    } catch (error) {
      fail(error);
    }
  }

  private toggleView(): void {
    this.defaultView = !this.defaultView;
    this.cancel();
  }

  override render() {
    this.renderPreview();
    return html`
      ${this.hasCustomView ? html`<div class="controls"><button type="button" class="ui-button ui-button--compact" @click=${() => { this.toggleView(); }}>${messages.t(this.defaultView ? "customView" : "defaultView")}</button></div>` : null}
      ${this.defaultView || this.preview === undefined ? html`<slot></slot>` : this.preview}
    `;
  }

  protected override updated(): void {
    this.dispatchEvent(new CustomEvent("content-layout-changed", { bubbles: true, composed: true }));
  }

  static override styles = css`
    @layer pi-web-base {
      :host { display: block; min-width: 0; max-width: 100%; color: var(--pi-text); }
      .controls { display: flex; justify-content: flex-end; margin-block-end: 4px; }
    }
  `;
}

function rendererSelection(request: TranscriptRenderRequest | undefined): unknown {
  return request?.kind === "tool" ? request.renderers : request?.renderer;
}

function isTemplateResult(value: unknown): value is TemplateResult {
  return value !== null && typeof value === "object" && "_$litType$" in value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === "object" && "then" in value && typeof value.then === "function";
}
