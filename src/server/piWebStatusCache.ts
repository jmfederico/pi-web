import type { PiWebStatusResponse } from "../shared/apiTypes.js";

const DEFAULT_PI_WEB_STATUS_CACHE_TTL_MS = 60_000;

export interface PiWebStatusCacheOptions {
  ttlMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface PiWebStatusCache {
  get(): Promise<PiWebStatusResponse>;
  refresh(): Promise<PiWebStatusResponse>;
  invalidate(): void;
}

export function createPiWebStatusCache(load: () => Promise<PiWebStatusResponse>, options: PiWebStatusCacheOptions = {}): PiWebStatusCache {
  const ttlMs = options.ttlMs ?? DEFAULT_PI_WEB_STATUS_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { status: PiWebStatusResponse; expiresAt: number } | undefined;
  let pending: Promise<PiWebStatusResponse> | undefined;

  const refresh = (): Promise<PiWebStatusResponse> => {
    pending ??= Promise.resolve()
      .then(load)
      .then((status) => {
        cached = { status, expiresAt: now() + ttlMs };
        return status;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };

  return {
    async get(): Promise<PiWebStatusResponse> {
      if (cached !== undefined) {
        if (cached.expiresAt > now()) return cached.status;
        void refresh().catch((error: unknown) => { options.onError?.(error); });
        return cached.status;
      }
      return refresh();
    },
    refresh,
    invalidate(): void {
      cached = undefined;
    },
  };
}
