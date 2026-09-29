import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { registerPushRoutes, type PushRouteDependencies } from "./pushRoutes.js";

class CountingStore {
  readonly endpoints = new Set<string>();
  cap: number;
  removedCount = 0;

  constructor(cap = 256) { this.cap = cap; }

  add(subscription: { endpoint: string }): "added" | "duplicate" | "full" {
    if (this.endpoints.has(subscription.endpoint)) return "duplicate";
    if (this.endpoints.size >= this.cap) return "full";
    this.endpoints.add(subscription.endpoint);
    return "added";
  }

  remove(endpoint: string): boolean {
    const removed = this.endpoints.delete(endpoint);
    if (removed) this.removedCount += 1;
    return removed;
  }
}

const validSubscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/browser-1",
  expirationTime: null,
  keys: { p256dh: "p2key", auth: "authkey" },
};

async function appWith(deps: PushRouteDependencies): Promise<FastifyInstance> {
  const app = Fastify();
  registerPushRoutes(app, deps);
  await app.ready();
  return app;
}

const apps: FastifyInstance[] = [];
async function fixture(deps: PushRouteDependencies): Promise<FastifyInstance> {
  const app = await appWith(deps);
  apps.push(app);
  return app;
}

afterAll(async () => {
  for (const app of apps) await app.close();
});

describe("registerPushRoutes", () => {
  it("answers 503 with a clear message while VAPID is unconfigured", async () => {
    const store = new CountingStore();
    const app = await fixture({ configured: false, store });
    for (const response of [
      await app.inject({ method: "GET", url: "/push/vapid-public-key" }),
      await app.inject({ method: "POST", url: "/push/subscribe", payload: validSubscription }),
    ]) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "Web push is not configured on this server" });
    }
  });

  it("serves the public key only when configured", async () => {
    const store = new CountingStore();
    const unconfigured = await appWith({ configured: false, store });
    apps.push(unconfigured);
    expect((await unconfigured.inject({ method: "GET", url: "/push/vapid-public-key" })).statusCode).toBe(503);

    const app = await fixture({ configured: true, publicKey: "public-base64url-key", store });
    const response = await app.inject({ method: "GET", url: "/push/vapid-public-key" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ publicKey: "public-base64url-key" });
  });

  it("stores valid subscriptions and rejects undeliverable payloads with 400", async () => {
    const store = new CountingStore();
    const app = await fixture({ configured: true, publicKey: "pk", store });

    expect((await app.inject({ method: "POST", url: "/push/subscribe", payload: validSubscription })).json()).toEqual({ accepted: true });
    expect(store.endpoints).toContain(validSubscription.endpoint);

    // Object payloads get application/json from light-my-request, mirroring real browser requests.
    const invalidBodies = [
      undefined, // no body at all
      { endpoint: "http://insecure.example/svc", keys: validSubscription.keys }, // push services are https-only
      { endpoint: validSubscription.endpoint, keys: { p256dh: "only-one" } }, // missing auth key
    ];
    for (const body of invalidBodies) {
      const response = await app.inject({ method: "POST", url: "/push/subscribe", ...(body === undefined ? {} : { payload: body }) });
      expect(response.statusCode).toBe(400);
    }
    // A JSON primitive parses fine at the transport layer but is not a subscription object.
    const primitive = await app.inject({ method: "POST", url: "/push/subscribe", payload: '"just a string"', headers: { "content-type": "application/json" } });
    expect(primitive.statusCode).toBe(400);
  });

  it("answers 507 instead of evicting once the subscription cap is reached", async () => {
    const store = new CountingStore(1);
    store.add({ endpoint: validSubscription.endpoint });
    const app = await fixture({ configured: true, publicKey: "pk", store });
    // The existing endpoint resubscribes as a duplicate; only a NEW endpoint hits the cap path.
    expect((await app.inject({ method: "POST", url: "/push/subscribe", payload: validSubscription })).statusCode).toBe(200);
    const full = await app.inject({ method: "POST", url: "/push/subscribe", payload: { ...validSubscription, endpoint: "https://fcm.googleapis.com/fcm/send/browser-2" } });
    expect(full.statusCode).toBe(507);
    expect(full.body).toContain("limit reached");
  });

  it("removes subscriptions on unsubscribe and reports absent ones as removed:false", async () => {
    const store = new CountingStore();
    store.add({ endpoint: validSubscription.endpoint });
    const app = await fixture({ configured: true, publicKey: "pk", store });
    expect((await app.inject({ method: "DELETE", url: "/push/unsubscribe", payload: validSubscription })).json()).toEqual({ removed: true });
    expect(store.removedCount).toBe(1);
    expect((await app.inject({ method: "DELETE", url: "/push/unsubscribe", payload: { ...validSubscription, endpoint: "https://fcm.googleapis.com/fcm/send/never" } })).json()).toEqual({ removed: false });
  });
});
