import { css, html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { FileContentResponse } from "../api";
import { workspaceFilePreviewUrl } from "../api/urls";
import { renderWorkspaceMarkdownHtml } from "../formatting/workspaceMarkdown";
import { MAX_INLINE_PREVIEW_BYTES, MAX_INLINE_PREVIEW_LABEL, workspaceFileName } from "../../../shared/workspaceFiles";
import { formatFileSize } from "../utils/format";
import { workspaceFileViewModeStore, type WorkspaceFileViewMode, type WorkspaceFileViewModeStore } from "../workspaceFileViewMode";
import { formattedTextStyles } from "./shared";

export type WorkspaceFilePreviewKind = "image" | "html" | "pdf" | "markdown" | "download" | "code";

export interface WorkspaceFileViewerIdentity {
  machineId: string;
  projectId: string;
  workspaceId: string;
  selectedPath: string | undefined;
  file: FileContentResponse | undefined;
}

@customElement("workspace-file-viewer")
export class WorkspaceFileViewer extends LitElement {
  @property({ attribute: false }) machineId = "";
  @property({ attribute: false }) projectId = "";
  @property({ attribute: false }) workspaceId = "";
  @property({ attribute: false }) selectedPath: string | undefined;
  @property({ attribute: false }) file: FileContentResponse | undefined;
  @property({ attribute: false }) loadError: string | undefined;
  @property({ attribute: false }) previewUrlBuilder: typeof workspaceFilePreviewUrl = workspaceFilePreviewUrl;
  @property({ attribute: false }) modeStore: WorkspaceFileViewModeStore = workspaceFileViewModeStore;

  /** Undefined until the first render adopts the deep-linked or stored mode. */
  private mode: WorkspaceFileViewMode | undefined;
  private publishedMode: WorkspaceFileViewMode | undefined;
  private activeFileKey: string | undefined;
  /**
   * Increments on every selected-file identity change. Rendered handlers carry
   * the token of the selection they belong to, so a delayed event from detached
   * markup can never affect a later selection — including when the user returns
   * to a file whose identity key is identical (A → B → A).
   */
  private selectionToken = 0;
  private failedPreviewToken: number | undefined;
  private readonly restoreModeFromHistory = (): void => {
    this.mode = this.modeStore.adopt();
    // The restored entry owns the address-bar value. Forget the prior entry's
    // publication so this render can canonicalize a missing/invalid mode too.
    this.publishedMode = undefined;
    this.failedPreviewToken = undefined;
    this.requestUpdate();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("popstate", this.restoreModeFromHistory);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("popstate", this.restoreModeFromHistory);
    super.disconnectedCallback();
  }

  protected override willUpdate(): void {
    this.mode ??= this.modeStore.adopt();
    const nextKey = this.currentFileKey();
    if (nextKey === this.activeFileKey) return;
    this.activeFileKey = nextKey;
    this.selectionToken += 1;
    // The mode deliberately survives a new selection; only failure state, which
    // belongs to the bytes that failed, is per selection.
    this.failedPreviewToken = undefined;
  }

  /**
   * Keep the address bar reproducible: whenever a file that actually has both
   * modes is on screen, the URL and the device preference name the mode being
   * shown, so copying the link reproduces this view for anyone who opens it.
   */
  protected override updated(): void {
    const mode = this.mode;
    if (mode === undefined || mode === this.publishedMode) return;
    if (!this.selectionHasRawAndPreviewModes()) return;
    this.publishedMode = mode;
    this.modeStore.publish(mode);
  }

  override render(): TemplateResult {
    const selectedPath = this.selectedPath;
    if (selectedPath === undefined || selectedPath === "") return this.renderStatus("Select a file.");
    if (this.loadError !== undefined) return this.renderStatus(`Unable to load ${selectedPath}: ${this.loadError}`, true);

    const file = this.file;
    if (file === undefined) return this.renderStatus(`Loading ${selectedPath}…`);
    if (file.path !== selectedPath) {
      return this.renderStatus(`Unable to preview ${selectedPath}: loaded content belongs to ${file.path}.`, true);
    }

    const token = this.selectionToken;
    const kind = workspaceFilePreviewKind(file);
    const canOpen = isBrowserPreviewKind(kind) && file.size > 0 && file.size <= MAX_INLINE_PREVIEW_BYTES;
    return html`
      ${this.renderViewerHeader(file, metadataForFile(file, kind), canOpen)}
      ${hasRawAndPreviewModes(file, kind) ? this.renderModeControls(file, token) : null}
      ${this.renderLoadedFile(file, kind, token)}
    `;
  }

  private renderLoadedFile(file: FileContentResponse, kind: WorkspaceFilePreviewKind, token: number): TemplateResult {
    if (hasRawAndPreviewModes(file, kind) && this.mode === "raw") return this.renderRawSource(file);
    if (file.size === 0) return this.renderStatus("This file is empty.");

    switch (kind) {
      case "image": return this.renderImagePreview(file, token);
      case "html": return this.renderFramePreview(file, "html", token);
      case "pdf": return this.renderFramePreview(file, "pdf", token);
      case "markdown": return this.renderMarkdownPreview(file);
      case "download": return this.renderUnsupportedFile(file);
      case "code": return this.renderRawSource(file);
    }
  }

  private renderViewerHeader(file: FileContentResponse, metadata: string, canOpen: boolean): TemplateResult {
    const name = workspaceFileName(file.path);
    const previewOptions = { modifiedAt: file.modifiedAt, machineId: this.machineId };
    const openUrl = this.previewUrlBuilder(this.projectId, this.workspaceId, file.path, previewOptions);
    const downloadUrl = this.previewUrlBuilder(this.projectId, this.workspaceId, file.path, { ...previewOptions, download: true });
    return html`
      <div class="viewer-header">
        <strong title=${file.path}>${file.path}</strong>
        <div class="viewer-actions">
          <small>${metadata}</small>
          ${canOpen ? html`
            <a
              class="viewer-action"
              href=${openUrl}
              target="_blank"
              rel="noopener noreferrer"
              referrerpolicy="no-referrer"
              title="Open in new window"
            >Open ↗</a>
          ` : null}
          <a class="viewer-action" href=${downloadUrl} download=${name} title=${`Download ${name}`}>Download</a>
        </div>
      </div>
    `;
  }

  private renderModeControls(file: FileContentResponse, token: number): TemplateResult {
    return html`
      <div class="viewer-mode" role="group" aria-label=${`View ${file.path}`}>
        <button
          type="button"
          aria-pressed=${this.mode === "preview" ? "true" : "false"}
          @click=${() => { this.setMode("preview", token); }}
        >Preview</button>
        <button
          type="button"
          aria-pressed=${this.mode === "raw" ? "true" : "false"}
          @click=${() => { this.setMode("raw", token); }}
        >Raw</button>
      </div>
    `;
  }

  private renderRawSource(file: FileContentResponse): TemplateResult {
    if (file.size === 0) return this.renderStatus("This file is empty.");
    loadCodeViewer();
    return html`
      ${file.truncated ? html`<p class="preview-note" role="status">Raw source is truncated. Use Download for the complete file.</p>` : null}
      <code-viewer .content=${file.content} .language=${file.language}></code-viewer>
    `;
  }

  private renderMarkdownPreview(file: FileContentResponse): TemplateResult {
    if (file.size > MAX_INLINE_PREVIEW_BYTES) return this.renderPreviewTooLarge(file);
    try {
      const sanitized = renderWorkspaceMarkdownHtml(file.content);
      return html`
        ${file.truncated ? html`<p class="preview-note" role="status">Preview is rendered from truncated source. Use Download for the complete file.</p>` : null}
        <div class="formatted markdown-preview" dir="auto">${unsafeHTML(sanitized)}</div>
      `;
    } catch {
      return this.renderStatus("Markdown preview failed. Use Raw or Download instead.", true);
    }
  }

  private renderImagePreview(file: FileContentResponse, token: number): TemplateResult {
    if (file.size > MAX_INLINE_PREVIEW_BYTES) return this.renderPreviewTooLarge(file);
    if (this.failedPreviewToken === token) return this.renderPreviewFailure(file, token);
    const src = this.previewUrl(file);
    return html`
      <div class="image-preview">
        <img
          src=${src}
          alt=${`Preview of ${file.path}`}
          decoding="async"
          referrerpolicy="no-referrer"
          @error=${() => { this.recordPreviewFailure(token); }}
        />
      </div>
    `;
  }

  private renderFramePreview(file: FileContentResponse, kind: "html" | "pdf", token: number): TemplateResult {
    if (file.size > MAX_INLINE_PREVIEW_BYTES) return this.renderPreviewTooLarge(file);
    if (this.failedPreviewToken === token) return this.renderPreviewFailure(file, token);
    const src = this.previewUrl(file);

    return html`
      ${kind === "pdf" ? html`<p class="preview-note" role="status">Inline PDF support varies by browser. Use Open ↗ or Download above if the document does not appear.</p>` : null}
      <iframe
        class="file-frame-preview"
        src=${src}
        sandbox=${ifDefined(framePreviewSandbox(kind))}
        allow=""
        referrerpolicy="no-referrer"
        title=${`Preview of ${file.path}`}
        @error=${() => { this.recordPreviewFailure(token); }}
      ></iframe>
    `;
  }

  private renderPreviewFailure(file: FileContentResponse, token: number): TemplateResult {
    return html`
      <div class="preview-state" role="alert">
        <strong>Preview failed for ${file.path}.</strong>
        <span>Open it in a new window or use Download above.</span>
        <button type="button" @click=${() => { this.retryPreview(token); }}>Retry preview</button>
      </div>
    `;
  }

  private renderUnsupportedFile(file: FileContentResponse): TemplateResult {
    const name = workspaceFileName(file.path);
    const href = this.previewUrlBuilder(this.projectId, this.workspaceId, file.path, {
      modifiedAt: file.modifiedAt,
      machineId: this.machineId,
      download: true,
    });
    return html`
      <div class="preview-state">
        <p>Preview isn't available for this file type.</p>
        <a class="download-link" href=${href} download=${name}>Download ${name} · ${formatFileSize(file.size)}</a>
      </div>
    `;
  }

  private renderPreviewTooLarge(file: FileContentResponse): TemplateResult {
    return this.renderStatus(`File too large to preview: ${formatFileSize(file.size)} · limit ${MAX_INLINE_PREVIEW_LABEL}. Use Download above.`);
  }

  private renderStatus(message: string, alert = false): TemplateResult {
    return alert
      ? html`<p class="viewer-status" role="alert">${message}</p>`
      : html`<p class="viewer-status" role="status" aria-live="polite">${message}</p>`;
  }

  private previewUrl(file: FileContentResponse): string {
    return this.previewUrlBuilder(this.projectId, this.workspaceId, file.path, {
      modifiedAt: file.modifiedAt,
      machineId: this.machineId,
    });
  }

  private setMode(mode: WorkspaceFileViewMode, token: number): void {
    if (token !== this.selectionToken) return;
    this.mode = mode;
    this.failedPreviewToken = undefined;
    this.requestUpdate();
  }

  private recordPreviewFailure(token: number): void {
    // Streamed kinds (raster images, PDF) have no raw form and always show an
    // embedded preview, so the guard asks what is on screen rather than what
    // the remembered mode says.
    if (token !== this.selectionToken || this.showsRawSource()) return;
    this.failedPreviewToken = token;
    this.requestUpdate();
  }

  private retryPreview(token: number): void {
    if (token !== this.selectionToken) return;
    this.failedPreviewToken = undefined;
    this.requestUpdate();
  }

  private currentFileKey(): string {
    return workspaceFileViewerIdentityKey(this);
  }

  private showsRawSource(): boolean {
    return this.mode === "raw" && this.selectionHasRawAndPreviewModes();
  }

  private selectionHasRawAndPreviewModes(): boolean {
    const file = this.file;
    if (file === undefined || this.loadError !== undefined) return false;
    if (this.selectedPath === undefined || file.path !== this.selectedPath) return false;
    return hasRawAndPreviewModes(file, workspaceFilePreviewKind(file));
  }

  static override styles = [
    formattedTextStyles,
    css`
      :host { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: auto; color: var(--pi-text); font: 14px system-ui, sans-serif; }
      .viewer-header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); }
      .viewer-header strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .viewer-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
      small { color: var(--pi-muted); }
      .viewer-action, .download-link { flex: 0 0 auto; border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); text-decoration: none; white-space: nowrap; }
      .viewer-action { padding: 3px 8px; font-size: 12px; }
      .viewer-action:hover, .download-link:hover { border-color: var(--pi-border); background: var(--pi-bg); }
      .viewer-mode { flex: 0 0 auto; display: flex; justify-content: flex-end; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); }
      .viewer-mode button, .preview-state button { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 4px 9px; cursor: pointer; font: inherit; }
      .viewer-mode button { font-size: 12px; }
      .viewer-mode button[aria-pressed="true"] { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
      .viewer-mode button:focus-visible, .preview-state button:focus-visible, a:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
      code-viewer { flex: 1 1 auto; min-height: 0; }
      .markdown-preview { flex: 1 1 auto; min-height: 0; box-sizing: border-box; overflow: auto; padding: 16px; }
      .preview-note { flex: 0 0 auto; margin: 0; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-surface); color: var(--pi-muted); padding: 7px 10px; font-size: 12px; }
      .image-preview { flex: 1 1 auto; min-height: 0; box-sizing: border-box; display: flex; align-items: center; justify-content: center; overflow: auto; padding: 16px; }
      .image-preview img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; border: 1px solid var(--pi-border-muted); border-radius: 8px; background-color: var(--pi-surface); background-image: linear-gradient(45deg, color-mix(in srgb, var(--pi-border-muted) 45%, transparent) 25%, transparent 25%), linear-gradient(-45deg, color-mix(in srgb, var(--pi-border-muted) 45%, transparent) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--pi-border-muted) 45%, transparent) 75%), linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--pi-border-muted) 45%, transparent) 75%); background-position: 0 0, 0 8px, 8px -8px, -8px 0; background-size: 16px 16px; box-shadow: 0 8px 24px var(--pi-shadow-soft); }
      .file-frame-preview { flex: 1 1 auto; min-height: 0; width: 100%; border: none; background: var(--pi-surface); }
      .viewer-status { box-sizing: border-box; margin: auto; max-width: 100%; color: var(--pi-muted); padding: 18px; text-align: center; overflow-wrap: anywhere; }
      .preview-state { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; box-sizing: border-box; padding: 24px; color: var(--pi-muted); text-align: center; }
      .preview-state strong { color: var(--pi-text); }
      .preview-state p { margin: 0; }
      .download-link { display: inline-block; padding: 8px 16px; font-size: 13px; }
      @media (max-width: 640px) {
        .viewer-header { align-items: flex-start; flex-direction: column; }
        .viewer-actions { width: 100%; flex-wrap: wrap; }
      }
    `,
  ];
}

/** Stable state key for mode and embedded-preview failure ownership. */
export function workspaceFileViewerIdentityKey(identity: WorkspaceFileViewerIdentity): string {
  return JSON.stringify([
    identity.machineId,
    identity.projectId,
    identity.workspaceId,
    identity.selectedPath ?? null,
    identity.file?.path ?? null,
    identity.file?.modifiedAt ?? null,
    identity.file?.mediaType ?? null,
  ]);
}

export function workspaceFilePreviewKind(file: FileContentResponse): WorkspaceFilePreviewKind {
  if (file.mediaType === "image") return "image";
  if (file.mediaType === "html") return "html";
  if (file.mediaType === "pdf") return "pdf";
  if (file.mediaType === "markdown") return "markdown";
  if (file.binary) return "download";
  return "code";
}

/**
 * Both modes exist when the file has a rendered preview and its JSON read
 * carried literal source: HTML, Markdown, and text-based images such as SVG.
 * Streamed formats (raster images, PDF) have no source to show, and plain code
 * files have no rendered form.
 */
function hasRawAndPreviewModes(file: FileContentResponse, kind: WorkspaceFilePreviewKind): boolean {
  return kind !== "code" && kind !== "download" && !file.binary;
}

/**
 * HTML previews stay fully sandboxed: opaque origin, no scripts, no forms, no
 * navigation, matching the server's `sandbox` CSP.
 *
 * PDF previews intentionally carry no sandbox attribute (`undefined` omits it).
 * Sandboxed frames refuse native PDF handlers — Chromium renders nothing
 * (crbug.com/41131921, whatwg/html#3958) and Firefox 134+ downloads the file
 * instead of displaying it (bugzilla 1724924, 1941725) — so a sandboxed frame
 * produces a blank pane or a surprise download rather than a preview. The
 * isolation that matters for PDF is the response contract: the server sends
 * `application/pdf` with `X-Content-Type-Options: nosniff` and a
 * `default-src 'none'` CSP, so those bytes can only reach the browser's PDF
 * handler, can never be interpreted as an active same-origin document, and
 * cannot load subresources or run script in the PI WEB origin. `allow=""` and
 * `referrerpolicy="no-referrer"` still deny delegated capabilities and referrer
 * leakage, and a persistent Open/Download affordance covers browsers that
 * decline to display PDFs inline at all.
 */
function framePreviewSandbox(kind: "html" | "pdf"): string | undefined {
  return kind === "html" ? "" : undefined;
}

function isBrowserPreviewKind(kind: WorkspaceFilePreviewKind): kind is "image" | "html" | "pdf" {
  return kind === "image" || kind === "html" || kind === "pdf";
}

function metadataForFile(file: FileContentResponse, kind: WorkspaceFilePreviewKind): string {
  const format = kind === "code"
    ? file.language ?? "text"
    : kind === "download"
      ? file.mimeType ?? "binary"
      : kind === "markdown"
        ? "markdown"
        : file.mimeType ?? kind;
  return `${format} · ${formatFileSize(file.size)}${file.truncated ? " · truncated" : ""}`;
}

function loadCodeViewer(): void {
  void import("./CodeViewer");
}
