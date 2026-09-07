import type { WriteWorkspaceFileOptions, WriteWorkspaceFileResponse } from "../../../shared/apiTypes";
import { parseWriteWorkspaceFileResponse } from "./parsers";
import { workspaceFileWriteUrl } from "./urls";

export const DEFAULT_WORKSPACE_UPLOADS_FOLDER = ".pi-web/uploads";

export interface WorkspaceUploadFileInput {
  path: string;
  file: Blob;
  contentType?: string;
}

export interface WorkspaceFileUploadProgress {
  loaded: number;
  total: number;
  percent: number;
  lengthComputable: boolean;
}

export interface WorkspaceUploadTask<T> {
  promise: Promise<T>;
  cancel(): void;
}

export interface WorkspaceUploadXhr {
  upload: { onprogress: ((event: ProgressEvent) => void) | null };
  responseType: XMLHttpRequestResponseType;
  response: unknown;
  responseText: string;
  status: number;
  statusText: string;
  onload: ((event: ProgressEvent) => void) | null;
  onerror: ((event: ProgressEvent) => void) | null;
  onabort: ((event: ProgressEvent) => void) | null;
  open(method: string, url: string, async?: boolean): void;
  setRequestHeader(name: string, value: string): void;
  send(body?: XMLHttpRequestBodyInit | Document | null): void;
  abort(): void;
}

export type WorkspaceUploadXhrFactory = () => WorkspaceUploadXhr;

export interface UploadWorkspaceFileOptions extends WriteWorkspaceFileOptions {
  machineId?: string;
  xhrFactory?: WorkspaceUploadXhrFactory;
  onProgress?: (progress: WorkspaceFileUploadProgress) => void;
}

export class WorkspaceUploadCancelledError extends Error {
  constructor(message = "Workspace upload cancelled") {
    super(message);
    this.name = "WorkspaceUploadCancelledError";
  }
}

export interface WorkspaceUploadFolderConfig {
  uploads?: {
    defaultFolder?: string;
  };
}

export function effectiveWorkspaceUploadFolder(config: WorkspaceUploadFolderConfig | undefined): string {
  return config?.uploads?.defaultFolder ?? DEFAULT_WORKSPACE_UPLOADS_FOLDER;
}

export function workspaceEffectiveUploadFolder(config: WorkspaceUploadFolderConfig, fallbackFolder: string): string {
  return config.uploads?.defaultFolder ?? fallbackFolder;
}

export function workspaceUploadPath(destinationFolder: string, fileName: string): string {
  const folder = normalizeWorkspaceUploadPath(destinationFolder, "upload destination", { allowEmpty: true });
  const name = normalizeWorkspaceUploadPath(fileName, "upload file name", { allowEmpty: false });
  return folder === "" ? name : `${folder}/${name}`;
}

export function uploadWorkspaceFile(
  projectId: string,
  workspaceId: string,
  input: WorkspaceUploadFileInput,
  options: UploadWorkspaceFileOptions = {},
): WorkspaceUploadTask<WriteWorkspaceFileResponse> {
  const xhr: WorkspaceUploadXhr = options.xhrFactory?.() ?? new XMLHttpRequest();
  let settled = false;
  let cancelled = false;

  const promise = new Promise<WriteWorkspaceFileResponse>((resolve, reject) => {
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = (response: WriteWorkspaceFileResponse) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    xhr.open("PUT", workspaceFileWriteUrl(projectId, workspaceId, input.path, uploadWriteUrlOptions(options)), true);
    xhr.responseType = "json";
    xhr.setRequestHeader("Content-Type", (input.contentType ?? input.file.type) || "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      options.onProgress?.(progressFromEvent(event, input.file.size));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          options.onProgress?.({ loaded: input.file.size, total: input.file.size, percent: 1, lengthComputable: true });
          succeed(parseWriteWorkspaceFileResponse(readXhrJson(xhr)));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      fail(new Error(readXhrErrorMessage(xhr)));
    };
    xhr.onerror = () => { fail(new Error("Workspace upload failed")); };
    xhr.onabort = () => { fail(new WorkspaceUploadCancelledError(cancelled ? undefined : "Workspace upload aborted")); };
    xhr.send(input.file);
  });

  return {
    promise,
    cancel: () => {
      if (settled) return;
      cancelled = true;
      xhr.abort();
    },
  };
}

function uploadWriteUrlOptions(options: UploadWorkspaceFileOptions): { createDirs?: boolean; overwrite?: boolean; machineId?: string } {
  return {
    ...(options.createDirs === undefined ? {} : { createDirs: options.createDirs }),
    ...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
    ...(options.machineId === undefined ? {} : { machineId: options.machineId }),
  };
}

function progressFromEvent(event: ProgressEvent, fallbackTotal: number): WorkspaceFileUploadProgress {
  const total = event.lengthComputable ? event.total : fallbackTotal;
  return {
    loaded: event.loaded,
    total,
    percent: percentFor(event.loaded, total),
    lengthComputable: event.lengthComputable,
  };
}

function percentFor(loaded: number, total: number): number {
  if (total <= 0) return loaded <= 0 ? 0 : 1;
  return Math.max(0, Math.min(1, loaded / total));
}

function normalizeWorkspaceUploadPath(value: string, label: string, options: { allowEmpty: boolean }): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    if (options.allowEmpty) return "";
    throw new Error(`${label} must not be empty`);
  }
  if (isAbsoluteLike(trimmed)) throw new Error(`${label} must be workspace-relative`);
  const parts = trimmed.split(/[\\/]+/u).filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) {
    if (options.allowEmpty) return "";
    throw new Error(`${label} must not be empty`);
  }
  if (parts.some((part) => part === "..")) throw new Error(`${label} must not contain path traversal`);
  return parts.join("/");
}

function isAbsoluteLike(value: string): boolean {
  const withForwardSlashes = value.replace(/\\/g, "/");
  return withForwardSlashes.startsWith("/") || /^[A-Za-z]:\//u.test(withForwardSlashes);
}

function readXhrJson(xhr: WorkspaceUploadXhr): unknown {
  if (xhr.response !== undefined && xhr.response !== null && xhr.response !== "") return xhr.response;
  if (xhr.responseText === "") return {};
  const parsed: unknown = JSON.parse(xhr.responseText);
  return parsed;
}

function readXhrErrorMessage(xhr: WorkspaceUploadXhr): string {
  const body = safeReadXhrJson(xhr);
  if (isRecord(body) && typeof body["error"] === "string") return body["error"];
  return xhr.statusText || `HTTP ${String(xhr.status)}`;
}

function safeReadXhrJson(xhr: WorkspaceUploadXhr): unknown {
  try {
    return readXhrJson(xhr);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
