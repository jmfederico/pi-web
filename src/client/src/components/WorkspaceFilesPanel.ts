import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { FileContentResponse, FileTreeEntry } from "../api";
import { workspaceFilePreviewUrl } from "../api/urls";
import { workspaceUploadPath } from "../api/workspaceUploads";
import type { WorkspaceUploadBatchState, WorkspaceUploadFileState } from "../workspaceUploadState";
import { MAX_INLINE_PREVIEW_BYTES, MAX_INLINE_PREVIEW_LABEL } from "../../../shared/workspaceFiles";
import type { WorkspacePanelContext } from "../plugins/types";
import { workspacePanelStyles } from "./shared";

interface PendingWorkspaceUploadReview {
  files: File[];
}

export interface WorkspaceUploadScope {
  projectId: string;
  workspaceId: string;
  machineId: string;
}

@customElement("workspace-files-panel")
export class WorkspaceFilesPanel extends LitElement {
  @property({ attribute: false }) context: WorkspacePanelContext | undefined;
  @query("#workspace-upload-input") private uploadInput?: HTMLInputElement;
  @state() private pendingUpload: PendingWorkspaceUploadReview | undefined;
  @state() private destinationFolder = "";
  @state() private overwrite = false;
  @state() private createDirs = true;
  @state() private formError = "";
  @state() private dragActive = false;
  private dragDepth = 0;

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (!changedProperties.has("context")) return;
    const previous = changedProperties.get("context");
    if (previous !== undefined && this.context !== undefined && workspaceContextKey(previous) !== workspaceContextKey(this.context)) this.resetPendingUpload();
  }

  override render(): TemplateResult {
    const context = this.context;
    if (context === undefined) return html`<p class="muted">Files unavailable.</p>`;
    return html`
      <section
        class=${this.dragActive ? "files-panel dragging" : "files-panel"}
        @dragenter=${this.handleDragEnter}
        @dragover=${this.handleDragOver}
        @dragleave=${this.handleDragLeave}
        @drop=${this.handleDrop}
      >
        <section class="toolbar">
          <strong>Files</strong>
          ${context.fileTreeStale ? html`<span class="stale">stale</span>` : null}
          <div class="toolbar-actions">
            <button @click=${this.openFilePicker}>Upload</button>
            <button @click=${context.onRefreshFiles}>Refresh</button>
          </div>
          <input id="workspace-upload-input" class="visually-hidden" type="file" multiple @change=${this.handleFileInputChange} />
        </section>
        ${this.renderUploadProgress(context)}
        <section class="split">
          <div class="list tree">
            ${context.fileTree.length === 0 ? html`<p class="muted">No files loaded.</p>` : context.fileTree.map((entry) => this.renderTreeEntry(context, entry, 0))}
          </div>
          <div class="viewer">
            ${this.renderFileViewer(context)}
          </div>
        </section>
        <div class="drop-overlay" aria-hidden=${this.dragActive ? "false" : "true"}>
          <div>
            <strong>Drop files to upload</strong>
            <span>Uploads immediately to the default folder.</span>
          </div>
        </div>
        ${this.pendingUpload === undefined ? null : this.renderUploadDialog(context, this.pendingUpload)}
      </section>
    `;
  }

  private renderTreeEntry(context: WorkspacePanelContext, entry: FileTreeEntry, depth: number): TemplateResult {
    const children = context.expandedDirs[entry.path];
    const hasChildren = children !== undefined;
    const selected = entry.type !== "directory" && context.selectedFilePath === entry.path;
    return html`
      <button class=${selected ? "row selected" : "row"} style=${`--depth:${String(depth)}`} @click=${() => { this.selectTreeEntry(context, entry); }}>
        <span>${entry.type === "directory" ? (hasChildren ? "▾" : "▸") : "·"}</span>
        <span>${entry.name}</span>
      </button>
      ${hasChildren ? children.map((child) => this.renderTreeEntry(context, child, depth + 1)) : null}
    `;
  }

  private selectTreeEntry(context: WorkspacePanelContext, entry: FileTreeEntry): void {
    if (entry.type === "directory") context.onExpandDir(entry.path);
    else context.onSelectFile(entry.path);
  }

  private renderFileViewer(context: WorkspacePanelContext): TemplateResult {
    const status = workspaceFileViewerStatusLabel(context);
    if (status !== undefined) return html`<p class="muted">${status}</p>`;
    const file = context.selectedFileContent;
    // workspaceFileViewerStatusLabel already returned for the no-selection and
    // loading cases above; this guard only narrows the type for the branches.
    if (file === undefined) return html`<p class="muted">Select a file.</p>`;
    switch (workspaceFilePreviewKind(file)) {
      case "image": return this.renderImageViewer(context, file);
      case "html": return this.renderFramePreview(context, file, "html");
      case "pdf": return this.renderFramePreview(context, file, "pdf");
      case "download": return this.renderDownloadViewer(context, file);
      case "code": {
        loadCodeViewer();
        const metadata = `${file.language ?? "text"}${file.truncated ? " · truncated" : ""}`;
        return html`
          ${this.renderViewerHeader(context, file, metadata, { canOpen: false })}
          <code-viewer .content=${file.content} .language=${file.language}></code-viewer>
        `;
      }
    }
  }

  // Shared header for every viewer: file path + metadata, plus per-file actions.
  // "Open ↗" loads the inline preview in a new browser tab — the reliable way to
  // view a PDF at full size (the sandboxed inline iframe can't run the browser's
  // PDF viewer) — and is offered only for types with an inline preview URL.
  // "Download" fetches the raw bytes as an attachment and is offered for any file.
  private renderViewerHeader(context: WorkspacePanelContext, file: FileContentResponse, metadata: string, options: { canOpen: boolean }): TemplateResult {
    const name = fileBaseName(file.path);
    const previewOptions = { modifiedAt: file.modifiedAt, machineId: context.machine.id };
    const openUrl = workspaceFilePreviewUrl(context.workspace.projectId, context.workspace.id, file.path, previewOptions);
    const downloadUrl = workspaceFilePreviewUrl(context.workspace.projectId, context.workspace.id, file.path, { ...previewOptions, download: true });
    return html`
      <div class="viewer-header">
        <strong>${file.path}</strong>
        <div class="viewer-actions">
          <small>${metadata}</small>
          ${options.canOpen ? html`<a class="viewer-action" href=${openUrl} target="_blank" rel="noopener noreferrer" title="Open in new window">Open ↗</a>` : null}
          <a class="viewer-action" href=${downloadUrl} download=${name} title=${`Download ${name}`}>Download</a>
        </div>
      </div>
    `;
  }

  private renderImageViewer(context: WorkspacePanelContext, file: FileContentResponse): TemplateResult {
    const metadata = `${file.mimeType ?? "image"} · ${formatFileSize(file.size)}`;
    if (file.size > MAX_INLINE_PREVIEW_BYTES) return this.renderPreviewTooLarge(context, file, metadata);
    const src = workspaceFilePreviewUrl(context.workspace.projectId, context.workspace.id, file.path, { modifiedAt: file.modifiedAt, machineId: context.machine.id });
    return html`
      ${this.renderViewerHeader(context, file, metadata, { canOpen: true })}
      <div class="image-preview">
        <img src=${src} alt=${file.path} decoding="async" />
      </div>
    `;
  }

  private renderFramePreview(context: WorkspacePanelContext, file: FileContentResponse, kind: "html" | "pdf"): TemplateResult {
    const metadata = `${file.mimeType ?? kind} · ${formatFileSize(file.size)}`;
    if (file.size > MAX_INLINE_PREVIEW_BYTES) return this.renderPreviewTooLarge(context, file, metadata);
    const src = workspaceFilePreviewUrl(context.workspace.projectId, context.workspace.id, file.path, { modifiedAt: file.modifiedAt, machineId: context.machine.id });
    // HTML renders in a fully-restricted sandbox (no scripts, no same-origin).
    // PDF needs `allow-same-origin` so the browser's built-in viewer can load
    // the document; scripts stay blocked either way. When a browser won't render
    // the sandboxed PDF inline, the header's "Open ↗" opens it full-size instead.
    const sandbox = kind === "pdf" ? "allow-same-origin" : "";
    return html`
      ${this.renderViewerHeader(context, file, metadata, { canOpen: true })}
      <iframe class="file-frame-preview" src=${src} sandbox=${sandbox} title=${file.path}></iframe>
    `;
  }

  private renderDownloadViewer(context: WorkspacePanelContext, file: FileContentResponse): TemplateResult {
    const metadata = `${file.mimeType ?? "binary"} · ${formatFileSize(file.size)}`;
    const name = fileBaseName(file.path);
    const href = workspaceFilePreviewUrl(context.workspace.projectId, context.workspace.id, file.path, { modifiedAt: file.modifiedAt, machineId: context.machine.id, download: true });
    return html`
      ${this.renderViewerHeader(context, file, metadata, { canOpen: false })}
      <div class="download-preview">
        <p class="muted">Preview isn't available for this file type.</p>
        <a class="download-link" href=${href} download=${name}>Download ${name} · ${formatFileSize(file.size)}</a>
      </div>
    `;
  }

  private renderPreviewTooLarge(context: WorkspacePanelContext, file: FileContentResponse, metadata: string): TemplateResult {
    return html`
      ${this.renderViewerHeader(context, file, metadata, { canOpen: false })}
      <p class="muted">File too large to preview: ${formatFileSize(file.size)} · limit ${MAX_INLINE_PREVIEW_LABEL}. Use Download above.</p>
    `;
  }

  private renderUploadProgress(context: WorkspacePanelContext): TemplateResult | null {
    const batches = workspaceUploadBatchesForScope(context.state.workspaceUploadBatches, {
      projectId: context.workspace.projectId,
      workspaceId: context.workspace.id,
      machineId: context.machine.id,
    });
    if (batches.length === 0) return null;
    return html`
      <section class="upload-progress" aria-label="Workspace uploads">
        <div class="upload-progress-header">
          <strong>Uploads</strong>
          <small>${uploadSummaryLabel(batches)}</small>
        </div>
        ${batches.map((batch) => this.renderUploadBatch(context, batch))}
      </section>
    `;
  }

  private renderUploadBatch(context: WorkspacePanelContext, batch: WorkspaceUploadBatchState): TemplateResult {
    return html`
      <article class=${`upload-batch ${batch.status}`}>
        <div class="upload-batch-heading">
          <div>
            <strong>${uploadBatchTitle(batch)}</strong>
            <small>${batch.destinationFolder === "" ? "workspace root" : batch.destinationFolder}</small>
          </div>
          <span>${uploadBatchStatusLabel(batch)}</span>
        </div>
        <progress max="1" .value=${uploadBatchProgressValue(batch)}></progress>
        <div class="upload-file-list">
          ${batch.files.map((file) => this.renderUploadFile(file))}
        </div>
        <div class="upload-actions">
          ${batch.status === "uploading" ? html`<button @click=${() => { context.onCancelWorkspaceUpload(batch.id); }}>Cancel</button>` : html`<button @click=${() => { context.onClearWorkspaceUpload(batch.id); }}>Dismiss</button>`}
        </div>
      </article>
    `;
  }

  private renderUploadFile(file: WorkspaceUploadFileState): TemplateResult {
    const detail = uploadFileDetail(file);
    return html`
      <div class=${`upload-file ${file.status}`}>
        <div class="upload-file-main">
          <span>${file.name}</span>
          <small>${detail}</small>
        </div>
        <span class="upload-file-status">${uploadFileStatusLabel(file)}</span>
      </div>
    `;
  }

  private renderUploadDialog(context: WorkspacePanelContext, review: PendingWorkspaceUploadReview): TemplateResult {
    const fileCount = review.files.length;
    return html`
      <div class="dialog-backdrop" @mousedown=${() => { this.closeUploadDialog(); }}>
        <section class="upload-dialog" role="dialog" aria-modal="true" aria-label="Review file upload" @mousedown=${(event: MouseEvent) => { event.stopPropagation(); }} @keydown=${this.handleDialogKeyDown}>
          <header>
            <div>
              <span class="eyebrow">Upload</span>
              <h2>Review ${fileCount === 1 ? "file" : `${String(fileCount)} files`}</h2>
            </div>
            <button class="close-button" title="Cancel upload" aria-label="Cancel upload" @click=${() => { this.closeUploadDialog(); }}>×</button>
          </header>
          <form @submit=${(event: SubmitEvent) => { this.submitUploadReview(event, context, review); }}>
            <label>
              <span>Destination folder</span>
              <input .value=${this.destinationFolder} placeholder=${context.workspaceUploadDefaultFolder} @input=${this.handleDestinationInput} />
              <small>Workspace-relative. Leave empty to upload at the workspace root.</small>
            </label>
            <div class="dialog-options">
              <label>
                <input type="checkbox" .checked=${this.createDirs} @change=${this.handleCreateDirsChange} />
                <span>Create parent folders</span>
              </label>
              <label>
                <input type="checkbox" .checked=${this.overwrite} @change=${this.handleOverwriteChange} />
                <span>Overwrite existing files</span>
              </label>
            </div>
            <section class="review-files" aria-label="Files to upload">
              <strong>${fileCount === 1 ? "File" : "Files"}</strong>
              ${review.files.map((file) => html`
                <div class="review-file">
                  <span>${file.name}</span>
                  <small>${formatFileSize(file.size)}</small>
                </div>
              `)}
            </section>
            ${this.formError === "" ? null : html`<div class="dialog-error" role="alert">${this.formError}</div>`}
            <footer>
              <button type="button" @click=${() => { this.closeUploadDialog(); }}>Cancel</button>
              <button type="submit">Upload</button>
            </footer>
          </form>
        </section>
      </div>
    `;
  }

  private readonly openFilePicker = (): void => {
    this.uploadInput?.click();
  };

  private readonly handleFileInputChange = (event: Event): void => {
    const input = event.currentTarget instanceof HTMLInputElement ? event.currentTarget : undefined;
    const files = fileListToArray(input?.files);
    if (input !== undefined) input.value = "";
    if (files.length > 0) this.openUploadReview(files);
  };

  private readonly handleDragEnter = (event: DragEvent): void => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    this.dragDepth += 1;
    this.dragActive = true;
  };

  private readonly handleDragOver = (event: DragEvent): void => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
    this.dragActive = true;
  };

  private readonly handleDragLeave = (event: DragEvent): void => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.dragActive = false;
  };

  private readonly handleDrop = (event: DragEvent): void => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    this.dragDepth = 0;
    this.dragActive = false;
    const files = fileListToArray(event.dataTransfer?.files);
    const context = this.context;
    if (files.length > 0 && context !== undefined) startDirectWorkspaceUpload(context, files);
  };

  private readonly handleDestinationInput = (event: Event): void => {
    const input = event.currentTarget instanceof HTMLInputElement ? event.currentTarget : undefined;
    this.destinationFolder = input?.value ?? "";
    this.formError = "";
  };

  private readonly handleCreateDirsChange = (event: Event): void => {
    const input = event.currentTarget instanceof HTMLInputElement ? event.currentTarget : undefined;
    this.createDirs = input?.checked ?? true;
  };

  private readonly handleOverwriteChange = (event: Event): void => {
    const input = event.currentTarget instanceof HTMLInputElement ? event.currentTarget : undefined;
    this.overwrite = input?.checked ?? false;
  };

  private readonly handleDialogKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.closeUploadDialog();
  };

  private openUploadReview(files: File[]): void {
    const context = this.context;
    const defaults = workspaceUploadReviewDefaults(context?.workspaceUploadDefaultFolder ?? "");
    this.pendingUpload = { files };
    this.destinationFolder = defaults.destinationFolder;
    this.overwrite = defaults.overwrite;
    this.createDirs = defaults.createDirs;
    this.formError = "";
  }

  private submitUploadReview(event: SubmitEvent, context: WorkspacePanelContext, review: PendingWorkspaceUploadReview): void {
    event.preventDefault();
    const validationError = workspaceUploadReviewError(review.files, this.destinationFolder);
    if (validationError !== undefined) {
      this.formError = validationError;
      return;
    }
    const run = context.onStartWorkspaceUpload(review.files, {
      destinationFolder: this.destinationFolder,
      createDirs: this.createDirs,
      overwrite: this.overwrite,
      selectUploadedFile: true,
    });
    if (run !== undefined) this.closeUploadDialog();
  }

  private closeUploadDialog(): void {
    this.pendingUpload = undefined;
    this.formError = "";
  }

  private resetPendingUpload(): void {
    this.closeUploadDialog();
    this.dragDepth = 0;
    this.dragActive = false;
  }

  static override styles = [
    workspacePanelStyles,
    css`
      :host { flex: 1 1 auto; }
      .files-panel { position: relative; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
      .toolbar-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
      .toolbar .toolbar-actions button { margin-left: 0; }
      .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; }
      .drop-overlay { position: absolute; inset: 52px 10px 10px; z-index: 15; display: grid; place-items: center; border: 2px dashed var(--pi-accent); border-radius: 12px; background: color-mix(in srgb, var(--pi-bg-overlay) 90%, var(--pi-accent) 10%); color: var(--pi-text); opacity: 0; pointer-events: none; transition: opacity .12s ease; }
      .files-panel.dragging .drop-overlay { opacity: 1; }
      .drop-overlay div { display: grid; gap: 4px; justify-items: center; padding: 18px; border-radius: 10px; background: var(--pi-bg-overlay); box-shadow: 0 8px 24px var(--pi-shadow); }
      .drop-overlay span { color: var(--pi-muted); }
      .upload-progress { flex: 0 0 auto; display: grid; gap: 8px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); background: color-mix(in srgb, var(--pi-surface) 55%, transparent); }
      .upload-progress-header, .upload-batch-heading, .upload-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .upload-batch { display: grid; gap: 6px; border: 1px solid var(--pi-border-muted); border-radius: 8px; background: var(--pi-bg); padding: 8px; }
      .upload-batch.error { border-color: var(--pi-danger); }
      .upload-batch.cancelled { border-color: var(--pi-warning-border); }
      .upload-batch.completed { border-color: var(--pi-success-border); }
      .upload-batch-heading > div { min-width: 0; display: grid; gap: 2px; }
      .upload-batch-heading strong, .upload-batch-heading small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      progress { width: 100%; accent-color: var(--pi-accent); }
      .upload-file-list { display: grid; gap: 4px; max-height: 180px; overflow: auto; padding-right: 2px; }
      .upload-file { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; color: var(--pi-muted); }
      .upload-file.completed .upload-file-status { color: var(--pi-success); }
      .upload-file.error { color: var(--pi-danger); }
      .upload-file.cancelled .upload-file-status { color: var(--pi-warning); }
      .upload-file-main { min-width: 0; display: grid; gap: 1px; }
      .upload-file-main span, .upload-file-main small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .upload-file-status { font-size: 12px; white-space: nowrap; }
      .upload-actions { justify-content: end; }
      .dialog-backdrop { position: fixed; inset: 0; z-index: 100; box-sizing: border-box; display: grid; place-items: center; padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); background: var(--pi-overlay); }
      .upload-dialog { box-sizing: border-box; width: min(560px, 100%); max-height: min(720px, 100%); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--pi-border); border-radius: 14px; background: var(--pi-bg); box-shadow: 0 18px 70px var(--pi-shadow-strong); }
      .upload-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--pi-border-muted); }
      .upload-dialog h2 { margin: 2px 0 0; font-size: 18px; line-height: 1.2; }
      .eyebrow { color: var(--pi-muted); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
      .close-button { font-size: 20px; line-height: 1; padding: 4px 9px; }
      form { min-height: 0; display: flex; flex-direction: column; gap: 12px; overflow: auto; padding: 16px; }
      form > label { display: grid; gap: 6px; }
      form > label > span, .review-files > strong { font-weight: 600; }
      input[type="text"], form > label > input:not([type]) { box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 8px 9px; font: var(--pi-control-font-size, 16px) var(--pi-control-font-family, system-ui, sans-serif); }
      input:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
      .dialog-options { display: grid; gap: 8px; }
      .dialog-options label { display: flex; align-items: center; gap: 8px; color: var(--pi-text); }
      .review-files { display: grid; gap: 6px; min-height: 0; max-height: 180px; overflow: auto; border: 1px solid var(--pi-border-muted); border-radius: 8px; padding: 8px; }
      .review-file { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: baseline; }
      .review-file span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dialog-error { border: 1px solid var(--pi-danger); border-radius: 8px; background: color-mix(in srgb, var(--pi-danger) 10%, transparent); color: var(--pi-danger); padding: 9px; line-height: 1.35; overflow-wrap: anywhere; }
      footer { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }
    `,
  ];
}

