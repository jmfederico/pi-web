import { css, html, nothing, LitElement, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { pushApi } from "../../api/clients";
import { vapidKeyFromBase64Url } from "../../pushNotifications";
import { settingsCardStyles } from "../shared";

/** Map browser push failures to actionable copy; keep the raw message as the fallback. */
function friendlyPushError(error: unknown): string {
  if (error instanceof Error) {
    switch (error.name) {
      case "NotAllowedError":
        return "Notification permission was not granted for this site in your browser settings.";
      case "InvalidAccessError":
        return "The browser rejected the push key from this server (VAPID misconfiguration?)";
      case "SecurityError":
        return "This context cannot subscribe to push; the deployment must be served over HTTPS.";
      case "TypeError":
        return error.message;
      default:
        return error.message;
    }
  }
  return String(error);
}

/**
 * Deployment-local web push toggle: browser permission + subscription are client-owned state, so
 * this card intentionally sits outside the config-draft save machinery of its neighboring cards.
 */
@customElement("settings-push-notifications")
export class SettingsPushNotifications extends LitElement {
  @state() private supported = false;
  @state() private permission: NotificationPermission | "unknown" = "unknown";
  @state() private hasSubscription = false;
  @state() private busy = false;
  @state() private message = "";

  override connectedCallback(): void {
    super.connectedCallback();
    this.supported = typeof Notification !== "undefined" && "serviceWorker" in navigator;
    if (this.supported) {
      this.permission = Notification.permission;
    }
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (!this.supported || !("serviceWorker" in navigator)) return;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      this.hasSubscription = registration === undefined ? false : (await registration.pushManager.getSubscription()) !== null;
    } catch {
      this.hasSubscription = false; // A missing worker (e.g. registration failed) means push cannot be active.
    }
  }

  private async enable(): Promise<void> {
    if (!this.supported || typeof Notification === "undefined" || this.busy) return;
    this.setBusy(true);
    try {
      if (Notification.permission === "denied") {
        this.message = "Notifications are blocked for this site in your browser settings.";
        return;
      }
      const permission = await Notification.requestPermission();
      this.permission = permission;
      if (permission !== "granted") {
        this.message = permission === "denied" ? "Notifications were blocked, so push cannot be enabled." : "Not enabled yet — allow notifications and try again.";
        return;
      }
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration === undefined) throw new Error("The PI WEB service worker is not available in this browser.");
      // Service workers and push are different APIs: iOS Safari ships the first without the second, while the DOM types claim pushManager is always present.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions -- runtime probe for a missing API the DOM types misreport as present (iOS Safari)
      if (!registration.pushManager) throw new Error("This browser has no Web Push support (no PushManager — e.g. iOS Safari). Push works in an installed PWA on Android.");
      const { publicKey } = await pushApi.vapidPublicKey(); // throws with the server message when VAPID is unconfigured
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyFromBase64Url(publicKey) });
      // toJSON() serializes to exactly { endpoint, expirationTime?, keys } — the shape the daemon stores.
      try {
        await pushApi.subscribe(subscription.toJSON());
      } catch (error) {
        try {
          await subscription.unsubscribe();
        } catch (rollbackError) {
          this.hasSubscription = true;
          this.message = `Could not enable push: ${friendlyPushError(error)} Browser cleanup also failed: ${friendlyPushError(rollbackError)}`;
          return;
        }
        throw error;
      }
      this.hasSubscription = true;
      this.message = "Push notifications are on — you will be notified when assistant replies arrive or a session errors.";
    } catch (error) {
      this.message = `Could not enable push: ${friendlyPushError(error)}`;
    } finally {
      this.setBusy(false);
    }
  }

  private async disable(): Promise<void> {
    if (!this.supported || !("serviceWorker" in navigator) || this.busy) return;
    this.setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = registration === undefined ? null : await registration.pushManager.getSubscription();
      if (subscription !== null) {
        const subscriptionJson = subscription.toJSON();
        // The browser-side unsubscribe is the authoritative stop: OS delivery ends immediately, and a
        // remount must observe no subscription or the card would flip back to "enabled".
        await subscription.unsubscribe();
        this.hasSubscription = false;
        // Server removal is bookkeeping. If it fails, the stale endpoint self-heals: the notifier drops
        // subscriptions the push service reports expired (404/410) on the next delivery attempt.
        try {
          await pushApi.unsubscribe(subscriptionJson);
        } catch (error) {
          this.message = `Push is off in this browser, but server cleanup failed: ${friendlyPushError(error)}`;
          return;
        }
      }
      this.hasSubscription = false;
      // Browsers do not offer programmatic permission revocation; only the OS-level delivery stops.
      this.message = "Push notifications are off.";
    } catch (error) {
      this.message = `Could not disable push: ${friendlyPushError(error)}`;
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(value: boolean): void {
    this.busy = value;
  }

  override render(): TemplateResult {
    if (!this.supported) {
      return html`
        <section class="settings-card" aria-label="Push notifications">
          <div class="card-heading">
            <h3>Push notifications</h3>
            <p>This browser does not support the Web Push APIs, so push notifications are unavailable here.</p>
          </div>
        </section>`;
    }
    const enabled = this.hasSubscription;
    return html`
      <section class="settings-card" aria-label="Push notifications">
        <div class="card-heading">
          <h3>Push notifications</h3>
          <p>Get an operating-system notification when an assistant reply arrives or a session errors, even while PI WEB is closed. Notifications are sent from this server and need HTTPS plus the site's permission.</p>
        </div>
        <div class="config-form">
          <label class="field">
            <span class="field-heading"><span>Status</span></span>
            <small>${enabled ? "Subscribed — notifications will be delivered by this browser." : "Not subscribed. Enabling asks your browser for notification permission once."}</small>
            ${this.message !== "" ? html`<small class="field-message">${this.message}</small>` : nothing}
          </label>
          <div class="form-actions">
            <button type="button" ?disabled=${this.busy} @click=${() => { void (enabled ? this.disable() : this.enable()); }}>
              ${this.busy ? "Working…" : enabled ? "Disable push notifications" : "Enable push notifications"}
            </button>
          </div>
        </div>
      </section>`;
  }

  // Card design language comes from the shared settingsCardStyles (see components/shared.ts); only this card's own message style is local.
  static override styles = [
    settingsCardStyles,
    css`
      .field-message { display: block; margin-top: 0.25rem; }
    `,
  ];
}
