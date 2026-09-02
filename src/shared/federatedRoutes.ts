import {
  PLUGIN_BACKEND_FEDERATION_TIMEOUT_MS,
  PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES,
  PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES,
} from "./pluginBackendProtocol.js";
import { WORKSPACE_REMOVAL_FEDERATION_TIMEOUT_MS } from "./workspaceRemovalProtocol.js";
import { MAX_INLINE_PREVIEW_BYTES } from "./workspaceFiles.js";

export { PLUGIN_BACKEND_FEDERATION_TIMEOUT_MS } from "./pluginBackendProtocol.js";
export { WORKSPACE_REMOVAL_FEDERATION_TIMEOUT_MS } from "./workspaceRemovalProtocol.js";

export type FederatedHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export const PI_PACKAGE_MUTATION_PROXY_TIMEOUT_MS = 5 * 60_000;
export const SESSION_TREE_NAVIGATION_PROXY_TIMEOUT_MS = 5 * 60_000;
export const SESSION_TREE_FORK_PROXY_TIMEOUT_MS = 5 * 60_000;
export const WORKSPACE_FILE_FEDERATION_TIMEOUT_MS = 30_000;
// Accommodates the bounded 1,000-entry tree and escaped paths/content while
// keeping every workspace-file JSON hop finite after response headers.
export const WORKSPACE_FILE_JSON_RESPONSE_BODY_MAX_BYTES = 32 * 1024 * 1024;
export const WORKSPACE_FILE_PREVIEW_ROUTE_PATH = "/projects/:projectId/workspaces/:workspaceId/file/preview";

export interface FederatedHttpRouteSpec {
  method: FederatedHttpMethod;
  path: string;
  timeoutMs?: number;
  bodyLimit?: number;
  /**
   * Bound the proxied response body. The workspace file preview route applies
   * it to inline previews only, because attachment downloads are intentionally
   * uncapped on both the local and remote paths.
   */
  responseBodyLimit?: number;
  /** Propagate an inbound disconnect through the remote request. */
  propagateCancellation?: boolean;
}