export function workspaceUploadBatchesForScope(batches: Record<string, WorkspaceUploadBatchState>, scope: WorkspaceUploadScope): WorkspaceUploadBatchState[] {
  return Object.values(batches)
    .filter((batch) => batch.projectId === scope.projectId && batch.workspaceId === scope.workspaceId && batch.machineId === scope.machineId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function workspaceUploadReviewError(files: readonly File[], destinationFolder: string): string | undefined {
  if (files.length === 0) return "Choose at least one file to upload.";
  for (const file of files) {
    try {
      workspaceUploadPath(destinationFolder, file.name);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return undefined;
}

export function workspaceUploadReviewDefaults(destinationFolder: string): { destinationFolder: string; createDirs: boolean; overwrite: boolean } {
  return { destinationFolder, createDirs: true, overwrite: false };
}

/**
 * The muted status message the file viewer shows instead of a viewer, or
 * `undefined` once a real viewer/download renders. Pure seam so tests can
 * assert the no-selection/loading messaging without scraping Lit markup. Files
 * with content always resolve to a viewer (see `workspaceFilePreviewKind`),
 * including binaries, which now offer a download instead of a dead-end message.
 */
export function workspaceFileViewerStatusLabel(
  context: Pick<WorkspacePanelContext, "selectedFilePath" | "selectedFileContent">,
): string | undefined {
  if (context.selectedFilePath === undefined || context.selectedFilePath === "") return "Select a file.";
  if (context.selectedFileContent === undefined) return `Loading ${context.selectedFilePath}…`;
  return undefined;
}

export type WorkspaceFilePreviewKind = "image" | "html" | "pdf" | "download" | "code";

/**
 * Which viewer the file panel renders for a loaded file. Pure seam mirroring
 * `workspaceFileViewerStatusLabel` so the branch selection is unit-testable
 * without rendering. Inline media types render in the browser; other binaries
 * fall back to a download link; text renders in the code viewer.
 */
export function workspaceFilePreviewKind(file: FileContentResponse): WorkspaceFilePreviewKind {
  if (file.mediaType === "image") return "image";
  if (file.mediaType === "html") return "html";
  if (file.mediaType === "pdf") return "pdf";
  if (file.binary) return "download";
  return "code";
}

function fileBaseName(path: string): string {
  const name = path.split("/").pop();
  return name === undefined || name === "" ? path : name;
}

export function startDirectWorkspaceUpload(
  context: Pick<WorkspacePanelContext, "workspaceUploadDefaultFolder" | "onStartWorkspaceUpload">,
  files: readonly File[],
): ReturnType<WorkspacePanelContext["onStartWorkspaceUpload"]> {
  if (files.length === 0) return undefined;
  return context.onStartWorkspaceUpload(files, {
    destinationFolder: context.workspaceUploadDefaultFolder,
    createDirs: true,
    overwrite: false,
    selectUploadedFile: true,
  });
}

function workspaceContextKey(context: WorkspacePanelContext): string {
  return `${context.machine.id}:${context.workspace.projectId}:${context.workspace.id}`;
}

function fileListToArray(files: FileList | null | undefined): File[] {
  return files === null || files === undefined ? [] : Array.from(files);
}

function isFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function uploadSummaryLabel(batches: readonly WorkspaceUploadBatchState[]): string {
  const uploading = batches.filter((batch) => batch.status === "uploading").length;
  return uploading === 0 ? `${String(batches.length)} recent` : `${String(uploading)} uploading`;
}

function uploadBatchTitle(batch: WorkspaceUploadBatchState): string {
  const count = batch.files.length;
  const files = count === 1 ? "file" : "files";
  switch (batch.status) {
    case "completed": return `Uploaded ${String(count)} ${files}`;
    case "error": return `Upload failed for ${String(count)} ${files}`;
    case "cancelled": return `Upload cancelled for ${String(count)} ${files}`;
    case "uploading": return `Uploading ${String(count)} ${files}`;
  }
}

export function uploadBatchStatusLabel(batch: WorkspaceUploadBatchState): string {
  switch (batch.status) {
    case "completed": return "Done";
    case "error": return "Failed";
    case "cancelled": return "Cancelled";
    case "uploading": return formatPercent(batch.percent);
  }
}

export function uploadBatchProgressValue(batch: WorkspaceUploadBatchState): number {
  return batch.status === "uploading" ? batch.percent : 1;
}

function uploadFileStatusLabel(file: WorkspaceUploadFileState): string {
  switch (file.status) {
    case "pending": return "Pending";
    case "uploading": return formatPercent(file.percent);
    case "completed": return "Done";
    case "error": return "Error";
    case "cancelled": return "Cancelled";
  }
}

function uploadFileDetail(file: WorkspaceUploadFileState): string {
  if (file.error !== undefined) return file.error;
  if (file.response !== undefined) return `Wrote ${file.response.path}`;
  return `${file.path} · ${formatFileSize(file.loaded)} / ${formatFileSize(file.total)}`;
}

function formatPercent(value: number): string {
  return `${String(Math.round(Math.max(0, Math.min(1, value)) * 100))}%`;
}

function loadCodeViewer(): void {
  void import("./CodeViewer");
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "0 B";
  if (size < 1024) return `${String(size)} B`;
  const kib = size / 1024;
  if (kib < 1024) return `${formatScaledFileSize(kib)} KB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${formatScaledFileSize(mib)} MB`;
  return `${formatScaledFileSize(mib / 1024)} GB`;
}

function formatScaledFileSize(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}
