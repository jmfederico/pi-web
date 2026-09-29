import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { PiWebPushConfig } from "../../shared/apiTypes.js";
import { PushSubscriptionStore } from "./pushSubscriptionStore.js";
import { createWebPushRuntime, isCompleteVapidConfig, isUsableVapidSubject } from "./webPushRuntime.js";

const complete: PiWebPushConfig = { vapidPublicKey: "public", vapidPrivateKey: "private", subjectEmail: "mailto:pi@example.com" };
// exactOptionalPropertyTypes: express "missing field" by omitting the property instead of assigning undefined.
const missingPublicKey: PiWebPushConfig = { vapidPrivateKey: "private", subjectEmail: "mailto:pi@example.com" };
const missingPrivateKey: PiWebPushConfig = { vapidPublicKey: "public", subjectEmail: "mailto:pi@example.com" };

function fakeEventHub() {
  const subscribe = vi.fn(() => () => undefined);
  return { subscribe };
}

const apps: FastifyInstance[] = [];
function silentLogger(): import("fastify").FastifyBaseLogger {
  const app = Fastify({ logger: false });
  apps.push(app);
  return app.log;
}

afterAll(async () => {
  for (const app of apps) await app.close();
});

describe("isCompleteVapidConfig", () => {
  it("requires every credential field to be a non-empty string", () => {
    expect(isCompleteVapidConfig(complete)).toBe(true);
    expect(isCompleteVapidConfig(undefined)).toBe(false);
    expect(isCompleteVapidConfig({})).toBe(false);
    expect(isCompleteVapidConfig(missingPublicKey)).toBe(false);
    expect(isCompleteVapidConfig(missingPrivateKey)).toBe(false);
    expect(isCompleteVapidConfig({ ...complete, vapidPrivateKey: "" })).toBe(false);
    expect(isCompleteVapidConfig({ ...complete, subjectEmail: "" })).toBe(false);
  });
});

describe("isUsableVapidSubject", () => {
  it("accepts mailto and https contact claims only", () => {
    expect(isUsableVapidSubject("mailto:pi@example.com")).toBe(true);
    expect(isUsableVapidSubject("https://example.com/contact")).toBe(true);
    expect(isUsableVapidSubject("http://insecure.example.com/contact")).toBe(false);
    expect(isUsableVapidSubject("not a url at all")).toBe(false);
  });
});

describe("createWebPushRuntime", () => {
  it("stays inert (without wiring the hub) until every VAPID field is present", () => {
    const store = new PushSubscriptionStore("/tmp/pi-web-push-runtime-test/store.json");
    // Each shape below must leave push disabled: missing block, empty object, and each single missing field.
    for (const config of [undefined, {}, missingPublicKey, { ...complete, vapidPrivateKey: "" }]) {
      const eventHub = fakeEventHub();
      const runtime = createWebPushRuntime({ config: config === undefined ? {} : { push: config }, store, eventHub, logger: silentLogger() });
      expect(runtime.configured).toBe(false);
      expect("publicKey" in runtime).toBe(false);
      expect(eventHub.subscribe).not.toHaveBeenCalled();
      expect(runtime.store).toBe(store);
    }
  });

  it("arms the notifier and exposes the public key for a complete credential set", () => {
    const store = new PushSubscriptionStore("/tmp/pi-web-push-runtime-test/store.json");
    const eventHub = fakeEventHub();
    const runtime = createWebPushRuntime({ config: { push: complete }, store, eventHub, logger: silentLogger() });
    expect(runtime.configured).toBe(true);
    expect(runtime.publicKey).toBe("public");
    expect(eventHub.subscribe).toHaveBeenCalledOnce();
  });

  it("refuses to arm the notifier when the contact claim is malformed", () => {
    const store = new PushSubscriptionStore("/tmp/pi-web-push-runtime-test/store.json");
    const eventHub = fakeEventHub();
    const runtime = createWebPushRuntime({
      config: { push: { ...complete, subjectEmail: "http://insecure.example.com" } },
      store,
      eventHub,
      logger: silentLogger(),
    });
    expect(runtime.configured).toBe(false);
    expect(eventHub.subscribe).not.toHaveBeenCalled();
  });

  it("returns the same store instance in every branch so subscriptions survive configuration changes", () => {
    const store = new PushSubscriptionStore("/tmp/pi-web-push-runtime-test/store.json");
    const runtime = createWebPushRuntime({ config: {}, store, eventHub: fakeEventHub(), logger: silentLogger() });
    expect(runtime.store).toBe(store);
  });
});
