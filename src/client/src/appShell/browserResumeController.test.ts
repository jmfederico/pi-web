import { describe, expect, it, vi } from "vitest";
import { BrowserResumeController } from "./browserResumeController";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolveDeferred = resolve; });
  if (resolveDeferred === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolveDeferred };
}

function frameHarness() {
  const frames: { callback: () => void; canceled: boolean }[] = [];
  return {
    scheduleFrame: (callback: () => void) => {
      const frame = { callback, canceled: false };
      frames.push(frame);
      return { cancel: () => { frame.canceled = true; } };
    },
    pendingCount: () => frames.filter((frame) => !frame.canceled).length,
    runNext: () => {
      const frame = frames.shift();
      if (frame === undefined) throw new Error("No scheduled frame");
      if (!frame.canceled) frame.callback();
    },
  };
}

describe("BrowserResumeController", () => {
  it("batches overlapping focus, visibility, pageshow, and online signals into one app refresh", async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const frames = frameHarness();
    const refreshGate = deferred<undefined>();
    const refreshStarted = deferred<undefined>();
    const refreshCompleted = deferred<undefined>();
    const onResumeSignal = vi.fn();
    let refreshCalls = 0;
    const controller = new BrowserResumeController({
      onResumeSignal,
      refreshAfterResume: async () => {
        refreshCalls += 1;
        refreshStarted.resolve(undefined);
        await refreshGate.promise;
        refreshCompleted.resolve(undefined);
      },
      onRefreshError: (error) => { throw error; },
    }, {
      windowTarget,
      documentTarget,
      isDocumentVisible: () => true,
      scheduleFrame: frames.scheduleFrame,
    });
    controller.connect();

    windowTarget.dispatchEvent(new Event("focus"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("pageshow"));
    windowTarget.dispatchEvent(new Event("online"));
    windowTarget.dispatchEvent(new Event("focus"));

    expect(onResumeSignal).toHaveBeenCalledTimes(5);
    expect(frames.pendingCount()).toBe(1);
    expect(refreshCalls).toBe(0);

    frames.runNext();
    await refreshStarted.promise;
    expect(refreshCalls).toBe(1);

    expect(frames.pendingCount()).toBe(0);
    refreshGate.resolve(undefined);
    await refreshCompleted.promise;
    controller.disconnect();
  });

  it.each(["focus", "pageshow", "online", "visibilitychange"])("ignores %s while the document is hidden", (type) => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const frames = frameHarness();
    const onResumeSignal = vi.fn();
    const refreshAfterResume = vi.fn();
    let visible = false;
    const controller = new BrowserResumeController({
      onResumeSignal,
      refreshAfterResume,
      onRefreshError: (error) => { throw error; },
    }, {
      windowTarget,
      documentTarget,
      isDocumentVisible: () => visible,
      scheduleFrame: frames.scheduleFrame,
    });
    controller.connect();
    const target = type === "visibilitychange" ? documentTarget : windowTarget;

    target.dispatchEvent(new Event(type));

    expect(onResumeSignal).not.toHaveBeenCalled();
    expect(frames.pendingCount()).toBe(0);
    expect(refreshAfterResume).not.toHaveBeenCalled();

    visible = true;
    target.dispatchEvent(new Event(type));
    expect(onResumeSignal).toHaveBeenCalledTimes(1);
    expect(frames.pendingCount()).toBe(1);
    controller.disconnect();
  });

  it("removes all resume listeners and cancels a pending refresh on disconnect", async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const frames = frameHarness();
    const onResumeSignal = vi.fn();
    const refreshAfterResume = vi.fn();
    const controller = new BrowserResumeController({
      onResumeSignal,
      refreshAfterResume,
      onRefreshError: (error) => { throw error; },
    }, {
      windowTarget,
      documentTarget,
      isDocumentVisible: () => true,
      scheduleFrame: frames.scheduleFrame,
    });
    const dispatchResumeSignals = () => {
      for (const type of ["focus", "pageshow", "online"]) windowTarget.dispatchEvent(new Event(type));
      documentTarget.dispatchEvent(new Event("visibilitychange"));
    };
    controller.connect();
    dispatchResumeSignals();
    expect(onResumeSignal).toHaveBeenCalledTimes(4);
    expect(frames.pendingCount()).toBe(1);

    controller.disconnect();
    expect(frames.pendingCount()).toBe(0);
    frames.runNext();
    await Promise.resolve();
    dispatchResumeSignals();

    expect(onResumeSignal).toHaveBeenCalledTimes(4);
    expect(frames.pendingCount()).toBe(0);
    expect(refreshAfterResume).not.toHaveBeenCalled();

    controller.connect();
    windowTarget.dispatchEvent(new Event("pageshow"));
    expect(onResumeSignal).toHaveBeenCalledTimes(5);
    expect(frames.pendingCount()).toBe(1);
    controller.disconnect();
  });

  it("runs one trailing refresh when another resume arrives during active work", async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const frames = frameHarness();
    const firstGate = deferred<undefined>();
    const secondGate = deferred<undefined>();
    const firstStarted = deferred<undefined>();
    const secondStarted = deferred<undefined>();
    const secondCompleted = deferred<undefined>();
    let refreshCalls = 0;
    const controller = new BrowserResumeController({
      onResumeSignal: () => undefined,
      refreshAfterResume: async () => {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          firstStarted.resolve(undefined);
          await firstGate.promise;
          return;
        }
        secondStarted.resolve(undefined);
        await secondGate.promise;
        secondCompleted.resolve(undefined);
      },
      onRefreshError: (error) => { throw error; },
    }, {
      windowTarget,
      documentTarget,
      isDocumentVisible: () => true,
      scheduleFrame: frames.scheduleFrame,
    });
    controller.connect();

    windowTarget.dispatchEvent(new Event("pageshow"));
    frames.runNext();
    await firstStarted.promise;

    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("focus"));
    windowTarget.dispatchEvent(new Event("pageshow"));
    windowTarget.dispatchEvent(new Event("online"));
    expect(frames.pendingCount()).toBe(1);
    frames.runNext();
    expect(refreshCalls).toBe(1);

    firstGate.resolve(undefined);
    await secondStarted.promise;
    expect(refreshCalls).toBe(2);

    secondGate.resolve(undefined);
    await secondCompleted.promise;
    controller.disconnect();
  });
});
