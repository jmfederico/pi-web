import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelCatalogRefresher } from "./modelCatalogRefresher.js";

interface RefreshCall {
  allowNetwork?: boolean;
  force?: boolean;
  signal?: AbortSignal;
}

interface RefreshResult {
  aborted: boolean;
  errors: Map<string, Error>;
}

const okResult = (): RefreshResult => ({ aborted: false, errors: new Map<string, Error>() });
const abortedResult = (): RefreshResult => ({ aborted: true, errors: new Map<string, Error>() });

function deferred<T>() {
  let resolveValue: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}

function createRuntime() {
  const calls: RefreshCall[] = [];
  const refresh = vi.fn((options?: RefreshCall) => {
    calls.push(options ?? {});
    return Promise.resolve(okResult());
  });
  return { refresh, calls };
}

function createLogger() {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  return { logger: { info, warn, error }, info, warn, error };
}

/** Let a started refresh run to completion, including the finally-queue bookkeeping. */
async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let index = 0; index < rounds; index++) await Promise.resolve();
}

describe("ModelCatalogRefresher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a bounded network refresh when one is requested", async () => {
    const runtime = createRuntime();
    const refresher = new ModelCatalogRefresher({ runtime });

    refresher.requestRefresh();
    await flushMicrotasks();

    expect(runtime.refresh).toHaveBeenCalledOnce();
    const call = runtime.calls.at(0);
    expect(call?.allowNetwork).toBe(true);
    expect(call?.signal).toBeInstanceOf(AbortSignal);
    refresher.dispose();
  });

  it("forces auth-triggered refreshes past pi's freshness gate", async () => {
    const runtime = createRuntime();
    const refresher = new ModelCatalogRefresher({ runtime });

    refresher.requestRefresh();
    await flushMicrotasks();

    expect(runtime.calls.at(0)?.force).toBe(true);
    refresher.dispose();
  });

  it("leaves scheduled refreshes unforced so pi's freshness gate stays in charge", async () => {
    const runtime = createRuntime();
    const refresher = new ModelCatalogRefresher({ runtime, initialDelayMs: 1_000, intervalMs: 60_000 });
    refresher.start();

    await vi.advanceTimersByTimeAsync(61_000);

    expect(runtime.refresh).toHaveBeenCalledTimes(2);
    expect(runtime.calls.map((call) => call.force)).toEqual([false, false]);
    refresher.dispose();
  });

  it("keeps a forced request forced when it is queued behind a scheduled run", async () => {
    const gate = deferred<RefreshResult>();
    const calls: RefreshCall[] = [];
    const refresh = vi.fn((options?: RefreshCall) => {
      calls.push(options ?? {});
      return calls.length === 1 ? gate.promise : Promise.resolve(okResult());
    });
    const refresher = new ModelCatalogRefresher({ runtime: { refresh }, initialDelayMs: 1_000, intervalMs: 60_000 });
    refresher.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.at(0)?.force).toBe(false);

    refresher.requestRefresh();
    gate.resolve(okResult());
    await flushMicrotasks();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(calls.at(1)?.force).toBe(true);
    refresher.dispose();
  });

  it("refreshes well within pi's four-hour freshness window", async () => {
    const fourHoursMs = 4 * 60 * 60 * 1000;
    const runtime = createRuntime();
    // Defaults matter here: the bug this pins is a scheduled interval that lands
    // just short of pi's TTL and therefore only fetches on every other tick.
    const refresher = new ModelCatalogRefresher({ runtime });
    refresher.start();

    await vi.advanceTimersByTimeAsync(fourHoursMs);

    // Ticks are cheap because scheduled runs never force, so several land inside
    // one TTL window and at least one is guaranteed to be past the gate.
    expect(runtime.refresh.mock.calls.length).toBeGreaterThan(2);
    refresher.dispose();
  });

  it("coalesces overlapping requests into a single follow-up run", async () => {
    const gate = deferred<RefreshResult>();
    const refresh = vi.fn()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue(okResult());
    const refresher = new ModelCatalogRefresher({ runtime: { refresh } });

    refresher.requestRefresh();
    refresher.requestRefresh();
    refresher.requestRefresh();
    expect(refresh).toHaveBeenCalledOnce();

    gate.resolve(okResult());
    await flushMicrotasks();

    expect(refresh).toHaveBeenCalledTimes(2);
    refresher.dispose();
  });

  it("refreshes after the initial delay and then on the interval", async () => {
    const runtime = createRuntime();
    const refresher = new ModelCatalogRefresher({ runtime, initialDelayMs: 1_000, intervalMs: 60_000 });
    refresher.start();

    await vi.advanceTimersByTimeAsync(999);
    expect(runtime.refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.refresh).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.refresh).toHaveBeenCalledTimes(2);
    refresher.dispose();
  });

  it("stops scheduling refreshes after dispose", async () => {
    const runtime = createRuntime();
    const refresher = new ModelCatalogRefresher({ runtime, initialDelayMs: 1_000, intervalMs: 60_000 });
    refresher.start();
    refresher.dispose();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it("aborts the in-flight refresh when disposed", async () => {
    const { logger, info, warn, error } = createLogger();
    let observed: AbortSignal | undefined;
    // Stand in for a provider fetch that only settles when its signal aborts,
    // which is what makes an unaborted run delay daemon shutdown.
    const refresh = vi.fn((options?: RefreshCall) => {
      observed = options?.signal;
      return new Promise<RefreshResult>((resolve) => {
        options?.signal?.addEventListener("abort", () => { resolve(abortedResult()); });
      });
    });
    const refresher = new ModelCatalogRefresher({ runtime: { refresh }, logger });

    refresher.requestRefresh();
    await flushMicrotasks();
    expect(observed?.aborted).toBe(false);

    refresher.dispose();
    await flushMicrotasks();

    expect(observed?.aborted).toBe(true);
    // A deliberate shutdown abort is expected, not a timeout or a fault.
    expect(info).toHaveBeenCalledWith({}, "model catalog refresh aborted by dispose; keeping cached catalogs");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("does not report a refresh that rejects because dispose aborted it as a failure", async () => {
    const { logger, info, warn, error } = createLogger();
    const refresh = vi.fn((options?: RefreshCall) => new Promise<RefreshResult>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => { reject(new Error("This operation was aborted")); });
    }));
    const refresher = new ModelCatalogRefresher({ runtime: { refresh }, logger });

    refresher.requestRefresh();
    await flushMicrotasks();
    refresher.dispose();
    await flushMicrotasks();

    expect(info).toHaveBeenCalledWith({}, "model catalog refresh aborted by dispose; keeping cached catalogs");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps the timers of the first start when start is called again", async () => {
    const runtime = createRuntime();
    const refresher = new ModelCatalogRefresher({ runtime, initialDelayMs: 1_000, intervalMs: 60_000 });

    refresher.start();
    refresher.start();

    await vi.advanceTimersByTimeAsync(61_000);

    // A leaked second timer pair would double every scheduled refresh.
    expect(runtime.refresh).toHaveBeenCalledTimes(2);

    refresher.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runtime.refresh).toHaveBeenCalledTimes(2);
  });

  it("does not run a queued follow-up after dispose", async () => {
    const gate = deferred<RefreshResult>();
    const refresh = vi.fn().mockImplementation(() => gate.promise);
    const refresher = new ModelCatalogRefresher({ runtime: { refresh } });

    refresher.requestRefresh();
    refresher.requestRefresh();
    refresher.dispose();
    gate.resolve(okResult());
    await flushMicrotasks();

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("retries once after an aborted run and then waits for the schedule", async () => {
    const { logger, info } = createLogger();
    const refresh = vi.fn()
      .mockResolvedValueOnce(abortedResult())
      .mockResolvedValueOnce(abortedResult())
      .mockResolvedValue(okResult());
    const refresher = new ModelCatalogRefresher({ runtime: { refresh }, logger, retryDelayMs: 30_000, intervalMs: 3_600_000 });

    refresher.requestRefresh();
    await flushMicrotasks();
    expect(refresh).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith({ retryDelayMs: 30_000, mode: "forced" }, "scheduling one model catalog refresh retry");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);

    // The retry also failed, but a retry never earns another retry.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    refresher.dispose();
  });

  it("retries once after a run reports provider errors", async () => {
    const errors = new Map<string, Error>([["openrouter", new Error("boom")]]);
    const refresh = vi.fn()
      .mockResolvedValueOnce({ aborted: false, errors })
      .mockResolvedValue(okResult());
    const refresher = new ModelCatalogRefresher({ runtime: { refresh }, retryDelayMs: 30_000 });

    refresher.requestRefresh();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    refresher.dispose();
  });

  it("does not schedule a retry after a successful run", async () => {
    const runtime = createRuntime();
    const refresher = new ModelCatalogRefresher({ runtime, retryDelayMs: 30_000, intervalMs: 3_600_000 });

    refresher.requestRefresh();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(runtime.refresh).toHaveBeenCalledOnce();
    refresher.dispose();
  });

  it("drops a pending retry when dispose happens first", async () => {
    const refresh = vi.fn()
      .mockResolvedValueOnce(abortedResult())
      .mockResolvedValue(okResult());
    const refresher = new ModelCatalogRefresher({ runtime: { refresh }, retryDelayMs: 30_000 });

    refresher.requestRefresh();
    await flushMicrotasks();
    refresher.dispose();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("lets a new request supersede a pending retry instead of running both", async () => {
    const refresh = vi.fn()
      .mockResolvedValueOnce(abortedResult())
      .mockResolvedValue(okResult());
    const refresher = new ModelCatalogRefresher({ runtime: { refresh }, retryDelayMs: 30_000 });

    refresher.requestRefresh();
    await flushMicrotasks();

    refresher.requestRefresh();
    await flushMicrotasks();
    expect(refresh).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    refresher.dispose();
  });

  it("reports an in-flight network refresh only while one is actually running", async () => {
    const gate = deferred<RefreshResult>();
    const refresh = vi.fn(() => gate.promise);
    const refresher = new ModelCatalogRefresher({ runtime: { refresh } });

    expect(refresher.isRefreshInFlight()).toBe(false);

    refresher.requestRefresh();
    expect(refresher.isRefreshInFlight()).toBe(true);

    gate.resolve(okResult());
    await flushMicrotasks();

    expect(refresher.isRefreshInFlight()).toBe(false);
    refresher.dispose();
  });

  it("never reports a refresh in flight in offline mode, where no refresh is ever run", async () => {
    const runtime = createRuntime();
    const refresher = new ModelCatalogRefresher({ runtime, offline: true, initialDelayMs: 1_000, intervalMs: 60_000 });

    refresher.start();
    refresher.requestRefresh();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(refresher.isRefreshInFlight()).toBe(false);
    refresher.dispose();
  });

  it("never touches the network when offline mode is enabled", async () => {
    const runtime = createRuntime();
    const { logger, info } = createLogger();
    const refresher = new ModelCatalogRefresher({ runtime, logger, offline: true, initialDelayMs: 1_000, intervalMs: 60_000 });

    refresher.start();
    await vi.advanceTimersByTimeAsync(300_000);
    refresher.requestRefresh();
    await flushMicrotasks();

    expect(runtime.refresh).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith({}, "offline mode is enabled; skipping background model catalog refreshes");
    refresher.dispose();
  });

  it("warns and keeps going when a refresh is aborted by its timeout", async () => {
    const { logger, warn, error } = createLogger();
    const refresh = vi.fn(() => Promise.resolve({ aborted: true, errors: new Map<string, Error>() }));
    const refresher = new ModelCatalogRefresher({ runtime: { refresh }, logger });

    refresher.requestRefresh();
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    refresher.dispose();
  });

  it("warns with provider details when a refresh reports provider errors", async () => {
    const { logger, warn } = createLogger();
    const errors = new Map<string, Error>([["openrouter", new Error("boom")]]);
    const refresh = vi.fn(() => Promise.resolve({ aborted: false, errors }));
    const refresher = new ModelCatalogRefresher({ runtime: { refresh }, logger });

    refresher.requestRefresh();
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledWith(
      { providers: ["openrouter: boom"] },
      "model catalog refresh failed for some providers; keeping cached catalogs",
    );
    refresher.dispose();
  });

  it("logs and swallows a rejecting refresh so timers stay alive", async () => {
    const { logger, error } = createLogger();
    const failure = new Error("refresh exploded");
    const refresh = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(okResult());
    const refresher = new ModelCatalogRefresher({ runtime: { refresh }, logger, initialDelayMs: 1_000, intervalMs: 60_000 });

    refresher.requestRefresh();
    await flushMicrotasks();

    expect(error).toHaveBeenCalledWith({ err: failure }, "model catalog refresh failed; keeping cached catalogs");

    refresher.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    refresher.dispose();
  });
});
