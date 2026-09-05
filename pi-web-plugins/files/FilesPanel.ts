import type { FileTreeEntry, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { property, query, state } from "lit/decorators.js";
import {
  FilesRuntime,
  type FilesScopeState,
  type WorkspaceUploadBatchState,
  type WorkspaceUploadFileState,
  type WorkspaceUploadRun,
  workspaceFilesCapabilityV1,
  workspaceUploadPath,
} from "./FilesRuntime";
import type { WorkspaceFilePreviewUrlBuilder } from "./FilesViewer";
import { createWorkspaceFileViewModeStore, type WorkspaceFileViewModeStore } from "./workspaceFileViewMode";

interface PendingWorkspaceUploadReview {
  files: File[];
}

export class WorkspaceFilesPanel extends LitElement {
  @property({ attribute: false }) context: WorkspacePanelContext | undefined;
  @property({ attribute: false }) runtime: FilesRuntime | undefined;
  @query("#workspace-upload-input") private uploadInput?: HTMLInputElement;
  @query("dialog.upload-dialog") private uploadDialog?: HTMLDialogElement;
  @state() private pendingUpload: PendingWorkspaceUploadReview | undefined;
  @state() private destinationFolder = "";
  @state() private overwrite = false;
  @state() private createDirs = true;
  @state() private formError = "";
  @state() private dragActive = false;
  private dragDepth = 0;
  private scope: FilesScopeState | undefined;
  private unsubscribeRuntime: (() => void) | undefined;
  private boundRuntime: FilesRuntime | undefined;
  private boundScopeKey: string | undefined;
  private navigationModeKey = "";
  private modeStore: WorkspaceFileViewModeStore = createWorkspaceFileViewModeStore(undefined);
  private uploadReturnFocus: HTMLElement | undefined;
  private visibilityObserver: ResizeObserver | undefined;

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (!changedProperties.has("context") && !changedProperties.has("runtime")) return;
    const nextKey = this.context === undefined ? undefined : workspaceContextKey(this.context);
    if (this.boundScopeKey !== undefined && nextKey !== this.boundScopeKey) this.resetPendingUpload();
    this.bindRuntime(nextKey);
    const nextNavigationModeKey = workspaceNavigationModeKey(this.context);
    if (nextNavigationModeKey !== this.navigationModeKey) {
      this.navigationModeKey = nextNavigationModeKey;
      this.modeStore = createWorkspaceFileViewModeStore(this.context?.navigation);
    }
  }

  protected override updated(): void {
    this.openPendingDialog();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("resize", this.handleResponsiveVisibilityChange);
    if (typeof ResizeObserver !== "undefined") {
      this.visibilityObserver ??= new ResizeObserver(this.handleResponsiveVisibilityChange);
      this.visibilityObserver.observe(this);
    }
    if (!this.hasUpdated) return;
    const nextKey = this.context === undefined ? undefined : workspaceContextKey(this.context);
    this.bindRuntime(nextKey);
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    window.removeEventListener("resize", this.handleResponsiveVisibilityChange);
    this.visibilityObserver?.disconnect();
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = undefined;
    this.boundRuntime = undefined;
    this.boundScopeKey = undefined;
    this.uploadReturnFocus = undefined;
    this.resetPendingUpload();
    super.disconnectedCallback();
  }

  override render(): TemplateResult {
    const context = this.context;
    const runtime = this.runtime;
    const scope = this.scope;
    if (context === undefined || runtime === undefined || scope === undefined) return html`<p class="muted">Files unavailable.</p>`;
    if (scope.capabilityError !== undefined) {
      return html`
        <section class="capability-error" role="alert">
          <strong>Files is unavailable on this host.</strong>
          <span>${scope.capabilityError}</span>
        </section>
      `;
    }
    const files = workspaceFilesCapabilityV1(context.files);
    if (files === undefined) return html`<p class="capability-error" role="alert">Files requires workspace-files capability v1.</p>`;
    const previewUrlBuilder: WorkspaceFilePreviewUrlBuilder = (_projectId, _workspaceId, path, options) => {
      const reference = options?.modifiedAt === undefined ? undefined : { version: options.modifiedAt };
      return options?.download === true ? files.downloadUrl(path, reference) : files.previewUrl(path, reference);
    };
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
          ${scope.treeLoading ? html`<span class="muted">loading…</span>` : null}
          ${scope.treeStale ? html`<span class="stale">stale</span>` : null}
          <div class="toolbar-actions">
            <button @click=${this.openFilePicker}>Upload</button>
            <button @click=${() => { void runtime.refreshFiles(context); }}>Refresh</button>
          </div>
          <input id="workspace-upload-input" class="visually-hidden" type="file" multiple @change=${this.handleFileInputChange} />
        </section>
        ${scope.error === undefined ? null : html`<p class="files-error" role="alert">${scope.error}</p>`}
        ${this.renderUploadProgress(context, runtime, scope)}
        <section class="split">
          <div class="list tree">
            ${scope.fileTree.length === 0 ? html`<p class="muted">No files loaded.</p>` : scope.fileTree.map((entry) => this.renderTreeEntry(context, runtime, scope, entry, 0))}
          </div>
          <div class="viewer">
            <pi-web-files-viewer
              .machineId=${context.machine.id}
              .projectId=${context.workspace.projectId}
              .workspaceId=${context.workspace.id}
              .selectedPath=${scope.selectedFilePath}
              .file=${scope.selectedFileContent}
              .loadError=${scope.selectedFileLoadError}
              .previewUrlBuilder=${previewUrlBuilder}
              .modeStore=${this.modeStore}
              .maxInlinePreviewBytes=${files.maxInlinePreviewBytes}
            ></pi-web-files-viewer>
          </div>
        </section>
        <div class="drop-overlay" aria-hidden=${this.dragActive ? "false" : "true"}>
          <div>
            <strong>Drop files to upload</strong>
            <span>Uploads immediately to the default folder.</span>
          </div>
        </div>
        ${this.pendingUpload === undefined ? null : this.renderUploadDialog(context, runtime, this.pendingUpload, files.defaultUploadFolder)}
      </section>
    `;
  }

  private bindRuntime(nextKey: string | undefined): void {
    const context = this.context;
    const runtime = this.runtime;
    const needsSubscription = runtime !== this.boundRuntime || nextKey !== this.boundScopeKey;
    if (needsSubscription) {
      this.unsubscribeRuntime?.();
      this.unsubscribeRuntime = undefined;
      this.boundRuntime = runtime;
      this.boundScopeKey = nextKey;
    }
    if (context === undefined || runtime === undefined) {
      this.scope = undefined;
      return;
    }
    if (needsSubscription) {
      this.unsubscribeRuntime = runtime.subscribe(context, (snapshot, latestContext) => {
        if (this.runtime !== this.boundRuntime || workspaceContextKey(latestContext) !== this.boundScopeKey) return;
        this.context = latestContext;
        this.scope = snapshot;
        this.requestUpdate();
      });
    }
    this.scope = runtime.prepare(context);
  }

  private renderTreeEntry(
    context: WorkspacePanelContext,
    runtime: FilesRuntime,
    scope: FilesScopeState,
    entry: FileTreeEntry,
    depth: number,
  ): TemplateResult {
    const children = scope.expandedDirs[entry.path];
    const hasChildren = children !== undefined;
    const selected = entry.type !== "directory" && scope.selectedFilePath === entry.path;
    return html`
      <button class=${selected ? "row selected" : "row"} style=${`--depth:${String(depth)}`} @click=${() => {
        if (entry.type === "directory") void runtime.expandDir(context, entry.path);
        else void runtime.selectFile(context, entry.path);
      }}>
        <span>${entry.type === "directory" ? (hasChildren ? "▾" : "▸") : "·"}</span>
        <span>${entry.name}</span>
      </button>
      ${hasChildren ? children.map((child) => this.renderTreeEntry(context, runtime, scope, child, depth + 1)) : null}
    `;
  }

  private renderUploadProgress(context: WorkspacePanelContext, runtime: FilesRuntime, scope: FilesScopeState): TemplateResult | null {
    const batches = workspaceUploadBatches(scope.uploadBatches);
    if (batches.length === 0) return null;
    return html`
      <section class="upload-progress" aria-label="Workspace uploads">
        <div class="upload-progress-header">
          <strong>Uploads</strong>
          <small>${uploadSummaryLabel(batches)}</small>
        </div>
        ${batches.map((batch) => html`
          <article class=${`upload-batch ${batch.status}`}>
            <div class="upload-batch-heading">
              <div>
                <strong>${uploadBatchTitle(batch)}</strong>
                <small>${batch.destinationFolder === "" ? "workspace root" : batch.destinationFolder}</small>
              </div>
              <span>${uploadBatchStatusLabel(batch)}</span>
            </div>
            <progress max="1" .value=${uploadBatchProgressValue(batch)}></progress>
            <div class="upload-file-list">${batch.files.map((file) => this.renderUploadFile(file))}</div>
            <div class="upload-actions">
              ${batch.status === "uploading"
                ? html`<button @click=${() => { runtime.cancelWorkspaceUpload(context, batch.id); }}>Cancel</button>`
                : html`<button @click=${() => { runtime.clearWorkspaceUpload(context, batch.id); }}>Dismiss</button>`}
            </div>
          </article>
        `)}
      </section>
    `;
  }

  private renderUploadFile(file: WorkspaceUploadFileState): TemplateResult {
    return html`
      <div class=${`upload-file ${file.status}`}>
        <div class="upload-file-main">
          <span>${file.name}</span>
          <small>${uploadFileDetail(file)}</small>
        </div>
        <span class="upload-file-status">${uploadFileStatusLabel(file)}</span>
      </div>
    `;
  }

  private renderUploadDialog(
    context: WorkspacePanelContext,
    runtime: FilesRuntime,
    review: PendingWorkspaceUploadReview,
    defaultFolder: string,
  ): TemplateResult {
    const fileCount = review.files.length;
    return html`
      <dialog class="upload-dialog" aria-label="Review file upload" @cancel=${this.handleDialogCancel} @close=${this.handleDialogClose} @click=${this.handleDialogClick}>
        <header>
          <div>
            <span class="eyebrow">Upload</span>
            <h2>Review ${fileCount === 1 ? "file" : `${String(fileCount)} files`}</h2>
          </div>
          <button class="close-button" type="button" title="Cancel upload" aria-label="Cancel upload" @click=${() => { this.closeUploadDialog(); }}>×</button>
        </header>
        <form @submit=${(event: SubmitEvent) => { this.submitUploadReview(event, context, runtime, review); }}>
          <label>
            <span>Destination folder</span>
            <input id="workspace-upload-destination" autofocus .value=${this.destinationFolder} placeholder=${defaultFolder} @input=${this.handleDestinationInput} />
            <small>Workspace-relative. Leave empty to upload at the workspace root.</small>
          </label>
          <div class="dialog-options">
            <label><input type="checkbox" .checked=${this.createDirs} @change=${this.handleCreateDirsChange} /><span>Create parent folders</span></label>
            <label><input type="checkbox" .checked=${this.overwrite} @change=${this.handleOverwriteChange} /><span>Overwrite existing files</span></label>
          </div>
          <section class="review-files" aria-label="Files to upload">
            <strong>${fileCount === 1 ? "File" : "Files"}</strong>
            ${review.files.map((file) => html`<div class="review-file"><span>${file.name}</span><small>${formatFileSize(file.size)}</small></div>`)}
          </section>
          ${this.formError === "" ? null : html`<div class="dialog-error" role="alert">${this.formError}</div>`}
          <footer>
            <button type="button" @click=${() => { this.closeUploadDialog(); }}>Cancel</button>
            <button type="submit">Upload</button>
          </footer>
        </form>
      </dialog>
    `;
  }

  private readonly openFilePicker = (event: Event): void => {
    if (event.currentTarget instanceof HTMLElement) this.uploadReturnFocus = event.currentTarget;
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
    if (this.context !== undefined && this.runtime !== undefined) startDirectWorkspaceUpload(this.runtime, this.context, files);
  };

  private readonly handleDestinationInput = (event: Event): void => {
    this.destinationFolder = event.currentTarget instanceof HTMLInputElement ? event.currentTarget.value : "";
    this.formError = "";
  };

  private readonly handleCreateDirsChange = (event: Event): void => {
    this.createDirs = event.currentTarget instanceof HTMLInputElement ? event.currentTarget.checked : true;
  };

  private readonly handleOverwriteChange = (event: Event): void => {
    this.overwrite = event.currentTarget instanceof HTMLInputElement ? event.currentTarget.checked : false;
  };

  private readonly handleDialogCancel = (event: Event): void => {
    event.preventDefault();
    this.closeUploadDialog();
  };

  private readonly handleDialogClose = (): void => {
    if (this.pendingUpload !== undefined) {
      this.pendingUpload = undefined;
      this.formError = "";
    }
    this.restoreUploadFocus();
  };

  private readonly handleDialogClick = (event: MouseEvent): void => {
    if (event.target === this.uploadDialog) this.closeUploadDialog();
  };

  private readonly handleResponsiveVisibilityChange = (): void => {
    const dialog = this.uploadDialog;
    if ((this.pendingUpload === undefined && dialog?.open !== true) || this.isPanelVisible()) return;
    // The trigger remains connected when the compact shell CSS hides this
    // panel, but focusing that hidden control would create a second trap.
    this.uploadReturnFocus = undefined;
    this.resetPendingUpload();
  };

  private openUploadReview(files: File[]): void {
    const defaultFolder = this.context === undefined ? "" : workspaceFilesCapabilityV1(this.context.files)?.defaultUploadFolder ?? "";
    const defaults = workspaceUploadReviewDefaults(defaultFolder);
    this.pendingUpload = { files };
    this.destinationFolder = defaults.destinationFolder;
    this.overwrite = defaults.overwrite;
    this.createDirs = defaults.createDirs;
    this.formError = "";
  }

  private submitUploadReview(event: SubmitEvent, context: WorkspacePanelContext, runtime: FilesRuntime, review: PendingWorkspaceUploadReview): void {
    event.preventDefault();
    const validationError = workspaceUploadReviewError(review.files, this.destinationFolder);
    if (validationError !== undefined) {
      this.formError = validationError;
      return;
    }
    const run = runtime.startWorkspaceUpload(context, review.files, {
      destinationFolder: this.destinationFolder,
      createDirs: this.createDirs,
      overwrite: this.overwrite,
      selectUploadedFile: true,
    });
    if (run !== undefined) this.closeUploadDialog();
  }

  private openPendingDialog(): void {
    const dialog = this.uploadDialog;
    if (this.pendingUpload === undefined || dialog === undefined || dialog.open) return;
    // A native chooser can finish after responsive layout has hidden this
    // still-connected panel. Recheck at the showModal boundary so it cannot
    // create an invisible modal that leaves the rest of the application inert.
    if (!this.isPanelVisible()) {
      this.uploadReturnFocus = undefined;
      const hiddenReview = this.pendingUpload;
      queueMicrotask(() => {
        if (this.pendingUpload === hiddenReview) this.resetPendingUpload();
      });
      return;
    }
    try {
      dialog.showModal();
      this.renderRoot.querySelector<HTMLInputElement>("#workspace-upload-destination")?.focus();
    } catch (error) {
      this.formError = `Unable to open upload review: ${errorMessage(error)}`;
    }
  }

  private isPanelVisible(): boolean {
    return this.getClientRects().length > 0;
  }

  private closeUploadDialog(): void {
    const dialog = this.uploadDialog;
    if (dialog?.open === true) dialog.close();
    else {
      this.pendingUpload = undefined;
      this.formError = "";
      this.restoreUploadFocus();
    }
  }

  private restoreUploadFocus(): void {
    const target = this.uploadReturnFocus;
    this.uploadReturnFocus = undefined;
    void this.updateComplete.then(() => { if (target?.isConnected === true) target.focus(); });
  }

  private resetPendingUpload(): void {
    if (this.uploadDialog?.open === true) this.uploadDialog.close();
    this.pendingUpload = undefined;
    this.formError = "";
    this.dragDepth = 0;
    this.dragActive = false;
  }

  static override styles = css`
    :host { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; color: var(--pi-text); background: var(--pi-bg); font: 13px system-ui, sans-serif; container-type: inline-size; }
    .files-panel { position: relative; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
    .toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); }
    .toolbar-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
    button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 5px 7px; cursor: pointer; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .muted { color: var(--pi-muted); }
    .stale { border: 1px solid var(--pi-warning-border); border-radius: 999px; color: var(--pi-warning); padding: 1px 6px; font-size: 12px; }
    .files-error { flex: 0 0 auto; margin: 0; border-bottom: 1px solid var(--pi-danger); color: var(--pi-danger); padding: 8px; overflow-wrap: anywhere; }
    .capability-error { box-sizing: border-box; width: min(100%, 420px); margin: auto; display: grid; gap: 8px; color: var(--pi-danger); padding: 24px; text-align: center; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; }
    .split { flex: 1 1 auto; min-height: 0; display: grid; grid-template-rows: minmax(160px, 34%) minmax(0, 1fr); }
    .list { min-height: 0; overflow: auto; border-bottom: 1px solid var(--pi-border); padding: 6px; }
    .row { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 4px; width: 100%; border: 0; border-radius: 5px; background: transparent; text-align: left; padding: 4px 6px 4px calc(6px + var(--depth, 0) * 14px); }
    .row:hover, .row.selected { background: var(--pi-selection-bg); }
    .row span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .viewer { min-height: 0; overflow: auto; display: flex; flex-direction: column; }
    pi-web-files-viewer { flex: 1 1 auto; min-height: 0; }
    p { margin: 10px; }
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
    dialog.upload-dialog { box-sizing: border-box; width: min(560px, calc(100% - 40px)); max-height: min(720px, calc(100% - 40px)); max-height: min(720px, calc(100dvh - 40px)); margin: auto; padding: 0; border: 1px solid var(--pi-border); border-radius: 14px; background: var(--pi-bg); color: var(--pi-text); box-shadow: 0 18px 70px var(--pi-shadow-strong); overflow: hidden; }
    dialog.upload-dialog[open] { display: flex; flex-direction: column; }
    dialog.upload-dialog::backdrop { background: var(--pi-overlay); }
    .upload-dialog header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--pi-border-muted); }
    .upload-dialog h2 { margin: 2px 0 0; font-size: 18px; line-height: 1.2; }
    .eyebrow { color: var(--pi-muted); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
    .close-button { font-size: 20px; line-height: 1; padding: 4px 9px; }
    form { box-sizing: border-box; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 12px; overflow: auto; overscroll-behavior: contain; padding: 16px; }
    form > label { flex: 0 0 auto; display: grid; gap: 6px; }
    form > label > span, .review-files > strong { font-weight: 600; }
    form > label > input:not([type]) { box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 8px 9px; font: var(--pi-control-font-size, 16px) var(--pi-control-font-family, system-ui, sans-serif); }
    .dialog-options { flex: 0 0 auto; display: grid; gap: 8px; }
    .dialog-options label { display: flex; align-items: center; gap: 8px; }
    .review-files { flex: 1 1 180px; display: grid; gap: 6px; min-height: 0; max-height: 180px; overflow: auto; border: 1px solid var(--pi-border-muted); border-radius: 8px; padding: 8px; }
    .review-file { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: baseline; }
    .review-file span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dialog-error { flex: 0 0 auto; border: 1px solid var(--pi-danger); border-radius: 8px; background: color-mix(in srgb, var(--pi-danger) 10%, transparent); color: var(--pi-danger); padding: 9px; overflow-wrap: anywhere; }
    footer { flex: 0 0 auto; display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }
  `;
}

export function workspaceUploadBatches(batches: Record<string, WorkspaceUploadBatchState>): WorkspaceUploadBatchState[] {
  return Object.values(batches).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function workspaceUploadReviewError(files: readonly File[], destinationFolder: string): string | undefined {
  if (files.length === 0) return "Choose at least one file to upload.";
  for (const file of files) {
    try {
      workspaceUploadPath(destinationFolder, file.name);
    } catch (error) {
      return errorMessage(error);
    }
  }
  return undefined;
}

export function workspaceUploadReviewDefaults(destinationFolder: string): { destinationFolder: string; createDirs: boolean; overwrite: boolean } {
  return { destinationFolder, createDirs: true, overwrite: false };
}

export function startDirectWorkspaceUpload(
  runtime: FilesRuntime,
  context: WorkspacePanelContext,
  files: readonly File[],
): WorkspaceUploadRun | undefined {
  if (files.length === 0) return undefined;
  const capability = workspaceFilesCapabilityV1(context.files);
  if (capability === undefined) return undefined;
  return runtime.startWorkspaceUpload(context, files, {
    destinationFolder: capability.defaultUploadFolder,
    createDirs: true,
    overwrite: false,
    selectUploadedFile: true,
  });
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

function workspaceContextKey(context: WorkspacePanelContext): string {
  return JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
}

function workspaceNavigationModeKey(context: WorkspacePanelContext | undefined): string {
  const value = context?.navigation?.query["mode"];
  const mode = typeof value === "string" ? value : value?.[0];
  return JSON.stringify([
    context?.machine.id ?? null,
    context?.workspace.projectId ?? null,
    context?.workspace.id ?? null,
    context?.navigation?.contributionId ?? null,
    mode ?? null,
  ]);
}

function fileListToArray(files: FileList | null | undefined): File[] {
  return files === null || files === undefined ? [] : Array.from(files);
}

function isFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
