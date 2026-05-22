export function gitDiffUrl(projectId: string, workspaceId: string, options?: { path?: string; staged?: boolean }): string {
  const params = new URLSearchParams();
  if (options?.path !== undefined) params.set("path", options.path);
  if (options?.staged === true) params.set("staged", "true");
  const query = params.toString();
  return `/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/git/diff${query ? `?${query}` : ""}`;
}

export function messageUrl(sessionId: string, options?: { limit?: number; before?: number }): string {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.before !== undefined) params.set("before", String(options.before));
  const query = params.toString();
  return `/api/sessions/${sessionId}/messages${query ? `?${query}` : ""}`;
}

export function workspaceImagePreviewUrl(projectId: string, workspaceId: string, path: string, options?: { modifiedAt?: string }): string {
  const params = new URLSearchParams();
  params.set("path", path);
  if (options?.modifiedAt !== undefined) params.set("v", options.modifiedAt);
  return `/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/file/preview?${params.toString()}`;
}
