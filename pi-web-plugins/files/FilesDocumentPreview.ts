import type { MarkdownRenderingCapability, FilePreviewerInput, StylesheetIntegrationCapabilityV1 } from "@jmfederico/pi-web/plugin-api";
import { css, html, LitElement, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { keyed } from "lit/directives/keyed.js";
import { FilesLocalizationController, formatFileSize, type FilesContent } from "./filesLocalization";

const DEFAULT_MAX_INLINE_PREVIEW_BYTES = 1024 * 1024;

export class FilesDocumentPreview extends LitElement {
  private readonly text = new FilesLocalizationController(this);
  @property({ attribute: false }) input: FilePreviewerInput | undefined;
  @property({ attribute: false }) markdownRendering: MarkdownRenderingCapability | undefined;
  @property({ attribute: false })
  get content(): FilesContent | undefined { return this.text.content; }
  set content(value: FilesContent | undefined) { this.text.content = value; }

  private integration: StylesheetIntegrationCapabilityV1 | undefined;
  private releaseStyles: (() => void) | undefined;
  @property({ attribute: false })
  get stylesheetIntegration(): StylesheetIntegrationCapabilityV1 | undefined { return this.integration; }
  set stylesheetIntegration(value: StylesheetIntegrationCapabilityV1 | undefined) {
    if (value === this.integration) return;
    this.releaseStyles?.();
    this.releaseStyles = undefined;
    this.integration = value;
    this.registerStyles();
  }

  private identity = "";
  private generation = 0;
  private failed = false;
  private signal: AbortSignal | undefined;
  private readonly abort = (): void => {
    this.generation += 1;
    this.releaseStyles?.();
    this.releaseStyles = undefined;
    this.requestUpdate();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.bindSignal();
    this.registerStyles();
  }

  override disconnectedCallback(): void {
    this.signal?.removeEventListener("abort", this.abort);
    this.signal = undefined;
    this.generation += 1;
    this.releaseStyles?.();
    this.releaseStyles = undefined;
    super.disconnectedCallback();
  }

  protected override willUpdate(): void {
    const input = this.input;
    const identity = JSON.stringify([input?.machineId, input?.projectId, input?.workspaceId, input?.file.path, input?.file.modifiedAt, input?.file.mediaType]);
    if (identity !== this.identity || input?.signal !== this.signal) {
      this.identity = identity;
      this.failed = false;
      this.generation += 1;
    }
    this.bindSignal();
    this.registerStyles();
  }

  private bindSignal(): void {
    if (this.signal === this.input?.signal) return;
    this.signal?.removeEventListener("abort", this.abort);
    this.signal = this.input?.signal;
    this.signal?.addEventListener("abort", this.abort, { once: true });
  }

  private registerStyles(): void {
    if (this.isConnected && this.input?.signal.aborted !== true && this.renderRoot instanceof ShadowRoot) {
      this.releaseStyles ??= this.integration?.registerRoot(this.renderRoot, { sharedUi: true });
    }
  }

  override render(): TemplateResult {
    const input = this.input;
    if (!this.isConnected || input === undefined || input.signal.aborted || this.content === undefined) return html``;
    try {
      return html`${keyed(this.generation, this.renderDocument(input))}`;
    } catch (error) {
      // URL/capability failures cannot offer a working internal recovery state.
      input.fail(error);
      return html``;
    }
  }

  private renderDocument(input: FilePreviewerInput): TemplateResult {
    const { file, files } = input;
    const limit = files.capabilityVersion === 1 ? files.maxInlinePreviewBytes : DEFAULT_MAX_INLINE_PREVIEW_BYTES;
    if (file.size === 0) return this.status(this.text.messages.t("empty"));
    if (file.size > limit) return this.status(this.text.messages.t("tooLarge", { size: formatFileSize(file.size, this.requireContent()), limit: formatFileSize(limit, this.requireContent()) }));
    if (this.failed) return this.renderPreviewFailure(input);
    if (file.mediaType === "markdown") return this.renderMarkdown(input);
    if (files.capabilityVersion !== 1) throw new Error("Document previews require workspace file URLs");
    const src = files.previewUrl(file.path, { version: file.modifiedAt });
    const generation = this.generation;
    const onError = (): void => {
      if (!this.isConnected || input.signal.aborted || generation !== this.generation) return;
      this.failed = true;
      this.requestUpdate();
    };
    if (file.mediaType === "image") return html`
      <div class="image-preview"><img src=${src} alt=${this.text.messages.t("previewOf", { path: file.path })} decoding="async" referrerpolicy="no-referrer" @error=${onError} /></div>`;
    if (file.mediaType !== "html" && file.mediaType !== "pdf") throw new Error("Unsupported document preview");
    // Native PDF handlers refuse sandboxed frames. HTML remains opaque and inert;
    // PDF isolation instead relies on the host's PDF MIME, nosniff and CSP response.
    return html`
      ${file.mediaType === "pdf" ? html`<p class="preview-note" role="status">${this.text.messages.t("pdfHelp")}</p>` : null}
      <iframe class="file-frame-preview" src=${src} sandbox=${ifDefined(file.mediaType === "html" ? "" : undefined)} allow="" referrerpolicy="no-referrer" title=${this.text.messages.t("previewOf", { path: file.path })} @error=${onError}></iframe>`;
  }

  private renderPreviewFailure(input: FilePreviewerInput): TemplateResult {
    const { file, files } = input;
    if (files.capabilityVersion !== 1) throw new Error("Document preview recovery requires workspace file URLs");
    const src = file.mediaType === "markdown" ? undefined : files.previewUrl(file.path, { version: file.modifiedAt });
    const generation = this.generation;
    return html`
      <div class="preview-state" role="alert">
        <strong>${this.text.messages.t("previewFailed", { path: file.path })}</strong>
        <span>${this.text.messages.t("previewFailedHelp")}</span>
        <button class="ui-button" type="button" @click=${() => {
          if (input.signal.aborted || generation !== this.generation) return;
          this.failed = false;
          this.generation += 1;
          this.requestUpdate();
        }}>${this.text.messages.t("retry")}</button>
        ${src === undefined ? null : html`<a class="ui-button" href=${src} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${this.text.messages.t("open")}</a>`}
        <a class="ui-button" href=${files.downloadUrl(file.path, { version: file.modifiedAt })} download=${file.path.split(/[\\/]/u).at(-1) ?? file.path}>${this.text.messages.t("download")}</a>
      </div>`;
  }

  private renderMarkdown(input: FilePreviewerInput): TemplateResult {
    const { file } = input;
    try {
      const rendered = this.markdownRendering?.render({
        machineId: input.machineId, text: file.content, truncated: file.truncated,
        allowManualPreview: true,
        labels: {
          imageOmitted: (alt) => this.text.messages.t("imageOmitted", { alt, hasAlt: alt === "" ? "no" : "yes" }),
          table: this.text.messages.t("table"),
        },
      }) ?? html`<pre>${file.content}</pre>`;
      return html`
        ${file.truncated ? html`<p class="preview-note" role="status">${this.text.messages.t("previewTruncated")}</p>` : null}
        <div class="formatted markdown-preview" dir="auto">${rendered}</div>`;
    } catch (error) {
      console.warn("Markdown preview failed", file.path, error);
      if (input.files.capabilityVersion === 1) {
        this.failed = true;
        return this.renderPreviewFailure(input);
      }
      input.fail(error);
      return this.status(this.text.messages.t("markdownFailed"), true);
    }
  }

  private status(message: string, alert = false): TemplateResult {
    return html`<p class="viewer-status" role=${alert ? "alert" : "status"}>${message}</p>`;
  }

  private requireContent(): FilesContent {
    if (this.content === undefined) throw new Error("Files localization is unavailable");
    return this.content;
  }

  static override styles = [formattedTextStyles(), css`
      :host { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: auto; color: var(--pi-text); font: 14px var(--pi-font, system-ui, sans-serif); }
      .markdown-preview { flex: 1 1 auto; min-height: 0; box-sizing: border-box; overflow: auto; padding: 16px; }
      .preview-note { flex: 0 0 auto; margin: 0; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-surface); color: var(--pi-muted); padding: 7px 10px; font-size: 12px; }
      .image-preview { flex: 1 1 auto; min-height: 0; box-sizing: border-box; display: flex; align-items: center; justify-content: center; overflow: auto; padding: 16px; }
      .image-preview img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; border: 1px solid var(--pi-border-muted); border-radius: 8px; background-color: var(--pi-surface); background-image: linear-gradient(45deg, color-mix(in srgb, var(--pi-border-muted) 45%, transparent) 25%, transparent 25%), linear-gradient(-45deg, color-mix(in srgb, var(--pi-border-muted) 45%, transparent) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--pi-border-muted) 45%, transparent) 75%), linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--pi-border-muted) 45%, transparent) 75%); background-position: 0 0, 0 8px, 8px -8px, -8px 0; background-size: 16px 16px; box-shadow: 0 8px 24px var(--pi-shadow-soft); }
      .file-frame-preview { flex: 1 1 auto; min-height: 0; width: 100%; border: none; background: var(--pi-surface); }
      .viewer-status { box-sizing: border-box; margin: auto; max-width: 100%; color: var(--pi-muted); padding: 18px; text-align: center; overflow-wrap: anywhere; }
      .preview-state { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; box-sizing: border-box; padding: 24px; color: var(--pi-muted); text-align: center; }
      .preview-state strong { color: var(--pi-text); }
      .preview-state p { margin: 0; }
  `];
}

function formattedTextStyles(): ReturnType<typeof css> {
  return css`
  .formatted { white-space: normal; overflow-wrap: anywhere; line-height: 1.45; text-align: start; unicode-bidi: plaintext; }
  p, ul, ol, pre, blockquote, .table-scroll { margin: 0 0 10px; }
  :is(p, ul, ol, pre, blockquote, .table-scroll):last-child { margin-bottom: 0; }
  ul, ol { padding-inline-start: 22px; }
  li + li { margin-top: 3px; }
  code { border: 1px solid var(--pi-border); border-radius: 4px; background: var(--pi-bg); padding: 1px 4px; font: 13px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); direction: ltr; text-align: left; unicode-bidi: isolate; }
  pre { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); padding: 10px; overflow-x: auto; overflow-y: hidden; direction: ltr; text-align: left; unicode-bidi: isolate; }
  pre code { border: 0; padding: 0; background: transparent; }
  blockquote { border-inline-start: 3px solid var(--pi-border); padding-inline-start: 10px; color: var(--pi-muted); }
  a { color: var(--pi-accent); }
  h1, h2, h3, h4 { margin: 14px 0 8px; line-height: 1.2; }
  h1:first-child, h2:first-child, h3:first-child, h4:first-child { margin-top: 0; }
  h1 { font-size: 20px; }
  h2 { font-size: 17px; }
  h3 { font-size: 15px; }
  h4 { font-size: 14px; }
  .table-scroll { max-width: 100%; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; }
  .table-scroll:focus-visible { outline: 1px solid var(--pi-accent); outline-offset: 2px; }
  table { border-collapse: collapse; width: max-content; min-width: 100%; max-width: none; }
  th, td { border: 1px solid var(--pi-border); padding: 4px 8px; max-width: 48ch; overflow-wrap: anywhere; }
  th { background: var(--pi-surface); }
  `;
}
