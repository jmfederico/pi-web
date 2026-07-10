import webPush from "web-push";
import type { PiWebConfig } from "../../config.js";
import type { PushSubscriptionRecord, PushSubscriptionStore } from "./pushSubscriptionStore.js";

interface VapidDetails {
  publicKey: string;
  privateKey: string;
  contact: string;
}

function vapidDetailsFromConfig(config: PiWebConfig): VapidDetails | undefined {
  const { vapidPublicKey: publicKey, vapidPrivateKey: privateKey, vapidContact: contact } = config;
  if (publicKey === undefined || publicKey === "" || privateKey === undefined || privateKey === "" || contact === undefined || contact === "") return undefined;
  return { publicKey, privateKey, contact };
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  sessionId: string;
  machineId: string;
  cwd?: string;
}

export interface PushServiceLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

const noopLogger: PushServiceLogger = { warn() { /* no-op */ } };

export interface PushServiceDependencies {
  /** Injection seam for tests; defaults to the real `web-push` module. */
  webPush?: Pick<typeof webPush, "setVapidDetails" | "sendNotification">;
  logger?: PushServiceLogger;
}

/**
 * Sends Web Push notifications to all stored subscriptions. Best-effort:
 * every failure is caught and logged, never thrown, so a push failure never
 * disrupts the agent-completion flow that triggers it.
 */
export class PushService {
  private readonly webPush: Pick<typeof webPush, "setVapidDetails" | "sendNotification">;
  private readonly logger: PushServiceLogger;
  private readonly vapid: VapidDetails | undefined;

  constructor(config: PiWebConfig, private readonly store: Pick<PushSubscriptionStore, "list" | "remove">, deps: PushServiceDependencies = {}) {
    this.webPush = deps.webPush ?? webPush;
    this.logger = deps.logger ?? noopLogger;
    this.vapid = vapidDetailsFromConfig(config);
    if (this.vapid !== undefined) this.webPush.setVapidDetails(this.vapid.contact, this.vapid.publicKey, this.vapid.privateKey);
  }

  isEnabled(): boolean {
    return this.vapid !== undefined;
  }

  vapidPublicKey(): string | undefined {
    return this.vapid?.publicKey;
  }

  async send(payload: PushNotificationPayload): Promise<void> {
    if (!this.isEnabled()) return;
    const subscriptions = await this.store.list();
    await Promise.all(subscriptions.map((subscription) => this.sendToSubscription(subscription, payload)));
  }

  private async sendToSubscription(subscription: PushSubscriptionRecord, payload: PushNotificationPayload): Promise<void> {
    try {
      await this.webPush.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        JSON.stringify(payload),
      );
    } catch (error) {
      if (isGoneError(error)) {
        await this.store.remove(subscription.endpoint);
        return;
      }
      this.logger.warn({ err: error, endpoint: subscription.endpoint }, "failed to send push notification");
    }
  }
}

function isGoneError(error: unknown): boolean {
  return error instanceof Error && "statusCode" in error && error.statusCode === 410;
}
