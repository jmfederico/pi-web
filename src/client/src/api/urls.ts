import type { SessionRef } from "../../../shared/apiTypes";
import { resolveAppUrl } from "../appUrl";

type SessionLookup = SessionRef | string;

function sessionId(session: SessionLookup): string {
  return typeof session === "string" ? session : session.id;
}

function sessionCwd(session: SessionLookup): string | undefined {
  return typeof session === "string" ? undefined : session.cwd;
}

export function messagePath(session: SessionLookup, options?: { limit?: number; before?: number }, machineId = "local"): string {
  const params = new URLSearchParams();
  const cwd = sessionCwd(session);
  if (cwd !== undefined && cwd !== "") params.set("cwd", cwd);
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.before !== undefined) params.set("before", String(options.before));
  const query = params.toString();
  return `api/machines/${encodeURIComponent(machineId)}/sessions/${encodeURIComponent(sessionId(session))}/messages${query === "" ? "" : `?${query}`}`;
}

export function workspaceFileWriteUrl(projectId: string, workspaceId: string, path: string, options?: { createDirs?: boolean; overwrite?: boolean; machineId?: string }): string {
  const params = new URLSearchParams({ path });
  if (options?.createDirs === false) params.set("createDirs", "false");
  if (options?.overwrite === false) params.set("overwrite", "false");
  const prefix = `api/machines/${encodeURIComponent(options?.machineId ?? "local")}`;
  return resolveAppUrl(`${prefix}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/file?${params.toString()}`);
}

export interface WorkspaceFilePreviewUrlOptions {
  modifiedAt?: string;
  machineId?: string;
  download?: boolean;
}

export function workspaceFilePreviewPath(projectId: string, workspaceId: string, path: string, options?: WorkspaceFilePreviewUrlOptions): string {
  const params = new URLSearchParams();
  params.set("path", path);
  if (options?.modifiedAt !== undefined) params.set("v", options.modifiedAt);
  if (options?.download === true) params.set("download", "1");
  const prefix = `api/machines/${encodeURIComponent(options?.machineId ?? "local")}`;
  return `${prefix}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/file/preview?${params.toString()}`;
}

export function workspaceFilePreviewUrl(projectId: string, workspaceId: string, path: string, options?: WorkspaceFilePreviewUrlOptions): string {
  return resolveAppUrl(workspaceFilePreviewPath(projectId, workspaceId, path, options));
}