export const FEDERATED_HTTP_ROUTES = [
  { method: "GET", path: "/pi-web/status" },
  { method: "GET", path: "/config" },
  { method: "PUT", path: "/config" },
  { method: "GET", path: "/plugins" },
  { method: "GET", path: "/pi-packages" },
  { method: "POST", path: "/pi-packages/install", timeoutMs: PI_PACKAGE_MUTATION_PROXY_TIMEOUT_MS },
  { method: "POST", path: "/pi-packages/remove", timeoutMs: PI_PACKAGE_MUTATION_PROXY_TIMEOUT_MS },
  { method: "POST", path: "/pi-packages/update", timeoutMs: PI_PACKAGE_MUTATION_PROXY_TIMEOUT_MS },
  { method: "GET", path: "/projects" },
  { method: "POST", path: "/projects" },
  { method: "DELETE", path: "/projects/:projectId" },
  { method: "GET", path: "/project-directories" },
  { method: "GET", path: "/projects/:projectId/workspaces" },
  {
    method: "POST",
    path: "/plugin-backends/:pluginId/projects/:projectId/workspaces/:workspaceId/:operation",
    timeoutMs: PLUGIN_BACKEND_FEDERATION_TIMEOUT_MS,
    bodyLimit: PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES,
    responseBodyLimit: PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES,
  },
  {
    method: "DELETE",
    path: "/projects/:projectId/workspaces/:workspaceId",
    timeoutMs: WORKSPACE_REMOVAL_FEDERATION_TIMEOUT_MS,
    propagateCancellation: true,
  },
  {
    method: "GET",
    path: "/projects/:projectId/workspaces/:workspaceId/tree",
    timeoutMs: WORKSPACE_FILE_FEDERATION_TIMEOUT_MS,
    responseBodyLimit: WORKSPACE_FILE_JSON_RESPONSE_BODY_MAX_BYTES,
    propagateCancellation: true,
  },
  {
    method: "GET",
    path: "/projects/:projectId/workspaces/:workspaceId/file",
    timeoutMs: WORKSPACE_FILE_FEDERATION_TIMEOUT_MS,
    responseBodyLimit: WORKSPACE_FILE_JSON_RESPONSE_BODY_MAX_BYTES,
    propagateCancellation: true,
  },
  {
    method: "PUT",
    path: "/projects/:projectId/workspaces/:workspaceId/file",
    timeoutMs: WORKSPACE_FILE_FEDERATION_TIMEOUT_MS,
    responseBodyLimit: WORKSPACE_FILE_JSON_RESPONSE_BODY_MAX_BYTES,
    propagateCancellation: true,
  },
  {
    method: "DELETE",
    path: "/projects/:projectId/workspaces/:workspaceId/file",
    timeoutMs: WORKSPACE_FILE_FEDERATION_TIMEOUT_MS,
    responseBodyLimit: WORKSPACE_FILE_JSON_RESPONSE_BODY_MAX_BYTES,
    propagateCancellation: true,
  },
  {
    method: "POST",
    path: "/projects/:projectId/workspaces/:workspaceId/file/move",
    timeoutMs: WORKSPACE_FILE_FEDERATION_TIMEOUT_MS,
    responseBodyLimit: WORKSPACE_FILE_JSON_RESPONSE_BODY_MAX_BYTES,
    propagateCancellation: true,
  },
  {
    method: "GET",
    path: WORKSPACE_FILE_PREVIEW_ROUTE_PATH,
    responseBodyLimit: MAX_INLINE_PREVIEW_BYTES,
    propagateCancellation: true,
  },
  { method: "GET", path: "/projects/:projectId/workspaces/:workspaceId/files" },
  // Path-driven existing-decision lookup for the add-project dialog; the
  // server resolves the path before reading through ProjectTrustStore.
  { method: "GET", path: "/projects/trust" },
  { method: "GET", path: "/projects/:projectId/workspaces/:workspaceId/trust" },
  { method: "PUT", path: "/projects/:projectId/workspaces/:workspaceId/trust" },
  { method: "GET", path: "/projects/:projectId/workspaces/:workspaceId/terminals" },
  { method: "POST", path: "/projects/:projectId/workspaces/:workspaceId/terminals" },
  { method: "DELETE", path: "/projects/:projectId/workspaces/:workspaceId/terminals" },
  { method: "POST", path: "/projects/:projectId/workspaces/:workspaceId/terminals/:terminalId/continue" },
  { method: "DELETE", path: "/projects/:projectId/workspaces/:workspaceId/terminals/:terminalId" },
  { method: "POST", path: "/projects/:projectId/workspaces/:workspaceId/terminal-command-runs" },
  { method: "GET", path: "/terminal-command-runs" },
  { method: "GET", path: "/terminal-command-runs/:runId" },
  { method: "POST", path: "/terminal-command-runs/:runId/cancel" },
  { method: "GET", path: "/status" },
  { method: "GET", path: "/notices" },
  { method: "POST", path: "/notices/dismiss" },
  { method: "GET", path: "/sessions" },
  { method: "POST", path: "/sessions" },
  { method: "GET", path: "/sessions/unread" },
  { method: "GET", path: "/sessions/notifications" },
  { method: "POST", path: "/sessions/cleanup/preview" },
  { method: "POST", path: "/sessions/cleanup" },
  { method: "POST", path: "/sessions/bulk/archive" },
  { method: "POST", path: "/sessions/bulk/delete-archived" },
  { method: "GET", path: "/sessions/:sessionId/messages" },
  { method: "GET", path: "/sessions/:sessionId/notifications" },
  { method: "POST", path: "/sessions/:sessionId/notifications/dismiss" },
  { method: "POST", path: "/sessions/:sessionId/notifications/dismiss-all" },
  { method: "POST", path: "/sessions/:sessionId/unread/acknowledge" },
  { method: "GET", path: "/sessions/:sessionId/status" },
  { method: "GET", path: "/sessions/:sessionId/stream-snapshot" },
  { method: "GET", path: "/sessions/:sessionId/models" },
  { method: "GET", path: "/sessions/:sessionId/models/catalog" },
  { method: "POST", path: "/sessions/:sessionId/models/enabled" },
  { method: "POST", path: "/sessions/:sessionId/models/scope" },
  { method: "POST", path: "/sessions/:sessionId/model" },
  { method: "POST", path: "/sessions/:sessionId/model/cycle" },
  { method: "GET", path: "/sessions/:sessionId/thinking-levels" },
  { method: "POST", path: "/sessions/:sessionId/thinking-level" },
  { method: "POST", path: "/sessions/:sessionId/thinking-level/cycle" },
  { method: "GET", path: "/sessions/:sessionId/commands" },
  { method: "POST", path: "/sessions/:sessionId/prompt" },
  { method: "POST", path: "/sessions/:sessionId/queue/clear" },
  { method: "POST", path: "/sessions/:sessionId/ask/submit" },
  { method: "POST", path: "/sessions/:sessionId/ask/cancel" },
  { method: "POST", path: "/sessions/:sessionId/dialogs/answer" },
  { method: "POST", path: "/sessions/:sessionId/dialogs/cancel" },
  { method: "POST", path: "/sessions/:sessionId/warnings/dismiss" },
  { method: "POST", path: "/sessions/:sessionId/attachments" },
  { method: "POST", path: "/sessions/:sessionId/shell" },
  { method: "POST", path: "/sessions/:sessionId/commands/run" },
  { method: "POST", path: "/sessions/:sessionId/commands/respond" },
  { method: "POST", path: "/sessions/:sessionId/tree/navigate", timeoutMs: SESSION_TREE_NAVIGATION_PROXY_TIMEOUT_MS },
  { method: "POST", path: "/sessions/:sessionId/tree/fork", timeoutMs: SESSION_TREE_FORK_PROXY_TIMEOUT_MS },
  { method: "POST", path: "/sessions/:sessionId/abort" },
  { method: "POST", path: "/sessions/:sessionId/stop" },
  { method: "POST", path: "/sessions/:sessionId/archive" },
  { method: "POST", path: "/sessions/:sessionId/archive-tree" },
  { method: "POST", path: "/sessions/:sessionId/restore" },
  { method: "POST", path: "/sessions/:sessionId/reload" },
  { method: "POST", path: "/sessions/:sessionId/detach-parent" },
  { method: "GET", path: "/auth/providers" },
  { method: "POST", path: "/auth/api-key/interactive" },
  { method: "POST", path: "/auth/logout" },
  { method: "POST", path: "/auth/oauth" },
  { method: "GET", path: "/auth/oauth/:flowId" },
  { method: "POST", path: "/auth/oauth/:flowId/respond" },
  { method: "POST", path: "/auth/oauth/:flowId/cancel" },
] as const satisfies readonly FederatedHttpRouteSpec[];

export const FEDERATED_WEBSOCKET_ROUTES = [
  "/events",
  "/sessions/events",
  "/sessions/:sessionId/events",
  "/projects/:projectId/workspaces/:workspaceId/terminals/:terminalId/socket",
] as const satisfies readonly string[];
