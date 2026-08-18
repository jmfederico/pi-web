import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { FileTreeEntry } from "../api";
import { workspaceUploadPath } from "../api/workspaceUploads";
import type { WorkspaceUploadBatchState, WorkspaceUploadFileState } from "../workspaceUploadState";
import type { WorkspacePanelContext } from "../plugins/types";
import { formatFileSize } from "../utils/format";
import { registerRenderedModal, type RenderedModalRegistration } from "./modalLayerRegistry";
import { workspacePanelStyles } from "./shared";
import "./WorkspaceFileViewer";

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
  @query(".dialog-backdrop") private uploadDialogBackdrop?: HTMLElement | null;
  @query(".upload-dialog") private uploadDialog?: HTMLElement | null;
  @state() private pendingUpload: PendingWorkspaceUploadReview | undefined;
  @state() private destinationFolder = "";
  @state() private overwrite = false;
  @state() private createDirs = true;
  @state() private formError = "";
  @state() private dragActive = false;
  private dragDepth = 0;
  private uploadModalRegistration: RenderedModalRegistration | undefined;

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (!changedProperties.has("context")) return;
    const previous = changedProperties.get("context");
    if (previous !== undefined && this.context !== undefined && workspaceContextKey(previous) !== workspaceContextKey(this.context)) this.resetPendingUpload();
  }

  protected override updated(): void {
    this.syncUploadModal();
  }

  override disconnectedCallback(): void {
    this.releaseUploadModal();
    super.disconnectedCallback();
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
            <workspace-file-viewer
              .machineId=${context.machine.id}
              .projectId=${context.workspace.projectId}
              .workspaceId=${context.workspace.id}
              .selectedPath=${context.selectedFilePath}
              .file=${context.selectedFileContent}
              .loadError=${context.selectedFileLoadError}
            ></workspace-file-viewer>
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
        <section class="upload-dialog" role="dialog" aria-modal="true" aria-label="Review file upload" tabindex="-1" @mousedown=${(event: MouseEvent) => { event.stopPropagation(); }} @keydown=${this.handleDialogKeyDown}>
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
              <input id="workspace-upload-destination" .value=${this.destinationFolder} placeholder=${context.workspaceUploadDefaultFolder} @input=${this.handleDestinationInput} />
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

  private syncUploadModal(): void {
    const backdrop = this.uploadDialogBackdrop;
    const dialog = this.uploadDialog;
    if (!(backdrop instanceof HTMLElement) || !(dialog instanceof HTMLElement)) {
      this.releaseUploadModal();
      return;
    }
    if (this.uploadModalRegistration !== undefined) {
      this.applyUploadModalAccessibility(dialog, this.uploadModalRegistration.isTop);
      return;
    }

    const registration = registerRenderedModal({
      element: backdrop,
      // The workspace panel establishes the outer stacking context. Its
      // internal z-index cannot outrank a fixed application dialog outside it.
      paintElement: workspaceModalLayerHost(this),
      focus: () => {
        const destination = this.renderRoot.querySelector<HTMLElement>("#workspace-upload-destination");
        (destination ?? dialog).focus();
      },
      onTopChange: (isTop) => { this.applyUploadModalAccessibility(dialog, isTop); },
    });
    this.uploadModalRegistration = registration;
    registration.focus();
  }

  private applyUploadModalAccessibility(dialog: HTMLElement, isTop: boolean): void {
    dialog.setAttribute("aria-modal", isTop ? "true" : "false");
    if (isTop) dialog.removeAttribute("aria-hidden");
    else dialog.setAttribute("aria-hidden", "true");
  }

  private releaseUploadModal(): void {
    const registration = this.uploadModalRegistration;
    this.uploadModalRegistration = undefined;
    registration?.unregister();
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
      workspace-file-viewer { flex: 1 1 auto; min-height: 0; }
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

function workspaceModalLayerHost(panel: WorkspaceFilesPanel): HTMLElement {
  const root = panel.getRootNode();
  return root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : panel;
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
