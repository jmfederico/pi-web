import { describe, expect, it, vi } from "vitest";
import { PushService, type PushNotificationPayload } from "./pushService.js";
import type { PushSubscriptionRecord, PushSubscriptionStore } from "./pushSubscriptionStore.js";

function subscription(patch: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
  return {
    endpoint: "https://push.example/endpoint-1",
    keys: { p256dh: "p256dh-1", auth: "auth-1" },
    machineId: "local",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

function fakeStore(subscriptions: PushSubscriptionRecord[]): { store: Pick<PushSubscriptionStore, "list" | "remove">; removed: string[] } {
  const removed: string[] = [];
  return {
    store: {
      list: () => Promise.resolve(subscriptions),
      remove: (endpoint: string) => { removed.push(endpoint); return Promise.resolve(); },
    },
    removed,
  };
}

function payload(): PushNotificationPayload {
  return { title: "Agent finished", body: "The agent has completed its work.", tag: "agent-end:s1", url: "/", sessionId: "s1", machineId: "local" };
}

describe("PushService", () => {
  it("is disabled when VAPID keys are not configured", () => {
    const { store } = fakeStore([]);
    const service = new PushService({}, store);

    expect(service.isEnabled()).toBe(false);
    expect(service.vapidPublicKey()).toBeUndefined();
  });

  it("is enabled when VAPID keys and contact are configured", () => {
    const { store } = fakeStore([]);
    const setVapidDetails = vi.fn();
    const service = new PushService(
      { vapidPublicKey: "pub", vapidPrivateKey: "priv", vapidContact: "mailto:test@example.com" },
      store,
      { webPush: { setVapidDetails, sendNotification: vi.fn() } },
    );

    expect(service.isEnabled()).toBe(true);
    expect(service.vapidPublicKey()).toBe("pub");
    expect(setVapidDetails).toHaveBeenCalledWith("mailto:test@example.com", "pub", "priv");
  });

  it("never sends when disabled", async () => {
    const { store } = fakeStore([subscription()]);
    const sendNotification = vi.fn();
    const service = new PushService({}, store, { webPush: { setVapidDetails: vi.fn(), sendNotification } });

    await service.send(payload());

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("sends a notification to every stored subscription", async () => {
    const subscriptions = [subscription({ endpoint: "https://push.example/a" }), subscription({ endpoint: "https://push.example/b" })];
    const { store } = fakeStore(subscriptions);
    const sendNotification = vi.fn().mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    const service = new PushService(
      { vapidPublicKey: "pub", vapidPrivateKey: "priv", vapidContact: "mailto:test@example.com" },
      store,
      { webPush: { setVapidDetails: vi.fn(), sendNotification } },
    );

    await service.send(payload());

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification).toHaveBeenCalledWith({ endpoint: "https://push.example/a", keys: subscriptions[0]?.keys }, JSON.stringify(payload()));
    expect(sendNotification).toHaveBeenCalledWith({ endpoint: "https://push.example/b", keys: subscriptions[1]?.keys }, JSON.stringify(payload()));
  });

  it("removes a subscription that responds 410 Gone and never throws", async () => {
    const { store, removed } = fakeStore([subscription()]);
    class WebPushError extends Error {
      statusCode = 410;
    }
    const sendNotification = vi.fn().mockRejectedValue(new WebPushError("gone"));
    const service = new PushService(
      { vapidPublicKey: "pub", vapidPrivateKey: "priv", vapidContact: "mailto:test@example.com" },
      store,
      { webPush: { setVapidDetails: vi.fn(), sendNotification } },
    );

    await expect(service.send(payload())).resolves.toBeUndefined();
    expect(removed).toEqual(["https://push.example/endpoint-1"]);
  });

  it("logs and swallows non-410 send failures", async () => {
    const { store, removed } = fakeStore([subscription()]);
    const sendNotification = vi.fn().mockRejectedValue(new Error("network error"));
    const warn = vi.fn();
    const service = new PushService(
      { vapidPublicKey: "pub", vapidPrivateKey: "priv", vapidContact: "mailto:test@example.com" },
      store,
      { webPush: { setVapidDetails: vi.fn(), sendNotification }, logger: { warn } },
    );

    await expect(service.send(payload())).resolves.toBeUndefined();
    expect(removed).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
