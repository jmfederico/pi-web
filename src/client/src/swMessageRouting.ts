/**
 * In-app routing for service-worker messages. Today this is the push-notification deep link:
 * the worker asks a running app window to open a session instead of reloading it via
 * `Client.navigate()`. The handler acks through the message source so the worker can detect
 * pages that predate this handler and fall back to navigation for them.
 */

export const OPEN_SESSION_MESSAGE_TYPE = "pi-web:open-session";
export const OPEN_SESSION_ACK_MESSAGE_TYPE = `${OPEN_SESSION_MESSAGE_TYPE}-ack`;

/** Structural view of the service-worker message fields this handler uses. */
export interface ServiceWorkerMessageLike {
  readonly data: unknown;
  readonly source?: { postMessage(message: unknown): void } | null | undefined;
}

/** Where a notification click wants the app to navigate: the session plus whatever route ids the daemon resolved. */
export interface NotifiedSessionTarget {
  readonly sessionId: string;
  readonly cwd: string | undefined;
  /** Canonical route ids from the daemon; when absent the app falls back to the cwd join. */
  readonly projectId: string | undefined;
  readonly workspaceId: string | undefined;
}

/**
 * Handle one incoming message; returns whether it was an open-session request. On a request the
 * ack is posted back first (best-effort via the message source, which is the sending worker),
 * then `openSession` runs with the session target.
 */
export function handleServiceWorkerSessionMessage(message: ServiceWorkerMessageLike, openSession: (target: NotifiedSessionTarget) => void): boolean {
  const data = message.data;
  if (typeof data !== "object" || data === null) return false;
  if (!("type" in data) || data.type !== OPEN_SESSION_MESSAGE_TYPE) return false;
  if (!("sessionId" in data)) return false;
  const sessionId = data.sessionId;
  if (typeof sessionId !== "string" || sessionId === "") return false;
  const cwdValue = "cwd" in data ? data.cwd : undefined;
  const cwd = typeof cwdValue === "string" && cwdValue !== "" ? cwdValue : undefined;
  const projectIdValue = "projectId" in data ? data.projectId : undefined;
  const projectId = typeof projectIdValue === "string" && projectIdValue !== "" ? projectIdValue : undefined;
  const workspaceIdValue = "workspaceId" in data ? data.workspaceId : undefined;
  const workspaceId = typeof workspaceIdValue === "string" && workspaceIdValue !== "" ? workspaceIdValue : undefined;
  const requestId = "requestId" in data ? data.requestId : undefined;
  message.source?.postMessage({ type: OPEN_SESSION_ACK_MESSAGE_TYPE, requestId });
  openSession({ sessionId, cwd, projectId, workspaceId });
  return true;
}
