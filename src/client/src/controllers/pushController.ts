import type { ReactiveController, ReactiveControllerHost } from "lit";
import { pushApi } from "../api";
import { createPwaDisplayModeMedia, detectPwaDisplayMode } from "../pwaDisplayMode";

const SERVICE_WORKER_URL = "/sw.js";

export interface PushControllerDependencies {
  api?: Pick<typeof pushApi, "vapidPublicKey" | "subscribe" | "unsubscribe">;
}

/**
 * Manages Web Push permission/subscription state for OS notifications on
 * agent completion. Best-effort throughout: failures are logged, never
 * thrown, since push is a convenience feature, not a core flow.
 */
export class PushController implements ReactiveController {
  permission: NotificationPermission = "default";
  subscribed = false;
  readonly isStandalone: boolean;

  private readonly api: Pick<typeof pushApi, "vapidPublicKey" | "subscribe" | "unsubscribe">;

  constructor(private readonly host: ReactiveControllerHost, deps: PushControllerDependencies = {}) {
    this.api = deps.api ?? pushApi;
    this.isStandalone = detectPwaDisplayMode(createPwaDisplayModeMedia());
    host.addController(this);
  }

  hostConnected(): void {
    if (!isPushSupported()) return;
    this.permission = Notification.permission;
    this.host.requestUpdate();
    if (this.permission === "granted") void this.ensureSubscribed();
  }

  async requestPermission(): Promise<void> {
    if (!isPushSupported()) return;
    const permission = await Notification.requestPermission();
    this.permission = permission;
    this.host.requestUpdate();
    if (permission === "granted") await this.ensureSubscribed();
  }

  async unsubscribe(): Promise<void> {
    if (!isPushSupported()) return;
    try {
      const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription != null) {
        await subscription.unsubscribe();
        await this.api.unsubscribe(subscription.endpoint);
      }
    } catch (error) {
      console.error("Failed to unsubscribe from push notifications", error);
    }
    this.subscribed = false;
    this.host.requestUpdate();
  }

  private async ensureSubscribed(): Promise<void> {
    try {
      const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
      await this.subscribeToPush(registration);
    } catch (error) {
      console.error("Failed to subscribe to push notifications", error);
    }
  }

  private async subscribeToPush(registration: ServiceWorkerRegistration): Promise<void> {
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array((await this.api.vapidPublicKey()).publicKey),
    });
    await this.api.subscribe({ endpoint: subscription.endpoint, keys: subscriptionKeys(subscription) });
    this.subscribed = true;
    this.host.requestUpdate();
  }
}

function isPushSupported(): boolean {
  return typeof Notification !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function subscriptionKeys(subscription: PushSubscription): { p256dh: string; auth: string } {
  const p256dh = subscription.getKey("p256dh");
  const auth = subscription.getKey("auth");
  if (p256dh === null || auth === null) throw new Error("Push subscription is missing encryption keys");
  return { p256dh: arrayBufferToBase64Url(p256dh), auth: arrayBufferToBase64Url(auth) };
}

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
