// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { vapidKeyFromBase64Url } from "../../pushNotifications.js";
import { SettingsPushNotifications } from "./SettingsPushNotifications.js";

const pushApiMock = vi.hoisted(() => ({
  vapidPublicKey: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("../../api/clients", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../api/clients")>();
  return { ...original, pushApi: pushApiMock };
});

const SUBSCRIPTION_JSON = { endpoint: "https://push.example/sub-1", expirationTime: null, keys: { p256dh: "pkey", auth: "akey" } };
const ORIGINAL_NOTIFICATION = globalThis.Notification;
const ORIGINAL_SERVICE_WORKER = navigator.serviceWorker;

interface SubscribeOptions {
  userVisibleOnly: boolean;
  applicationServerKey: Uint8Array;
}

interface ServiceWorkerFakes {
  getSubscription: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  /** The browser-side `subscription.unsubscribe()`; disable must call this in addition to the server API. */
  unsubscribeLocal: ReturnType<typeof vi.fn>;
  /** Recorded `pushManager.subscribe` options, so assertions never need to inspect mock internals loosely. */
  receivedOptions: SubscribeOptions[];
}

/** `permission` is the state at connect time; `requestResult` models what the user answers (real browsers answer granted/denied, never the prior state). */
function defineNotificationFake(permission: NotificationPermission, requestResult: NotificationPermission = "default"): void {
  const FakeNotification = {
    permission,
    requestPermission: vi.fn((): Promise<NotificationPermission> => Promise.resolve(requestResult)),
  };
  Object.defineProperty(globalThis, "Notification", { value: FakeNotification, configurable: true, writable: true });
}

function defineServiceWorkerFake(subscription: PushSubscriptionJSON | null): ServiceWorkerFakes {
  const unsubscribeLocal = vi.fn((): Promise<boolean> => Promise.resolve(true));
  const fakeSubscription = { toJSON: (): PushSubscriptionJSON => SUBSCRIPTION_JSON, unsubscribe: unsubscribeLocal };
  const getSubscription = vi.fn((): Promise<unknown> => Promise.resolve(subscription === null ? null : fakeSubscription));
  const receivedOptions: SubscribeOptions[] = [];
  const subscribe = vi.fn((options: SubscribeOptions): Promise<unknown> => {
    receivedOptions.push(options);
    return Promise.resolve(fakeSubscription);
  });
  Object.defineProperty(navigator, "serviceWorker", {
    value: { getRegistration: vi.fn((): Promise<unknown> => Promise.resolve({ pushManager: { getSubscription, subscribe } })) },
    configurable: true,
    writable: true,
  });
  return { getSubscription, subscribe, unsubscribeLocal, receivedOptions };
}

function restoreBrowserGlobals(): void {
  // Unconditional restore: the DOM types treat both globals as always present, and restoring the original
  // value (even if that is undefined in a given environment) is the correct inverse either way.
  Object.defineProperty(globalThis, "Notification", { value: ORIGINAL_NOTIFICATION, configurable: true, writable: true });
  Object.defineProperty(navigator, "serviceWorker", { value: ORIGINAL_SERVICE_WORKER, configurable: true, writable: true });
}

afterEach(() => {
  document.body.replaceChildren();
  pushApiMock.vapidPublicKey.mockReset();
  pushApiMock.subscribe.mockReset();
  pushApiMock.unsubscribe.mockReset();
  restoreBrowserGlobals();
});

async function mountAndSettle(): Promise<SettingsPushNotifications> {
  const panel = new SettingsPushNotifications();
  document.body.append(panel);
  await flushAsyncWork();
  return panel;
}

/** connectedCallback schedules refresh() plus lit updates; macrotask rounds settle both deterministically. */
async function flushAsyncWork(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function clickButton(panel: SettingsPushNotifications): void {
  const button = panel.renderRoot.querySelector("button");
  if (button instanceof HTMLButtonElement) {
    button.click();
    return;
  }
  throw new Error(`expected the push toggle button, found: ${panel.renderRoot.textContent}`);
}

describe("settings-push-notifications", () => {
  it("renders an unavailable card when the browser lacks the Web Push APIs", async () => {
    Object.defineProperty(globalThis, "Notification", { value: undefined, configurable: true, writable: true });

    const panel = await mountAndSettle();
    expect(panel.renderRoot.textContent).toContain("does not support the Web Push APIs");
    expect(panel.renderRoot.querySelector("button")).toBeNull();
  });

  it("shows status copy for a supported browser that is not subscribed yet", async () => {
    defineNotificationFake("default");
    defineServiceWorkerFake(null);
    pushApiMock.vapidPublicKey.mockResolvedValue({ publicKey: "abc" });

    const panel = await mountAndSettle();
    expect(panel.renderRoot.textContent).toContain("Not subscribed. Enabling asks your browser for notification permission once.");
    expect(pushApiMock.vapidPublicKey).not.toHaveBeenCalled(); // fetching the key is only worth it while enabling
  });

  it("enables push end-to-end: permission, worker subscription, then server registration", async () => {
    defineNotificationFake("default", "granted"); // the user allows the prompt
    const swFakes = defineServiceWorkerFake(null);
    const publicKey = "BJe9";
    pushApiMock.vapidPublicKey.mockResolvedValue({ publicKey });
    pushApiMock.subscribe.mockResolvedValue(true);

    const panel = await mountAndSettle();
    clickButton(panel);
    await flushAsyncWork();

    expect(pushApiMock.vapidPublicKey).toHaveBeenCalledOnce();
    expect(pushApiMock.subscribe).toHaveBeenCalledWith(SUBSCRIPTION_JSON);
    // The application server key reached the browser API decoded, not as raw base64url text.
    expect(swFakes.receivedOptions).toHaveLength(1);
    expect(swFakes.receivedOptions[0]?.userVisibleOnly).toBe(true);
    expect(Array.from(swFakes.receivedOptions[0]?.applicationServerKey ?? new Uint8Array(0))).toEqual(Array.from(vapidKeyFromBase64Url(publicKey)));
    expect(panel.renderRoot.textContent).toContain("Push notifications are on");
    expect(panel.renderRoot.querySelector("button")?.textContent).toContain("Disable push notifications");
  });

  it("rolls back the browser subscription when server registration fails", async () => {
    defineNotificationFake("default", "granted");
    const swFakes = defineServiceWorkerFake(null);
    pushApiMock.vapidPublicKey.mockResolvedValue({ publicKey: "BJe9" });
    pushApiMock.subscribe.mockRejectedValue(new Error("server registration failed"));

    const panel = await mountAndSettle();
    clickButton(panel);
    await flushAsyncWork();

    expect(swFakes.unsubscribeLocal).toHaveBeenCalledOnce();
    expect(panel.renderRoot.textContent).toContain("Could not enable push: server registration failed");
    expect(panel.renderRoot.querySelector("button")?.textContent).toContain("Enable push notifications");
  });

  it("keeps the local subscription visible when server registration and browser rollback both fail", async () => {
    defineNotificationFake("default", "granted");
    const swFakes = defineServiceWorkerFake(null);
    swFakes.unsubscribeLocal.mockRejectedValue(new Error("browser rollback failed"));
    pushApiMock.vapidPublicKey.mockResolvedValue({ publicKey: "BJe9" });
    pushApiMock.subscribe.mockRejectedValue(new Error("server registration failed"));

    const panel = await mountAndSettle();
    clickButton(panel);
    await flushAsyncWork();

    expect(panel.renderRoot.textContent).toContain("Could not enable push: server registration failed Browser cleanup also failed: browser rollback failed");
    expect(panel.renderRoot.querySelector("button")?.textContent).toContain("Disable push notifications");
  });

  it("stops with an explanatory message when the browser denies permission", async () => {
    defineNotificationFake("default", "denied"); // the user blocks the prompt
    defineServiceWorkerFake(null);

    const panel = await mountAndSettle();
    clickButton(panel);
    await flushAsyncWork();

    expect(pushApiMock.vapidPublicKey).not.toHaveBeenCalled(); // permission is gated before any network work
    expect(pushApiMock.subscribe).not.toHaveBeenCalled();
    expect(panel.renderRoot.textContent).toContain("Notifications were blocked");
  });

  it("disables by unsubscribing the browser first, then telling the server, and clearing local state", async () => {
    defineNotificationFake("granted");
    const swFakes = defineServiceWorkerFake(SUBSCRIPTION_JSON); // already subscribed in this browser profile

    const panel = await mountAndSettle();
    expect(swFakes.getSubscription).toHaveBeenCalled(); // refresh probes the current subscription on connect
    expect(panel.renderRoot.querySelector("button")?.textContent).toContain("Disable push notifications");
    clickButton(panel);
    await flushAsyncWork();

    expect(swFakes.unsubscribeLocal).toHaveBeenCalledOnce(); // browser-side stop: OS delivery ends and remounts observe no subscription
    expect(pushApiMock.unsubscribe).toHaveBeenCalledWith(SUBSCRIPTION_JSON); // server drops the endpoint too
    expect(panel.renderRoot.textContent).toContain("Push notifications are off.");
  });

  it("keeps the subscription and reports the error when the browser unsubscribe fails", async () => {
    defineNotificationFake("granted");
    const swFakes = defineServiceWorkerFake(SUBSCRIPTION_JSON);
    swFakes.unsubscribeLocal.mockRejectedValue(new Error("local unsubscribe failed"));

    const panel = await mountAndSettle();
    clickButton(panel);
    await flushAsyncWork();

    expect(pushApiMock.unsubscribe).not.toHaveBeenCalled(); // browser state is authoritative; the server was not touched
    expect(panel.renderRoot.textContent).toContain("Could not disable push: local unsubscribe failed");
    expect(panel.renderRoot.querySelector("button")?.textContent).toContain("Disable push notifications"); // still enabled
  });

  it("stays locally disabled when server cleanup fails", async () => {
    defineNotificationFake("granted");
    const swFakes = defineServiceWorkerFake(SUBSCRIPTION_JSON);
    pushApiMock.unsubscribe.mockRejectedValue(new Error("server cleanup failed"));

    const panel = await mountAndSettle();
    clickButton(panel);
    await flushAsyncWork();

    expect(swFakes.unsubscribeLocal).toHaveBeenCalledOnce();
    expect(panel.renderRoot.textContent).toContain("Push is off in this browser, but server cleanup failed: server cleanup failed");
    expect(panel.renderRoot.querySelector("button")?.textContent).toContain("Enable push notifications");
  });
});
