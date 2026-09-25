import { createHash } from "node:crypto";

/**
 * Stable workspace identity: `sha1("<projectId>:<providerKey>")` truncated to 12 hex chars.
 * The provider key is the project path for a project's main workspace and the provider
 * candidate key for contributed workspaces. Extracted from the provider registry because the
 * push notifier derives deep-link workspace ids from a plain cwd without loading providers.
 */
export function workspaceIdFor(projectId: string, providerKey: string): string {
  return createHash("sha1").update(`${projectId}:${providerKey}`).digest("hex").slice(0, 12);
}
