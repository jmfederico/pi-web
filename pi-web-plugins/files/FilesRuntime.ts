import type {
  FileContentResponse,
  FileTreeEntry,
  WorkspaceFileUploadTask,
  WorkspaceFilesCapabilityV1,
  WorkspaceFilesContextValue,
  WorkspaceInvalidation,
  WorkspacePanelContext,
  WorkspacePanelNavigationV1,
  WriteWorkspaceFileResponse,
} from "@jmfederico/pi-web/plugin-api";

const MAX_RECENT_SCOPES = 8;

export type WorkspaceUploadFileStatus = "pending" | "uploading" | "completed" | "error" | "cancelled";
export type WorkspaceUploadBatchStatus = "uploading" | "completed" | "error" | "cancelled";

export interface WorkspaceUploadFileState {
  readonly index: number;
  readonly name: string;
  path: string;
  readonly size: number;
  loaded: number;
  total: number;
  percent: number;
  lengthComputable: boolean;
  status: WorkspaceUploadFileStatus;
  error?: string;
  response?: WriteWorkspaceFileResponse;
}

export interface WorkspaceUploadBatchState {
  readonly id: string;
  readonly destinationFolder: string;
  readonly overwrite: boolean;
  readonly createDirs: boolean;
  readonly files: WorkspaceUploadFileState[];
  currentFileIndex: number;
  loaded: number;
  total: number;
  percent: number;
  status: WorkspaceUploadBatchStatus;
  readonly startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface FilesScopeState {
  readonly key: string;
  readonly machineId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  fileTree: FileTreeEntry[];
  expandedDirs: Record<string, FileTreeEntry[]>;
  treeLoading: boolean;
  treeStale: boolean;
  error?: string;
  selectedFilePath?: string;
  selectedFileContent?: FileContentResponse;
  selectedFileLoadError?: string;
  uploadBatches: Record<string, WorkspaceUploadBatchState>;
  capabilityError?: string;
}

export interface StartWorkspaceUploadOptions {
  destinationFolder: string;
  createDirs?: boolean;
  overwrite?: boolean;
  selectUploadedFile?: boolean;
}

export interface WorkspaceUploadRun {
  batchId: string;
  done: Promise<void>;
}

type FilesScopeListener = (snapshot: FilesScopeState, context: WorkspacePanelContext) => void;

interface ScopeRecord extends FilesScopeState {
  context: WorkspacePanelContext;
  files: WorkspaceFilesCapabilityV1 | undefined;
  navigationSnapshot: WorkspacePanelNavigationV1 | undefined;
  listeners: Set<FilesScopeListener>;
  selectedRequestGeneration: number;
  selectedAbort: AbortController | undefined;
  selectedNeedsRestore: boolean;
  treeRequestGeneration: number;
  treeAbort: AbortController | undefined;
  expandedAborts: Map<string, AbortController>;
  initialized: boolean;
  suspended: boolean;
  lastUsed: number;
  uploadTasks: Map<string, WorkspaceFileUploadTask>;
  cancelledUploads: Set<string>;
}

export interface FilesRuntimeDependencies {
  createUploadBatchId?: () => string;
  now?: () => string;
}

/**
 * Plugin-owned Files state, bounded by recent workspace scope. Host callbacks
 * provide authority and transport; this runtime owns only product state and
 * orchestration.
 */
export class FilesRuntime {
  private readonly scopes = new Map<string, ScopeRecord>();
  private readonly createUploadBatchId: () => string;
  private readonly now: () => string;
  private uploadBatchSequence = 0;
  private useSequence = 0;

