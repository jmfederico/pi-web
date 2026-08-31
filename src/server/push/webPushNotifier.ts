import type { SessionUiEvent } from "../../shared/apiTypes.js";
import type { PushSubscriptionStore, PushSubscriptionRecord } from "./pushSubscriptionStore.js";

/** One OS-level notification to render; the service worker owns presentation. */
export interface PushNotificationMessage {
  readonly title: string;
  readonly body: string;
  /** Discriminator so future UI can style kinds differently (icon, priority). */
  readonly kind: "message" | "error";
}

/** Delivers one payload to one stored subscription. Rejects with an error carrying `statusCode` for push-service HTTP failures. */
export type PushSender = (subscription: Pick<PushSubscriptionRecord, "endpoint"> & { expirationTime?: number | null; keys: Readonly<Record<string, string>> }, payload: string) => Promise<void>;

/** Minimal event source seam — satisfied by SessionEventHub.subscribe. */
export interface PushEventSource {
  subscribe(listener: (sessionId: string, event: SessionUiEvent) => void): () => void;
}

const PUSH_NOTIFICATION_TITLE = "PI WEB";
export const PUSH_NOTIFICATION_BODY_MAX_CHARS = 200;
/** Minimum gap between pushes for one session so tool-heavy turns coalesce instead of spamming. */
export const DEFAULT_PUSH_COOLDOWN_MS = 30_000;

export interface WebPushNotifierOptions {
  /** All stored push targets; entries are removed here when the push service reports them gone (404/410). */
  readonly subscriptions: Pick<PushSubscriptionStore, "list" | "remove">;
  readonly cooldownMs?: number | undefined;
  /** Clock seam for deterministic cooldown behavior. */
  readonly now?: (() => number) | undefined;
  /** Failure sink: delivery problems must be observable but never throw back into the hub publish path. */
  readonly onError?: ((message: string) => void) | undefined;
  /**
   * Session cwd lookup carried in the payload so the browser can resolve the notification into a
   * full route (the client joins cwd against its workspace paths); best-effort: an undefined cwd
   * degrades the deep link to app focus, exactly like the pre-cwd behavior.
   */
  readonly resolveCwd?: ((sessionId: string) => string | undefined) | undefined;
  /**
   * Canonical route ids for a cwd (project + main-workspace identity), computed daemon-side so the
   * service worker can build the same deep link a browser link uses (`?project=&workspace=&session=&view=chat`)
   * without client-side guessing. Best-effort: undefined falls back to the cwd join in the client.
   */
  readonly resolveDeepLink?: ((cwd: string) => Promise<SessionDeepLinkTarget | undefined> | SessionDeepLinkTarget | undefined) | undefined;
}

/** Project/workspace identity a notification deep link should route into. */
export interface SessionDeepLinkTarget {
  readonly projectId: string;
  readonly workspaceId: string;
}

/**
 * Watches session events and delivers Web Push notifications for assistant message completions
 * and session errors to every stored subscription. Delivery is fire-and-forget with internal
 * error translation, so a slow or failing push service cannot interrupt realtime socket delivery
 * on the same hub path.
 */
export class WebPushNotifier {
  private readonly subscriptions: Pick<PushSubscriptionStore, "list" | "remove">;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly onError: (message: string) => void;
  private readonly resolveCwd: ((sessionId: string) => string | undefined) | undefined;
  private readonly resolveDeepLink: ((cwd: string) => Promise<SessionDeepLinkTarget | undefined> | SessionDeepLinkTarget | undefined) | undefined;
  /** Bounded in practice by the session count of one daemon lifetime. */
  private lastSentAtBySession = new Map<string, number>();

  constructor(readonly send: PushSender, options: WebPushNotifierOptions) {
    this.subscriptions = options.subscriptions;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_PUSH_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
    this.resolveCwd = options.resolveCwd;
    this.resolveDeepLink = options.resolveDeepLink;
  }

  /** Subscribe this notifier to a session event source. Returns the unsubscribe function for teardown and tests. */
  subscribeToEvents(source: PushEventSource): () => void {
    return source.subscribe((sessionId, event) => {
      // onSessionEvent is synchronous; the async work it schedules never rejects (see deliver).
      this.onSessionEvent(sessionId, event);
    });
  }

