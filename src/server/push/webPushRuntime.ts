import type { FastifyBaseLogger } from "fastify";
import type { PiWebPushConfig } from "../../shared/apiTypes.js";
import type { PiWebConfig } from "../../config.js";
import webPushModule from "web-push";
import type { PushSubscriptionStore } from "./pushSubscriptionStore.js";
import { WebPushNotifier } from "./webPushNotifier.js";

/** Daemon-side web push state: subscription store plus (when VAPID is configured) a live notifier. */
export interface WebPushRuntime {
  readonly configured: boolean;
  /** Base64url VAPID public key for clients, present exactly when `configured`. */
  readonly publicKey?: string | undefined;
  readonly store: PushSubscriptionStore;
}

/** All three fields non-empty — push stays off until the operator supplied a complete credential set. Typed as a guard so callers narrow without assertions. */
export function isCompleteVapidConfig(push: PiWebPushConfig | undefined): push is Required<PiWebPushConfig> {
  const publicKey = push?.vapidPublicKey;
  const privateKey = push?.vapidPrivateKey;
  const subject = push?.subjectEmail;
  return (
    typeof publicKey === "string" &&
    publicKey !== "" &&
    typeof privateKey === "string" &&
    privateKey !== "" &&
    typeof subject === "string" &&
    subject !== ""
  );
}

/** web-push requires the VAPID contact claim to be an https URL or mailto: address; fail fast on startup instead of per send. */
export function isUsableVapidSubject(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "mailto:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Wire the web push notifier to the session event hub, or report why push stays disabled.
 * The subscription store is always returned (and already loaded by the caller) so subscriptions
 * survive a restart that happens before credentials are configured.
 */
export function createWebPushRuntime(options: {
  readonly config: Pick<PiWebConfig, "push">;
  readonly store: PushSubscriptionStore;
  /** Structural seam satisfied by SessionEventHub.subscribe — keeps this module hub-agnostic for tests. */
  readonly eventHub: import("./webPushNotifier.js").PushEventSource;
  readonly logger: FastifyBaseLogger;
  /** Best-effort session cwd lookup for notification deep-link routes (see WebPushNotifierOptions.resolveCwd). */
  readonly resolveSessionCwd?: ((sessionId: string) => string | undefined) | undefined;
  /** Best-effort cwd → canonical route ids for deep links (see WebPushNotifierOptions.resolveDeepLink). */
  readonly resolveDeepLink?: ((cwd: string) => Promise<import("./webPushNotifier.js").SessionDeepLinkTarget | undefined> | import("./webPushNotifier.js").SessionDeepLinkTarget | undefined) | undefined;
}): WebPushRuntime {
  const push = options.config.push;
  if (!isCompleteVapidConfig(push)) {
    // Inert by design, not an error: deployments without VAPID credentials simply run without push.
    options.logger.info("web push disabled: configure push.vapidPublicKey, push.vapidPrivateKey and push.subjectEmail (or PI_WEB_PUSH_VAPID_* env vars) to enable it");
    return { configured: false, store: options.store };
  }
  const publicKey = push.vapidPublicKey;
  const privateKey = push.vapidPrivateKey;
  const subject = push.subjectEmail;
  if (!isUsableVapidSubject(subject)) {
    // A malformed contact claim would fail every single send; refuse to arm the notifier at all.
    options.logger.warn(`web push disabled: push.subjectEmail must be an https URL or mailto address, got ${subject}`);
    return { configured: false, store: options.store };
  }

  const notifier = new WebPushNotifier(
    // `.then(() => undefined)` keeps the PushSender contract Promise<void>; delivery results are unused.
    (subscription, payload) =>
      webPushModule.sendNotification(subscription, payload, { vapidDetails: { subject, publicKey, privateKey } }).then(() => undefined),
    {
      subscriptions: options.store,
      resolveCwd: options.resolveSessionCwd,
      resolveDeepLink: options.resolveDeepLink,
      onError: (message) => {
        // Delivery problems must be observable in daemon logs without affecting the realtime path.
        options.logger.warn(message);
      },
    },
  );
  // Process-lifetime binding like the other hub consumers; the notifier dies with the daemon.
  notifier.subscribeToEvents(options.eventHub);
  return { configured: true, publicKey, store: options.store };
}
