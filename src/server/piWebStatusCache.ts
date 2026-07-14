import type { PiWebStatusResponse } from "../shared/apiTypes.js";

const DEFAULT_PI_WEB_STATUS_CACHE_TTL_MS = 60_000;

export interface PiWebStatusCacheOptions {
  ttlMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface PiWebStatusCacheLoadOptions {
  force: boolean;
}

export interface PiWebStatusCacheRefreshOptions {
  force?: boolean;
}

export interface PiWebStatusCache {
  get(): Promise<PiWebStatusResponse>;
  refresh(options?: PiWebStatusCacheRefreshOptions): Promise<PiWebStatusResponse>;
  invalidate(): void;
}

export function createPiWebStatusCache(load: (options: PiWebStatusCacheLoadOptions) => Promise<PiWebStatusResponse>, options: PiWebStatusCacheOptions = {}): PiWebStatusCache {
  const ttlMs = options.ttlMs ?? DEFAULT_PI_WEB_STATUS_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { status: PiWebStatusResponse; expiresAt: number } | undefined;
  let pending: { promise: Promise<PiWebStatusResponse>; force: boolean; sequence: number } | undefined;
  let loadSequence = 0;

  const refresh = (refreshOptions: PiWebStatusCacheRefreshOptions = {}): Promise<PiWebStatusResponse> => {
    const force = refreshOptions.force === true;
    if (pending !== undefined && (!force || pending.force)) return pending.promise;

    const sequence = ++loadSequence;
    const promise = Promise.resolve()
      .then(() => load({ force }))
      .then((status) => {
        if (sequence === loadSequence) cached = { status, expiresAt: now() + ttlMs };
        return status;
      })
      .finally(() => {
        if (pending?.sequence === sequence) pending = undefined;
      });
    pending = { promise, force, sequence };
    return promise;
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
      loadSequence += 1;
      pending = undefined;
    },
  };
}