  /** Synchronous decision point on the hub publish path: filter, cooldown, then schedule delivery. */
  onSessionEvent(sessionId: string, event: SessionUiEvent): void {
    const message = pushMessageForSessionEvent(event);
    if (message === undefined) return;
    const now = this.now();
    const lastSentAt = this.lastSentAtBySession.get(sessionId) ?? Number.NEGATIVE_INFINITY;
    if (now - lastSentAt < this.cooldownMs) return;
    // Stamp before the async work so bursts in flight coalesce too.
    this.lastSentAtBySession.set(sessionId, now);
    void this.deliver(message, sessionId);
  }

  private async deliver(message: PushNotificationMessage, sessionId: string): Promise<void> {
    const cwd = this.resolveCwd?.(sessionId);
    let deepLink: SessionDeepLinkTarget | undefined;
    if (cwd !== undefined && this.resolveDeepLink !== undefined) {
      try {
        deepLink = await this.resolveDeepLink(cwd);
      } catch {
        deepLink = undefined; // A broken resolver must degrade the link, never block delivery.
      }
    }
    const payload = JSON.stringify({ title: message.title, body: message.body, data: { kind: message.kind, sessionId, cwd, projectId: deepLink?.projectId, workspaceId: deepLink?.workspaceId } });
    const subscriptions = this.subscriptions.list();
    if (subscriptions.length === 0) return;
    // The map callback converts synchronous sender throws into rejections too: this notifier must never
    // reject into the realtime path, whatever the injected sender does.
    const outcomes = await Promise.allSettled(
      subscriptions.map((subscription) => {
        try {
          return this.send(subscription, payload);
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
    );
    let removedExpired = 0;
    let otherFailures = 0;
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status !== "rejected") continue;
      const status = statusCodeOf(outcome.reason);
      const subscription = subscriptions[index];
      // Expired endpoints are permanent: drop the dead subscription instead of retrying it forever.
      if (status === 404 || status === 410) {
        if (subscription !== undefined) this.subscriptions.remove(subscription.endpoint);
        removedExpired += 1;
      } else {
        otherFailures += 1;
      }
    }
    // Expected cleanup is reported, but not as a delivery failure.
    if (removedExpired > 0) this.onError(`removed ${String(removedExpired)} expired push subscription(s)`);
    if (otherFailures > 0) this.onError(`web push delivery failed for ${String(otherFailures)} of ${String(subscriptions.length)} subscriptions`);
  }
}

/**
 * Decide which session events deserve an OS push and what to say in it.
 * Notified: assistant message completions with visible text, and session errors.
 * Everything else (deltas, tool churn, status updates) is deliberately silent.
 */
export function pushMessageForSessionEvent(event: SessionUiEvent): PushNotificationMessage | undefined {
  if (event.type === "message.end") {
    const text = assistantTextOf(event.message);
    return text === undefined ? undefined : { title: PUSH_NOTIFICATION_TITLE, body: truncateForPush(text), kind: "message" };
  }
  if (event.type === "session.error") {
    return event.message.trim() === ""
      ? { title: PUSH_NOTIFICATION_TITLE, body: "Session error", kind: "error" }
      : { title: PUSH_NOTIFICATION_TITLE, body: truncateForPush(event.message), kind: "error" };
  }
  return undefined;
}

/** Extract the visible text of an assistant completion from a structurally-typed runtime message. */
function assistantTextOf(message: unknown): string | undefined {
  if (!isRecord(message) || message["role"] !== "assistant") return undefined;
  const content = message["content"];
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (isRecord(part) && part["type"] === "text" && typeof part["text"] === "string") parts.push(part["text"]);
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  return joined === "" ? undefined : joined;
}

/** Collapse whitespace and bound length for a one-line notification body. */
export function truncateForPush(text: string, maxChars: number = PUSH_NOTIFICATION_BODY_MAX_CHARS): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  const cut = normalized.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  // Avoid chopping a word when there is a clean break in the second half of the budget.
  const end = lastSpace > Math.floor(maxChars / 2) ? lastSpace : maxChars;
  return `${normalized.slice(0, end).trimEnd()}…`;
}

function statusCodeOf(reason: unknown): number | undefined {
  if (isRecord(reason) && typeof reason["statusCode"] === "number") return reason["statusCode"];
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
