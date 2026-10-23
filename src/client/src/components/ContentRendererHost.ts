import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { ContentRendererContribution } from "../../../plugin-api";
import { defaultContentRendererChoice, type ContentRendererChoice } from "../plugins/contentRenderers";
import { renderIntentMemory } from "../formatting/renderIntentMemory";
import { writeClipboardText } from "../clipboard";
import type { CodeBlockSourcePolicy } from "../formatting/codeBlockPolicy";
import { codeBlockFrameStyles } from "./codeBlockFrameStyles";
import { VisibleContentController } from "../formatting/deferredContent";

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === "object" && "then" in value && typeof value.then === "function";
}

function isTemplateResult(value: unknown): value is TemplateResult {
  return value !== null && typeof value === "object" && "_$litType$" in value;
}

/** Owns source access independently of the plugin's rendering success. */
@customElement("pi-web-content-renderer")
export class ContentRendererHost extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  // Chat-private source controls; public plugin consumers retain legacy defaults.
  @property({ attribute: false }) codeBlocks: CodeBlockSourcePolicy | undefined;
  @property({ type: Boolean, reflect: true, attribute: "external-controls" }) externalControls = false;
  @property() text = "";
  @property() machineId: string | undefined;
  @property() language: string | undefined;
  @property() filePath: string | undefined;
  private explicitChoice = false;
  private activateSelected = false;
  @property() intentKey: string | undefined;
  private restoreIntent = true;
  @property({ attribute: false }) choices: readonly ContentRendererChoice[] = [];
  // Host-private dependency token: grammar eligibility can change without a new renderer.
  @property({ attribute: false }) renderingRevision: unknown;
  @property() rendererId: string | undefined;
  @property({ type: Boolean }) allowManualPreview = false;
  @state() private manuallyActivated = false;
  @state() private selectedId: string | undefined;
  private renderer: ContentRendererContribution | undefined;
  @state() private raw = false;
  @state() private failure: string | undefined;
  @state() private copyStatus = "Copy source";
  private controller: AbortController | undefined;
  private preview: TemplateResult | undefined;
  private previewScheduled = false;
  private displayedPreview: TemplateResult | undefined;
  private readonly enhancement = new VisibleContentController(this, (visible) => {
    if (!visible) this.cancelPreview();
    this.requestUpdate();
  });

  protected override willUpdate(changes: PropertyValues<this>): void {
    const identityChanged = this.restoreIntent || changes.has("intentKey") || changes.has("text");
    if (identityChanged) {
      this.activateSelected = false;
      const intent = this.intentKey === undefined ? undefined : renderIntentMemory.read(this.intentKey, this.text, this.choices.map(({ id }) => id));
      this.selectedId = intent?.rendererId;
      this.explicitChoice = intent !== undefined;
      this.raw = intent?.raw ?? false;
      this.manuallyActivated = intent !== undefined && !intent.raw;
      this.restoreIntent = false;
      this.renderer = undefined;
      this.cancelPreview();
    }
    const requestedId = (this.externalControls ? this.rendererId : undefined) ?? (this.explicitChoice ? this.selectedId : undefined);
    const choice = this.choices.find(({ id }) => id === requestedId) ?? defaultContentRendererChoice(this.choices);
    this.selectedId = choice?.id;
    if (changes.has("text") || changes.has("machineId") || changes.has("language") || changes.has("filePath") || this.renderer !== choice?.renderer) {
      if (!identityChanged) this.manuallyActivated = false;
      this.renderer = choice?.renderer;
      this.cancelPreview();
      this.failure = undefined;
      this.copyStatus = "Copy source";
    }
    if (changes.has("renderingRevision")) {
      // Refresh output/failures without discarding explicit activation or Raw intent.
      this.cancelPreview();
      this.failure = undefined;
    }
    if (this.activateSelected) {
      this.manuallyActivated = true;
      this.activateSelected = false;
    }
    if (this.externalControls) this.manuallyActivated = this.allowManualPreview;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.restoreIntent = true;
    this.manuallyActivated = false;
    this.cancelPreview();
  }

  override connectedCallback(): void {
    this.restoreIntent = true;
    super.connectedCallback();
    this.requestUpdate();
  }

  private cancelPreview(): void {
    this.enhancement.cancel();
    this.previewScheduled = false;
    this.controller?.abort();
    this.controller = undefined;
    this.preview = undefined;
  }

  private remember(raw: boolean): void {
    if (this.intentKey !== undefined && this.selectedId !== undefined) {
      renderIntentMemory.choose(this.intentKey, this.text, { rendererId: this.selectedId, raw });
    }
  }

  private selectRenderer(id: string): void {
    this.selectedId = id;
    this.explicitChoice = true;
    // A named view click explicitly authorizes manual rendering, including from Raw.
    this.activateSelected = true;
    this.raw = false;
    this.failure = undefined;
    this.cancelPreview();
    this.remember(false);
    this.requestUpdate();
  }

  private setRaw(raw: boolean): void {
    this.remember(raw);
    if (this.raw === raw && (raw || (this.manuallyActivated && this.failure === undefined))) return;
    this.raw = raw;
    this.manuallyActivated = !raw;
    if (!raw) this.failure = undefined;
    this.cancelPreview();
  }

  private renderPreview(): TemplateResult | undefined {
    if (this.preview !== undefined || this.renderer === undefined || this.failure !== undefined) return this.preview;
    const controller = new AbortController();
    this.controller = controller;
    const fail = (error: unknown): void => {
      if (controller.signal.aborted || this.controller !== controller) return;
      console.warn(`Content renderer ${this.renderer?.id ?? "unknown"} failed`, error);
      this.failure = "Preview failed. Raw source is shown below.";
      this.cancelPreview();
    };
    try {
      const preview: unknown = this.renderer.render({ text: this.text, signal: controller.signal, fail,
        ...(this.machineId === undefined ? {} : { machineId: this.machineId }),
        ...(this.language === undefined ? {} : { language: this.language }),
        ...(this.filePath === undefined ? {} : { filePath: this.filePath }),
      });
      // Plugin JS may violate the synchronous public contract. Consume a
      // rejected promise as well, so fallback never leaves an unhandled error.
      if (isPromiseLike(preview)) void Promise.resolve(preview).catch(fail);
      if (!isTemplateResult(preview)) throw new Error("Content renderer must return a Lit template synchronously");
      if (!controller.signal.aborted) this.preview = preview;
    } catch (error) {
      fail(error);
    }
    return this.preview;
  }

  private async copy(): Promise<void> {
    const text = this.text;
    const copied = await writeClipboardText(text);
    if (this.isConnected && text === this.text) this.copyStatus = copied ? "Copied source" : "Failed to copy source";
  }

  private get previewActive(): boolean {
    return this.enhancement.visible && !this.raw
      && (this.renderer?.renderMode === "automatic" || this.allowManualPreview || this.manuallyActivated);
  }

  protected override updated(): void {
    const displayedPreview = this.previewActive ? this.preview : undefined;
    if (displayedPreview !== this.displayedPreview) {
      this.displayedPreview = displayedPreview;
      this.dispatchEvent(new CustomEvent("content-layout-changed", { bubbles: true, composed: true }));
    }
    if (!this.previewActive) {
      this.cancelPreview();
      return;
    }
    if (this.preview !== undefined || this.failure !== undefined || this.renderer === undefined || this.previewScheduled) return;
    this.previewScheduled = true;
    this.enhancement.request(() => {
      this.previewScheduled = false;
      if (!this.previewActive) return;
      this.renderPreview();
      this.requestUpdate();
    });
  }

  override render() {
    const preview = this.previewActive ? this.preview : undefined;
    const diagnostic = this.failure;
    const showingRaw = preview === undefined || diagnostic !== undefined;
    const sourceClass = this.codeBlocks?.overflow === "wrap" ? "source-wrap" : "source-scroll";
    return html`<div class=${this.externalControls ? "" : "code-block-frame"}>
      ${this.externalControls ? null : html`<div class="controls code-block-header" role="group" aria-label="Code block controls">
        <div class="views">
          ${repeat(this.choices, ({ id }) => id, ({ id, label, renderer }) => html`
            <button type="button" class="ui-button ui-button--compact" aria-controls="content" aria-pressed=${id === this.selectedId && !showingRaw} @click=${() => { this.selectRenderer(id); }}>${renderer.title ?? label}</button>
          `)}
          ${this.renderer === undefined ? null : html`
            <button type="button" class="ui-button ui-button--compact" aria-controls="content" aria-pressed=${showingRaw} @click=${() => { this.setRaw(true); }}>Raw</button>
          `}
        </div>
        ${this.codeBlocks?.copy === false ? null : html`
          <button class="copy code-block-copy ui-button ui-button--icon ui-button--compact" type="button" title=${this.copyStatus} aria-label=${this.copyStatus} @click=${() => { void this.copy(); }}><span aria-hidden="true">${this.copyStatus === "Copied source" ? "✓" : "⧉"}</span></button>
          <span class="sr-only" role="status">${this.copyStatus === "Copy source" ? "" : this.copyStatus}</span>
        `}
      </div>`}
      <div id="content">
        ${diagnostic === undefined ? null : html`<p role="status">${diagnostic}</p>`}
        ${showingRaw
          ? this.codeBlocks?.presentation === "plain"
            ? html`<div class=${`plain-code-block ${sourceClass}`} tabindex="0" aria-label="Raw source">${this.text}</div>`
            : html`<pre class=${sourceClass} tabindex="0" aria-label="Raw source"><code>${this.text}</code></pre>`
          : html`<div class="preview" tabindex="0" aria-label="Rendered content">${preview}</div>`}
      </div>
    </div>`;
  }

  static override styles = [codeBlockFrameStyles, css`
    /* Keep natural height so the surrounding flex viewer owns the scroll range. */
    :host { display: block; flex-shrink: 0; margin: 0 0 10px; min-width: 0; color: var(--pi-text); }
    :host([external-controls]) { margin: 0; background: var(--pi-bg); }
    #content { border-radius: 0 0 7px 7px; }
    .code-block-header { flex-wrap: nowrap; padding-inline-start: 0; }
    .views { display: flex; flex: 1 1 0; min-width: 0; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: thin; }
    .views > button { flex: 0 0 auto; white-space: nowrap; }
    .ui-button[aria-pressed="true"] { color: var(--pi-text); background: var(--pi-surface-hover); }
    :is(button, pre, .plain-code-block, .preview):focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    pre { overflow: auto; white-space: pre; text-align: left; direction: ltr; padding: 12px; margin: 0; }
    /* Raw-source policy must not restyle elements produced by a plugin preview. */
    #content > .plain-code-block { padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
    #content > pre.source-wrap { overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere; }
    #content > .plain-code-block.source-scroll { overflow: auto; white-space: pre; overflow-wrap: normal; }
    code { font: 13px/1.5 var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
    .preview { overflow: auto; padding: 12px; }
    p { color: var(--pi-muted); margin: 0; padding: 10px 12px; font: 12px/1.5 var(--pi-font, system-ui, sans-serif); }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `];
}