  constructor(dependencies: FilesRuntimeDependencies = {}) {
    this.createUploadBatchId = dependencies.createUploadBatchId ?? (() => {
      this.uploadBatchSequence += 1;
      return `files-upload-${String(this.uploadBatchSequence)}`;
    });
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  prepare(context: WorkspacePanelContext): FilesScopeState {
    const scope = this.bindContext(context);
    void this.synchronizeNavigation(scope);
    if (!scope.initialized && !scope.suspended && scope.capabilityError === undefined) {
      scope.initialized = true;
      void this.refreshFiles(context);
    }
    return scope;
  }

  snapshot(context: WorkspacePanelContext): FilesScopeState {
    const existing = this.scopes.get(scopeKey(context));
    if (existing === undefined) return this.bindContext(context);
    existing.lastUsed = ++this.useSequence;
    return existing;
  }

  subscribe(context: WorkspacePanelContext, listener: FilesScopeListener): () => void {
    const scope = this.bindContext(context);
    scope.suspended = false;
    scope.listeners.add(listener);
    return () => {
      scope.listeners.delete(listener);
      if (scope.listeners.size === 0) {
        scope.suspended = true;
        if (scope.selectedAbort !== undefined) {
          this.cancelSelectedRequest(scope);
          scope.selectedNeedsRestore = scope.selectedFilePath !== undefined;
        }
        this.cancelTreeRequests(scope, true);
      }
      this.evictInactiveScopes();
    };
  }

  async refreshFiles(context: WorkspacePanelContext): Promise<void> {
    const scope = this.bindContext(context);
    const files = this.requireFiles(scope);
    if (files === undefined) return;
    scope.initialized = true;
    this.cancelTreeRequests(scope);
    const generation = ++scope.treeRequestGeneration;
    const abort = new AbortController();
    scope.treeAbort = abort;
    scope.treeLoading = true;
    this.notify(scope);
    try {
      const root = await files.listFiles("", { signal: abort.signal });
      const expandedEntries = await Promise.all(Object.keys(scope.expandedDirs).map(async (path) => {
        const response = await files.listFiles(path, { signal: abort.signal });
        return [path, response.entries] as const;
      }));
      if (!this.isCurrentTreeRequest(scope, generation, abort)) return;
      scope.fileTree = root.entries;
      scope.expandedDirs = Object.fromEntries(expandedEntries);
      scope.treeStale = false;
      delete scope.error;
    } catch (error) {
      if (!this.isCurrentTreeRequest(scope, generation, abort) || isAbortError(error)) return;
      abort.abort();
      scope.error = errorMessage(error);
    } finally {
      if (this.isCurrentTreeRequest(scope, generation, abort)) {
        scope.treeAbort = undefined;
        scope.treeLoading = false;
        this.notify(scope);
      }
    }
  }

  async expandDir(context: WorkspacePanelContext, path: string): Promise<void> {
    const scope = this.bindContext(context);
    const files = this.requireFiles(scope);
    if (files === undefined) return;
    this.cancelTreeRefreshForInteraction(scope);
    if (scope.expandedDirs[path] !== undefined) {
      this.cancelExpandedRequest(scope, path);
      scope.expandedDirs = omitKey(scope.expandedDirs, path);
      this.notify(scope);
      return;
    }
    this.cancelExpandedRequest(scope, path);
    const abort = new AbortController();
    scope.expandedAborts.set(path, abort);
    try {
      const response = await files.listFiles(path, { signal: abort.signal });
      if (!this.isCurrentExpandedRequest(scope, path, abort)) return;
      scope.expandedDirs = { ...scope.expandedDirs, [path]: response.entries };
      delete scope.error;
    } catch (error) {
      if (!this.isCurrentExpandedRequest(scope, path, abort) || isAbortError(error)) return;
      scope.error = errorMessage(error);
    } finally {
      if (this.isCurrentExpandedRequest(scope, path, abort)) {
        scope.expandedAborts.delete(path);
        this.notify(scope);
      }
    }
  }

  async selectFile(context: WorkspacePanelContext, path: string): Promise<void> {
    const scope = this.bindContext(context);
    context.navigation?.set("file", path);
    await this.restoreFile(scope, path);
  }

  clearSelection(context: WorkspacePanelContext): void {
    const scope = this.bindContext(context);
    context.navigation?.set("file", undefined);
    this.cancelSelectedRequest(scope);
    delete scope.selectedFilePath;
    delete scope.selectedFileContent;
    delete scope.selectedFileLoadError;
    scope.selectedNeedsRestore = false;
    this.notify(scope);
  }

  startWorkspaceUpload(
    context: WorkspacePanelContext,
    filesToUpload: readonly File[],
    options: StartWorkspaceUploadOptions,
  ): WorkspaceUploadRun | undefined {
    const scope = this.bindContext(context);
    const files = this.requireFiles(scope);
    if (files === undefined || filesToUpload.length === 0) return undefined;

    let batch: WorkspaceUploadBatchState;
    try {
      batch = createUploadBatch(
        this.createUploadBatchId(),
        filesToUpload,
        options.destinationFolder,
        options.overwrite ?? false,
        options.createDirs ?? true,
        this.now(),
      );
    } catch (error) {
      scope.error = errorMessage(error);
      this.notify(scope);
      return undefined;
    }

    scope.uploadBatches = { ...scope.uploadBatches, [batch.id]: batch };
    this.notify(scope);
    const done = this.runWorkspaceUpload(scope, files, filesToUpload, batch, options);
    return { batchId: batch.id, done };
  }

  cancelWorkspaceUpload(context: WorkspacePanelContext, batchId: string): void {
    const scope = this.bindContext(context);
    const batch = scope.uploadBatches[batchId];
    if (batch?.status !== "uploading") return;
    scope.cancelledUploads.add(batchId);
    scope.uploadTasks.get(batchId)?.cancel();
    cancelUploadBatch(batch, this.now());
    this.notify(scope);
  }

  clearWorkspaceUpload(context: WorkspacePanelContext, batchId: string): void {
    const scope = this.bindContext(context);
    const batch = scope.uploadBatches[batchId];
    const task = scope.uploadTasks.get(batchId);
    if (batch?.status === "uploading" || task !== undefined) {
      scope.cancelledUploads.add(batchId);
      task?.cancel();
      if (batch !== undefined) cancelUploadBatch(batch, this.now());
    } else {
      scope.cancelledUploads.delete(batchId);
    }
    scope.uploadTasks.delete(batchId);
    scope.uploadBatches = omitKey(scope.uploadBatches, batchId);
    this.notify(scope);
    this.evictInactiveScopes();
  }

  async invalidate(context: WorkspacePanelContext, _invalidation?: WorkspaceInvalidation): Promise<void> {
    void _invalidation;
    const scope = this.bindContext(context);
    const navigationRestore = this.synchronizeNavigation(scope);
    scope.treeStale = true;
    if (scope.suspended) {
      this.cancelTreeRequests(scope, true);
      await navigationRestore;
      return;
    }
    this.notify(scope);
    if (hasInFlightUpload(scope)) {
      await navigationRestore;
      return;
    }
    await Promise.all([navigationRestore, this.refreshFiles(context)]);
  }

  private bindContext(context: WorkspacePanelContext): ScopeRecord {
    const key = scopeKey(context);
    let scope = this.scopes.get(key);
    if (scope === undefined) {
      scope = {
        key,
        machineId: context.machine.id,
        projectId: context.workspace.projectId,
        workspaceId: context.workspace.id,
        context,
        fileTree: [],
        expandedDirs: {},
        treeLoading: false,
        treeStale: false,
        uploadBatches: {},
        files: undefined,
        navigationSnapshot: undefined,
        listeners: new Set(),
        selectedRequestGeneration: 0,
        selectedAbort: undefined,
        selectedNeedsRestore: false,
        treeRequestGeneration: 0,
        treeAbort: undefined,
        expandedAborts: new Map(),
        initialized: false,
        suspended: false,
        lastUsed: 0,
        uploadTasks: new Map(),
        cancelledUploads: new Set(),
      };
      this.scopes.set(key, scope);
    }
    scope.context = context;
    scope.lastUsed = ++this.useSequence;
    const capability = workspaceFilesCapabilityV1(context.files);
    scope.files = capability;
    const capabilityError = filesCapabilityError(context.files, context.navigation);
    if (capabilityError === undefined) delete scope.capabilityError;
    else scope.capabilityError = capabilityError;
    this.evictInactiveScopes(scope.key);
    return scope;
  }

  private requireFiles(scope: ScopeRecord): WorkspaceFilesCapabilityV1 | undefined {
    if (scope.files !== undefined && scope.capabilityError === undefined) return scope.files;
    scope.capabilityError ??= "Files requires workspace-files capability v1 and contribution navigation v1. Update the PI WEB host.";
    this.notify(scope);
    return undefined;
  }

  private synchronizeNavigation(scope: ScopeRecord): Promise<void> {
    if (scope.navigationSnapshot === scope.context.navigation && !scope.selectedNeedsRestore) return Promise.resolve();
    scope.navigationSnapshot = scope.context.navigation;
    return this.restoreNavigationSelection(scope);
  }

  private async restoreNavigationSelection(scope: ScopeRecord): Promise<void> {
    if (scope.capabilityError !== undefined) return;
    const selectedPath = firstQueryString(scope.navigationSnapshot?.query["file"]);
    if (scope.suspended) {
      this.cancelSelectedRequest(scope);
      if (selectedPath === undefined || selectedPath === "") delete scope.selectedFilePath;
      else scope.selectedFilePath = selectedPath;
      delete scope.selectedFileContent;
      delete scope.selectedFileLoadError;
      scope.selectedNeedsRestore = selectedPath !== undefined && selectedPath !== "";
      return;
    }
    if (selectedPath === scope.selectedFilePath && !scope.selectedNeedsRestore) return;
    if (selectedPath === undefined || selectedPath === "") {
      this.cancelSelectedRequest(scope);
      delete scope.selectedFilePath;
      delete scope.selectedFileContent;
      delete scope.selectedFileLoadError;
      scope.selectedNeedsRestore = false;
      this.notify(scope);
      return;
    }
    await this.restoreFile(scope, selectedPath);
  }

  private async restoreFile(scope: ScopeRecord, path: string): Promise<void> {
    const files = this.requireFiles(scope);
    if (files === undefined) return;
    this.cancelSelectedRequest(scope);
    const generation = ++scope.selectedRequestGeneration;
    const abort = new AbortController();
    scope.selectedAbort = abort;
    scope.selectedNeedsRestore = false;
    scope.selectedFilePath = path;
    delete scope.selectedFileContent;
    delete scope.selectedFileLoadError;
    this.notify(scope);
    try {
      const content = await files.readFile(path, { signal: abort.signal });
      if (!this.isCurrentFileRequest(scope, generation, path)) return;
      scope.selectedFileContent = content;
      delete scope.selectedFileLoadError;
    } catch (error) {
      if (!this.isCurrentFileRequest(scope, generation, path) || isAbortError(error)) return;
      delete scope.selectedFileContent;
      scope.selectedFileLoadError = errorMessage(error);
    } finally {
      if (this.isCurrentFileRequest(scope, generation, path)) scope.selectedAbort = undefined;
      this.notify(scope);
    }
  }

  private isCurrentFileRequest(scope: ScopeRecord, generation: number, path: string): boolean {
    return scope.selectedRequestGeneration === generation && scope.selectedFilePath === path;
  }

  private isCurrentTreeRequest(scope: ScopeRecord, generation: number, abort: AbortController): boolean {
    return scope.treeRequestGeneration === generation && scope.treeAbort === abort;
  }

  private isCurrentExpandedRequest(scope: ScopeRecord, path: string, abort: AbortController): boolean {
    return scope.expandedAborts.get(path) === abort;
  }

  private cancelTreeRequests(scope: ScopeRecord, markForRestore = false): void {
    scope.treeRequestGeneration += 1;
    scope.treeAbort?.abort();
    scope.treeAbort = undefined;
    for (const abort of scope.expandedAborts.values()) abort.abort();
    scope.expandedAborts.clear();
    if (!markForRestore) return;
    scope.initialized = false;
    scope.treeLoading = false;
    scope.treeStale = true;
  }

  private cancelTreeRefreshForInteraction(scope: ScopeRecord): void {
    if (scope.treeAbort === undefined) return;
    scope.treeRequestGeneration += 1;
    scope.treeAbort.abort();
    scope.treeAbort = undefined;
    scope.treeLoading = false;
    scope.treeStale = true;
  }

  private cancelExpandedRequest(scope: ScopeRecord, path: string): void {
    scope.expandedAborts.get(path)?.abort();
    scope.expandedAborts.delete(path);
  }

  private cancelSelectedRequest(scope: ScopeRecord): void {
    scope.selectedRequestGeneration += 1;
    scope.selectedAbort?.abort();
    scope.selectedAbort = undefined;
  }

  private async runWorkspaceUpload(
    scope: ScopeRecord,
    files: WorkspaceFilesCapabilityV1,
    filesToUpload: readonly File[],
    batch: WorkspaceUploadBatchState,
    options: StartWorkspaceUploadOptions,
  ): Promise<void> {
    const successful: WriteWorkspaceFileResponse[] = [];
    try {
      for (let index = 0; index < filesToUpload.length; index += 1) {
        if (!this.isLiveUploadingBatch(scope, batch)) break;
        const file = filesToUpload[index];
        const fileState = batch.files[index];
        if (file === undefined || fileState === undefined) continue;
        batch.currentFileIndex = index;
        fileState.status = "uploading";
        this.recalculateUploadProgress(batch);
        this.notify(scope);

        let task: WorkspaceFileUploadTask;
        try {
          task = files.uploadFile(file, {
            destinationFolder: options.destinationFolder,
            createDirs: options.createDirs ?? true,
            overwrite: options.overwrite ?? false,
            onProgress: (progress) => {
              if (!this.isLiveUploadingBatch(scope, batch)) return;
              fileState.loaded = Math.min(progress.loaded, progress.total);
              fileState.total = progress.total;
              fileState.percent = progress.percent;
              fileState.lengthComputable = progress.lengthComputable;
              this.recalculateUploadProgress(batch);
              this.notify(scope);
            },
          });
        } catch (error) {
          this.failUploadFile(batch, fileState, error);
          this.notify(scope);
          continue;
        }
        fileState.path = task.path;
        scope.uploadTasks.set(batch.id, task);
        try {
          const response = await task.completed;
          if (!this.isLiveUploadingBatch(scope, batch)) continue;
          fileState.path = response.path;
          fileState.loaded = fileState.total;
          fileState.percent = 1;
          fileState.lengthComputable = true;
          fileState.status = "completed";
          fileState.response = response;
          delete fileState.error;
          successful.push(response);
        } catch (error) {
          if (scope.cancelledUploads.has(batch.id) || isAbortError(error)) {
            if (scope.uploadBatches[batch.id] === batch) cancelUploadBatch(batch, this.now());
            break;
          }
          this.failUploadFile(batch, fileState, error);
        } finally {
          if (scope.uploadTasks.get(batch.id) === task) scope.uploadTasks.delete(batch.id);
          this.recalculateUploadProgress(batch, batch.status !== "uploading");
          this.notify(scope);
        }
      }

      if (scope.uploadBatches[batch.id] !== batch) return;
      if (batch.status === "cancelled") {
        await this.refreshAfterUploadSuccess(scope, batch, successful, options);
        return;
      }
      const failed = batch.files.filter((file) => file.status === "error");
      batch.status = failed.length === 0 ? "completed" : "error";
      batch.completedAt = this.now();
      if (failed.length === 0) delete batch.error;
      else batch.error = failed.length === 1 ? failed[0]?.error ?? "Workspace upload failed" : `${String(failed.length)} files failed to upload`;
      for (const pending of batch.files.filter((file) => file.status === "pending" || file.status === "uploading")) {
        pending.status = "cancelled";
        pending.error = "Not uploaded.";
      }
      this.recalculateUploadProgress(batch, true);
      this.notify(scope);

      await this.refreshAfterUploadSuccess(scope, batch, successful, options);
    } finally {
      scope.uploadTasks.delete(batch.id);
      scope.cancelledUploads.delete(batch.id);
      this.evictInactiveScopes();
    }
  }

  private async refreshAfterUploadSuccess(
    scope: ScopeRecord,
    batch: WorkspaceUploadBatchState,
    successful: readonly WriteWorkspaceFileResponse[],
    options: StartWorkspaceUploadOptions,
  ): Promise<void> {
    if (successful.length === 0 || scope.uploadBatches[batch.id] !== batch) return;
    const firstPath = successful[0]?.path;
    if (scope.suspended) {
      scope.initialized = false;
      scope.treeStale = true;
      if (options.selectUploadedFile !== false && firstPath !== undefined) {
        scope.context.navigation?.set("file", firstPath);
        this.cancelSelectedRequest(scope);
        scope.selectedFilePath = firstPath;
        delete scope.selectedFileContent;
        delete scope.selectedFileLoadError;
        scope.selectedNeedsRestore = true;
      }
      return;
    }
    await this.refreshFiles(scope.context);
    if (options.selectUploadedFile !== false && firstPath !== undefined && scope.uploadBatches[batch.id] === batch) {
      await this.selectFile(scope.context, firstPath);
    }
  }

  private isLiveUploadingBatch(scope: ScopeRecord, batch: WorkspaceUploadBatchState): boolean {
    return scope.uploadBatches[batch.id] === batch && batch.status === "uploading" && !scope.cancelledUploads.has(batch.id);
  }

  private failUploadFile(batch: WorkspaceUploadBatchState, file: WorkspaceUploadFileState, error: unknown): void {
    file.loaded = file.total;
    file.percent = 1;
    file.lengthComputable = true;
    file.status = "error";
    file.error = errorMessage(error);
  }

  private recalculateUploadProgress(batch: WorkspaceUploadBatchState, terminal = false): void {
    batch.total = batch.files.reduce((sum, file) => sum + file.total, 0);
    batch.loaded = batch.files.reduce((sum, file) => sum + file.loaded, 0);
    batch.percent = terminal ? 1 : percentFor(batch.loaded, batch.total);
  }

  private notify(scope: ScopeRecord): void {
    const snapshot: FilesScopeState = scope;
    for (const listener of [...scope.listeners]) listener(snapshot, scope.context);
    if (scope.listeners.size === 0 && !scope.suspended) scope.context.host.requestRender();
  }

  private evictInactiveScopes(protectedKey?: string): void {
    if (this.scopes.size <= MAX_RECENT_SCOPES) return;
    const candidates = [...this.scopes.values()]
      .filter((scope) => scope.key !== protectedKey && scope.listeners.size === 0 && !hasInFlightUpload(scope))
      .sort((left, right) => left.lastUsed - right.lastUsed);
    while (this.scopes.size > MAX_RECENT_SCOPES) {
      const candidate = candidates.shift();
      if (candidate === undefined) break;
      this.cancelSelectedRequest(candidate);
      this.cancelTreeRequests(candidate);
      this.scopes.delete(candidate.key);
    }
    if (this.scopes.size <= MAX_RECENT_SCOPES) return;
    for (const scope of this.scopes.values()) {
      if (scope.key === protectedKey || scope.listeners.size > 0 || scope.selectedFileContent === undefined) continue;
      delete scope.selectedFileContent;
      scope.selectedNeedsRestore = scope.selectedFilePath !== undefined;
    }
  }
}

export function workspaceFilesCapabilityV1(files: WorkspaceFilesContextValue): WorkspaceFilesCapabilityV1 | undefined {
  return files.capabilityVersion === 1 ? files : undefined;
}

export function workspaceUploadPath(destinationFolder: string, fileName: string): string {
  const folder = normalizeWorkspaceUploadPath(destinationFolder, "upload destination", { allowEmpty: true });
  const name = normalizeWorkspaceUploadPath(fileName, "upload file name", { allowEmpty: false });
  return folder === "" ? name : `${folder}/${name}`;
}

function filesCapabilityError(files: WorkspaceFilesContextValue, navigation: WorkspacePanelNavigationV1 | undefined): string | undefined {
  if (files.capabilityVersion !== 1) return "Files requires workspace-files capability v1. Update the PI WEB host.";
  if (navigation?.version !== 1) return "Files requires contribution navigation v1. Update the PI WEB host.";
  return undefined;
}

function scopeKey(context: WorkspacePanelContext): string {
  return JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
}

function firstQueryString(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function createUploadBatch(
  id: string,
  files: readonly File[],
  destinationFolder: string,
  overwrite: boolean,
  createDirs: boolean,
  startedAt: string,
): WorkspaceUploadBatchState {
  const uploadFiles = files.map((file, index): WorkspaceUploadFileState => ({
    index,
    name: file.name,
    path: workspaceUploadPath(destinationFolder, file.name),
    size: file.size,
    loaded: 0,
    total: file.size,
    percent: percentFor(0, file.size),
    lengthComputable: true,
    status: index === 0 ? "uploading" : "pending",
  }));
  const total = uploadFiles.reduce((sum, file) => sum + file.total, 0);
  return {
    id,
    destinationFolder,
    overwrite,
    createDirs,
    files: uploadFiles,
    currentFileIndex: uploadFiles.length === 0 ? -1 : 0,
    loaded: 0,
    total,
    percent: percentFor(0, total),
    status: "uploading",
    startedAt,
  };
}

function cancelUploadBatch(batch: WorkspaceUploadBatchState, completedAt: string): void {
  batch.status = "cancelled";
  batch.completedAt = completedAt;
  batch.error = "Upload cancelled";
  for (const file of batch.files) {
    if (file.status === "completed" || file.status === "error") continue;
    file.status = "cancelled";
    file.error = "Upload cancelled";
  }
  batch.loaded = batch.total;
  batch.percent = 1;
}

function normalizeWorkspaceUploadPath(value: string, label: string, options: { allowEmpty: boolean }): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    if (options.allowEmpty) return "";
    throw new Error(`${label} must not be empty`);
  }
  const withForwardSlashes = trimmed.replace(/\\/gu, "/");
  if (withForwardSlashes.startsWith("/") || /^[A-Za-z]:\//u.test(withForwardSlashes)) throw new Error(`${label} must be workspace-relative`);
  const parts = withForwardSlashes.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) {
    if (options.allowEmpty) return "";
    throw new Error(`${label} must not be empty`);
  }
  if (parts.some((part) => part === "..")) throw new Error(`${label} must not contain path traversal`);
  return parts.join("/");
}

function hasInFlightUpload(scope: ScopeRecord): boolean {
  return scope.uploadTasks.size > 0
    || Object.values(scope.uploadBatches).some((batch) => batch.status === "uploading");
}

function percentFor(loaded: number, total: number): number {
  if (total <= 0) return loaded <= 0 ? 0 : 1;
  return Math.max(0, Math.min(1, loaded / total));
}

function omitKey<T>(record: Record<string, T>, keyToOmit: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== keyToOmit));
}

function isAbortError(error: unknown): boolean {
  return (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
