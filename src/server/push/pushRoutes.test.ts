import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPushRoutes } from "./pushRoutes.js";
import type { PushSubscriptionRecord, PushSubscriptionStore } from "./pushSubscriptionStore.js";

let app: FastifyInstance;
let added: PushSubscriptionRecord[];
let removed: string[];
let publicKey: string | undefined;

beforeEach(async () => {
  added = [];
  removed = [];
  publicKey = "test-public-key";
  const store: Pick<PushSubscriptionStore, "add" | "remove"> = {
    add: vi.fn((subscription: PushSubscriptionRecord) => { added.push(subscription); return Promise.resolve(); }),
    remove: vi.fn((endpoint: string) => { removed.push(endpoint); return Promise.resolve(); }),
  };
  app = Fastify({ logger: false });
  registerPushRoutes(app, store, () => publicKey);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("push routes", () => {
  it("returns the VAPID public key when configured", async () => {
    const response = await app.inject({ method: "GET", url: "/api/push/vapid-public-key" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ publicKey: "test-public-key" });
  });

  it("returns 404 when web push is not configured", async () => {
    publicKey = undefined;
    const response = await app.inject({ method: "GET", url: "/api/push/vapid-public-key" });

    expect(response.statusCode).toBe(404);
  });

  it("stores a subscription with the request's user agent", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/push/subscribe",
      headers: { "user-agent": "test-agent" },
      payload: { endpoint: "https://push.example/e1", keys: { p256dh: "p1", auth: "a1" } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ subscribed: true });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      endpoint: "https://push.example/e1",
      keys: { p256dh: "p1", auth: "a1" },
      machineId: "local",
      userAgent: "test-agent",
    });
    expect(typeof added[0]?.createdAt).toBe("string");
  });

  it("rejects a subscribe request missing keys", async () => {
    const response = await app.inject({ method: "POST", url: "/api/push/subscribe", payload: { endpoint: "https://push.example/e1" } });

    expect(response.statusCode).toBe(400);
    expect(added).toEqual([]);
  });

  it("removes a subscription by endpoint", async () => {
    const response = await app.inject({ method: "DELETE", url: "/api/push/unsubscribe", payload: { endpoint: "https://push.example/e1" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ unsubscribed: true });
    expect(removed).toEqual(["https://push.example/e1"]);
  });

  it("rejects an unsubscribe request missing an endpoint", async () => {
    const response = await app.inject({ method: "DELETE", url: "/api/push/unsubscribe", payload: {} });

    expect(response.statusCode).toBe(400);
    expect(removed).toEqual([]);
  });
});
