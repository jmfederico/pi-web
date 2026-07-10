import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PushSubscriptionStore, type PushSubscriptionRecord } from "./pushSubscriptionStore.js";

function subscription(patch: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
  return {
    endpoint: "https://push.example/endpoint-1",
    keys: { p256dh: "p256dh-1", auth: "auth-1" },
    machineId: "local",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

describe("PushSubscriptionStore", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function newStore(): Promise<PushSubscriptionStore> {
    const root = await mkdtemp(join(tmpdir(), "pi-web-push-subscriptions-"));
    roots.push(root);
    return new PushSubscriptionStore(join(root, "push-subscriptions.json"));
  }

  it("returns an empty list when no file exists yet", async () => {
    const store = await newStore();
    await expect(store.list()).resolves.toEqual([]);
  });

  it("adds and lists subscriptions", async () => {
    const store = await newStore();
    await store.add(subscription());

    await expect(store.list()).resolves.toEqual([subscription()]);
  });

  it("dedupes by endpoint, keeping the latest record", async () => {
    const store = await newStore();
    await store.add(subscription({ machineId: "local" }));
    await store.add(subscription({ createdAt: "2026-02-01T00:00:00.000Z" }));

    const subscriptions = await store.list();
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.createdAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("removes a subscription by endpoint", async () => {
    const store = await newStore();
    await store.add(subscription({ endpoint: "https://push.example/a" }));
    await store.add(subscription({ endpoint: "https://push.example/b" }));

    await store.remove("https://push.example/a");

    await expect(store.list()).resolves.toEqual([subscription({ endpoint: "https://push.example/b" })]);
  });

  it("clears all subscriptions", async () => {
    const store = await newStore();
    await store.add(subscription());
    await store.clear();

    await expect(store.list()).resolves.toEqual([]);
  });

  it("a read during a write never observes a partially-written file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-push-subscriptions-concurrent-"));
    roots.push(root);
    const filePath = join(root, "push-subscriptions.json");
    const store = new PushSubscriptionStore(filePath);
    await store.add(subscription());

    // Writes go through a temp-file-then-rename, so a reader racing a writer
    // (as another process would, since there is no cross-process locking)
    // must always see either the old or the new complete file — never a
    // half-written, unparseable one.
    const write = store.add(subscription({ endpoint: "https://push.example/endpoint-2" }));
    const reads = Array.from({ length: 20 }, () => readFile(filePath, "utf8"));

    const [, results] = await Promise.all([write, Promise.all(reads)]);
    for (const raw of results) expect(() => { JSON.parse(raw); }).not.toThrow();
  });
});
