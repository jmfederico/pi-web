import { describe, expect, it, vi } from "vitest";
import type { PiWebStatusResponse } from "../shared/apiTypes.js";
import { createPiWebStatusCache, type PiWebStatusCacheLoadOptions } from "./piWebStatusCache.js";

describe("createPiWebStatusCache", () => {
  it("serves cached status while it is fresh", async () => {
    const now = 1_000;
    const load = vi.fn(() => Promise.resolve(status("first")));
    const cache = createPiWebStatusCache(load, { ttlMs: 100, now: () => now });

    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "first" });
    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "first" });

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("returns stale status immediately while refreshing in the background", async () => {
    let now = 1_000;
    const load = vi.fn()
      .mockResolvedValueOnce(status("first"))
      .mockResolvedValueOnce(status("second"));
    const cache = createPiWebStatusCache(load, { ttlMs: 100, now: () => now });

    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "first" });
    now = 1_101;

    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "first" });
    await waitForMicrotasks();

    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "second" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("explicitly refreshes and replaces a fresh cached status", async () => {
    let now = 1_000;
    const load = vi.fn()
      .mockResolvedValueOnce(status("first"))
      .mockResolvedValueOnce(status("second"));
    const cache = createPiWebStatusCache(load, { ttlMs: 100, now: () => now });

    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "first" });
    now = 1_050;

    await expect(cache.refresh()).resolves.toMatchObject({ generatedAt: "second" });
    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "second" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each(["forced-first", "regular-first"] as const)("does not let an older refresh replace a forced result when %s completes", async (completionOrder) => {
    const regular = createDeferred<PiWebStatusResponse>();
    const forced = createDeferred<PiWebStatusResponse>();
    const load = vi.fn(({ force }: PiWebStatusCacheLoadOptions) => force ? forced.promise : regular.promise);
    const cache = createPiWebStatusCache(load);

    const regularRefresh = cache.refresh();
    const forcedRefresh = cache.refresh({ force: true });
    if (completionOrder === "forced-first") {
      forced.resolve(status("forced"));
      await expect(forcedRefresh).resolves.toMatchObject({ generatedAt: "forced" });
      regular.resolve(status("regular"));
      await expect(regularRefresh).resolves.toMatchObject({ generatedAt: "regular" });
    } else {
      regular.resolve(status("regular"));
      await expect(regularRefresh).resolves.toMatchObject({ generatedAt: "regular" });
      forced.resolve(status("forced"));
      await expect(forcedRefresh).resolves.toMatchObject({ generatedAt: "forced" });
    }

    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "forced" });
    expect(load).toHaveBeenNthCalledWith(1, { force: false });
    expect(load).toHaveBeenNthCalledWith(2, { force: true });
  });

  it("makes regular refreshes join a pending forced refresh", async () => {
    const deferred = createDeferred<PiWebStatusResponse>();
    const load = vi.fn(() => deferred.promise);
    const cache = createPiWebStatusCache(load);

    const forced = cache.refresh({ force: true });
    const regular = cache.refresh();

    expect(regular).toBe(forced);
    deferred.resolve(status("forced"));
    await forced;
    expect(load).toHaveBeenCalledOnce();
  });

  it("retains stale status and reports background refresh errors", async () => {
    let now = 1_000;
    const refreshError = new Error("refresh failed");
    const errorReported = createDeferred<unknown>();
    const onError = vi.fn((error: unknown) => {
      errorReported.resolve(error);
    });
    const load = vi.fn()
      .mockResolvedValueOnce(status("first"))
      .mockRejectedValueOnce(refreshError)
      .mockResolvedValueOnce(status("second"));
    const cache = createPiWebStatusCache(load, { ttlMs: 100, now: () => now, onError });

    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "first" });
    now = 1_101;

    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "first" });
    await expect(errorReported.promise).resolves.toBe(refreshError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);

    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "first" });
    await waitForMicrotasks();

    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "second" });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("loads again after a fresh cache is invalidated", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(status("first"))
      .mockResolvedValueOnce(status("second"));
    const cache = createPiWebStatusCache(load);

    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "first" });
    cache.invalidate();
    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "second" });

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("abandons an in-flight load when invalidated", async () => {
    const firstLoad = createDeferred<PiWebStatusResponse>();
    const secondLoad = createDeferred<PiWebStatusResponse>();
    const load = vi.fn()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockImplementationOnce(() => secondLoad.promise);
    const cache = createPiWebStatusCache(load);

    const first = cache.get();
    await waitForMicrotasks();
    cache.invalidate();
    const second = cache.get();
    await waitForMicrotasks();

    secondLoad.resolve(status("second"));
    await expect(second).resolves.toMatchObject({ generatedAt: "second" });
    firstLoad.resolve(status("first"));
    await expect(first).resolves.toMatchObject({ generatedAt: "first" });

    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "second" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent cold loads", async () => {
    const deferred = createDeferred<PiWebStatusResponse>();
    const load = vi.fn(() => deferred.promise);
    const cache = createPiWebStatusCache(load);

    const first = cache.get();
    const second = cache.get();
    deferred.resolve(status("ready"));

    await expect(first).resolves.toMatchObject({ generatedAt: "ready" });
    await expect(second).resolves.toMatchObject({ generatedAt: "ready" });
    expect(load).toHaveBeenCalledTimes(1);
  });
});

function status(generatedAt: string): PiWebStatusResponse {
  return {
    packageName: "@jmfederico/pi-web",
    generatedAt,
    components: {
      web: { component: "web", label: "Web/UI", stale: false, available: true },
      sessiond: { component: "sessiond", label: "Session daemon", stale: false, available: true },
    },
    release: { packageName: "@jmfederico/pi-web", updateAvailable: false },
    commands: {},
    messages: [],
  };
}

async function waitForMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
