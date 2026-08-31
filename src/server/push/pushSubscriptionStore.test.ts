import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PushSubscriptionStore } from "./pushSubscriptionStore.js";

function sampleEndpoint(index: number): string {
  return `https://fcm.googleapis.com/fcm/send/sub-${String(index)}`;
}

function sampleKeys(index: number): Record<string, string> {
  return { p256dh: `p256dh-${String(index)}`, auth: `auth-${String(index)}` };
}

describe("PushSubscriptionStore", () => {
  let dir: string;
  const paths = new Set<string>();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-web-push-store-"));
  });

  afterAll(async () => {
    for (const path of paths) await rm(path, { recursive: true, force: true }).catch(() => undefined);
  });

  function filePath(): string {
    const path = join(dir, "push-subscriptions.json");
    paths.add(dir);
    return path;
  }

  function nodeErrorCode(error: unknown): string | undefined {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = error.code;
      return typeof code === "string" ? code : undefined;
    }
    return undefined;
  }

  it("starts empty when no file exists and persists across load", async () => {
    const store = new PushSubscriptionStore(filePath());
    await store.load();
    expect(store.size).toBe(0);

    expect(store.add({ endpoint: sampleEndpoint(1), keys: sampleKeys(1) })).toBe("added");
    await store.flush();
    expect(await readFile(filePath(), "utf8")).toContain(sampleEndpoint(1));

    const reloaded = new PushSubscriptionStore(filePath());
    await reloaded.load();
    expect(reloaded.list()).toEqual([{ endpoint: sampleEndpoint(1), keys: { p256dh: "p256dh-1", auth: "auth-1" } }]);
  });

  it("treats duplicate endpoints as no-ops", async () => {
    const store = new PushSubscriptionStore(filePath());
    await store.load();
    expect(store.add({ endpoint: sampleEndpoint(2), keys: sampleKeys(2) })).toBe("added");
    expect(store.add({ endpoint: sampleEndpoint(2), keys: sampleKeys(99) })).toBe("duplicate");
    expect(store.list()).toEqual([{ endpoint: sampleEndpoint(2), keys: sampleKeys(2) }]);
  });

  it("refuses new subscriptions past the cap without evicting existing ones", async () => {
    const store = new PushSubscriptionStore(filePath());
    await store.load();
    for (let index = 0; index < 256; index += 1) expect(store.add({ endpoint: sampleEndpoint(index), keys: sampleKeys(index) })).toBe("added");
    expect(store.add({ endpoint: sampleEndpoint(999), keys: sampleKeys(999) })).toBe("full");
    expect(store.size).toBe(256);
    expect(store.list().some((entry) => entry.endpoint === sampleEndpoint(0))).toBe(true);
  });

  it("removes by endpoint and persists the removal", async () => {
    const store = new PushSubscriptionStore(filePath());
    await store.load();
    store.add({ endpoint: sampleEndpoint(3), keys: sampleKeys(3) });
    expect(store.remove(sampleEndpoint(3))).toBe(true);
    expect(store.remove(sampleEndpoint(404))).toBe(false);
    await store.flush();

    const reloaded = new PushSubscriptionStore(filePath());
    await reloaded.load();
    expect(reloaded.size).toBe(0);
  });

  it("throws with a contextual error on corrupted JSON so callers can log and reset deliberately", async () => {
    const store = new PushSubscriptionStore(filePath());
    store.add({ endpoint: sampleEndpoint(5), keys: sampleKeys(5) });
    await store.flush(); // quiesce the best-effort save before corrupting
    await writeFile(filePath(), "{not json", "utf8");

    const fresh = new PushSubscriptionStore(filePath());
    await expect(fresh.load()).rejects.toThrow(/push subscription store is not valid JSON/);
  });

  it("skips stored entries without the VAPID key pair instead of keeping undeliverable rows", async () => {
    const store = new PushSubscriptionStore(filePath());
    store.add({ endpoint: sampleEndpoint(6), keys: sampleKeys(6) });
    await store.flush(); // ensure the overwrite below wins, not a racing best-effort save
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      filePath(),
      `${JSON.stringify({ version: 1, subscriptions: [{ endpoint: "https://push.example/svc", keys: {} }] }, null, 2)}\n`,
      "utf8",
    );

    const reloaded = new PushSubscriptionStore(filePath());
    await reloaded.load();
    expect(reloaded.list()).toEqual([]);
  });

  it("flush resolves once best-effort saves have settled", async () => {
    const store = new PushSubscriptionStore(filePath());
    for (let index = 0; index < 5; index += 1) store.add({ endpoint: sampleEndpoint(index), keys: sampleKeys(index) });
    await expect(store.flush()).resolves.toBeUndefined();
    expect(await readFile(filePath(), "utf8")).toContain(sampleEndpoint(4));
  });

  it("serializes saves so a later mutation cannot persist before an earlier one", async () => {
    const store = new PushSubscriptionStore(filePath());
    let releaseFirstSave: (() => void) | undefined;
    const firstSave = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
    const save = vi.spyOn(store, "save")
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValueOnce(undefined);

    store.add({ endpoint: sampleEndpoint(40), keys: sampleKeys(40) });
    await Promise.resolve();
    expect(save).toHaveBeenCalledOnce();

    store.remove(sampleEndpoint(40));
    await Promise.resolve();
    expect(save).toHaveBeenCalledOnce();

    releaseFirstSave?.();
    await store.flush();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("reports save failures through onPersistenceError instead of discarding them, and keeps serving from memory", async () => {
    const errors: { operation: string; error: unknown }[] = [];
    // A directory as the file path makes every write fail (EISDIR) while leaving memory untouched.
    paths.add(dir);
    const store = new PushSubscriptionStore(dir, { onPersistenceError: (operation, error) => { errors.push({ operation, error }); } });
    expect(store.add({ endpoint: sampleEndpoint(42), keys: sampleKeys(42) })).toBe("added");
    await store.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.operation).toBe("save");
    expect(nodeErrorCode(errors[0]?.error)).toBe("EISDIR");
    // In-memory state stays authoritative until the next load.
    expect(store.list().map((entry) => entry.endpoint)).toEqual([sampleEndpoint(42)]);
  });

  it("reports load failures through onPersistenceError and still throws so callers can reset deliberately", async () => {
    const store = new PushSubscriptionStore(filePath());
    store.add({ endpoint: sampleEndpoint(50), keys: sampleKeys(50) });
    await store.flush();
    await writeFile(filePath(), "{not json", "utf8");

    const errors: { operation: string; error: unknown }[] = [];
    const fresh = new PushSubscriptionStore(filePath(), { onPersistenceError: (operation, error) => { errors.push({ operation, error }); } });
    await expect(fresh.load()).rejects.toThrow(/push subscription store is not valid JSON/);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.operation).toBe("load");
  });

  it("keeps persisting when the injected error callback itself throws", async () => {
    paths.add(dir);
    const store = new PushSubscriptionStore(dir, { onPersistenceError: () => {
      throw new Error("callback exploded");
    } });
    expect(() => { store.add({ endpoint: sampleEndpoint(51), keys: sampleKeys(51) }); }).not.toThrow();
    await expect(store.flush()).resolves.toBeUndefined();
    expect(store.size).toBe(1);
  });
});
