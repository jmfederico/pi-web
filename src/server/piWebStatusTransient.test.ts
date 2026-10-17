import { describe, expect, it, vi } from "vitest";
import type { PiWebStatusResponse } from "../shared/apiTypes.js";
import { buildApp } from "./app.js";
import { createPiWebStatusCache } from "./piWebStatusCache.js";

/**
 * A session daemon that is still starting reports `available: false`. That is a transient
 * state, not an authoritative one, so the status cache must retry instead of serving the
 * unavailable snapshot for its whole TTL once the daemon becomes reachable.
 */
describe("PI WEB status cache transient session daemon", () => {
  it("retries a status whose session daemon is unavailable instead of serving it for the ttl", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(status("starting", { sessiondAvailable: false }))
      .mockResolvedValueOnce(status("ready"));
    const cache = createPiWebStatusCache(load, {
      ttlMs: 60_000,
      isCacheable: (value) => value.components.sessiond.available,
    });

    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "starting" });
    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "ready" });

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps serving an available session daemon for the whole ttl", async () => {
    const load = vi.fn(() => Promise.resolve(status("ready")));
    const cache = createPiWebStatusCache(load, {
      ttlMs: 60_000,
      isCacheable: (value) => value.components.sessiond.available,
    });

    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "ready" });
    await expect(cache.get()).resolves.toMatchObject({ generatedAt: "ready" });

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent cold loads of an unavailable status", async () => {
    const deferred = createDeferred<PiWebStatusResponse>();
    const load = vi.fn(() => deferred.promise);
    const cache = createPiWebStatusCache(load, {
      isCacheable: (value) => value.components.sessiond.available,
    });

    const first = cache.get();
    const second = cache.get();
    deferred.resolve(status("starting", { sessiondAvailable: false }));

    await expect(first).resolves.toMatchObject({ generatedAt: "starting" });
    await expect(second).resolves.toMatchObject({ generatedAt: "starting" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reports an unavailable session daemon without a runtime until the daemon answers", async () => {
    let daemonAvailable = false;
    const app = await buildApp({
      sessionDaemon: {
        request: (_method: string, path: string) => {
          if (path !== "/runtime") return Promise.resolve({ statusCode: 404, headers: {}, body: "" });
          if (!daemonAvailable) return Promise.reject(new Error("sessiond socket is not up yet"));
          return Promise.resolve({
            statusCode: 200,
            headers: {},
            body: JSON.stringify({
              component: "sessiond",
              label: "Session daemon",
              runtime: "bun",
              available: true,
              capabilities: [],
            }),
          });
        },
        requestStream: () => Promise.reject(new Error("not used")),
        connectWebSocket: () => { throw new Error("not used"); },
      },
      clientDist: false,
      logger: false,
    });

    try {
      const before = await app.inject({ method: "GET", url: "/api/pi-web/status" });
      expect(before.json<PiWebStatusResponse>().components.sessiond.available).toBe(false);

      daemonAvailable = true;

      const after = await app.inject({ method: "GET", url: "/api/pi-web/status" });
      expect(after.json<PiWebStatusResponse>().components.sessiond.available).toBe(true);
      expect(after.json<PiWebStatusResponse>().components.sessiond.runtime).toBe("bun");
    } finally {
      await app.close();
    }
  });
});

function status(generatedAt: string, options: { sessiondAvailable?: boolean } = {}): PiWebStatusResponse {
  return {
    packageName: "@jmfederico/pi-web",
    generatedAt,
    components: {
      web: { component: "web", label: "Web/UI", stale: false, available: true },
      sessiond: { component: "sessiond", label: "Session daemon", stale: false, available: options.sessiondAvailable ?? true },
    },
    release: { packageName: "@jmfederico/pi-web", updateAvailable: false },
    commands: {},
    messages: [],
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}
