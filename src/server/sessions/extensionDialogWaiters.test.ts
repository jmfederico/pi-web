import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingExtensionDialog } from "../../shared/apiTypes.js";
import { ExtensionDialogWaiters, effectiveExtensionDialogTimeoutMs, extensionDialogCancelValue } from "./extensionDialogWaiters.js";

function dialog(patch: Partial<PendingExtensionDialog> = {}): PendingExtensionDialog {
  return {
    dialogId: "dialog-1",
    kind: "confirm",
    title: "Continue?",
    askedAt: "2026-02-01T10:00:00.000Z",
    runScoped: false,
    ...patch,
  };
}

/** Observe a parked wait without hanging the test when it never settles. */
async function settledValue(promise: Promise<boolean | string | undefined>): Promise<{ settled: true; value: boolean | string | undefined } | { settled: false }> {
  return await Promise.race([
    promise.then((value) => ({ settled: true as const, value })),
    Promise.resolve({ settled: false as const }),
  ]);
}

describe("extensionDialogCancelValue", () => {
  it("matches the SDK cancel value of each dialog kind", () => {
    expect(extensionDialogCancelValue("confirm")).toBe(false);
    expect(extensionDialogCancelValue("select")).toBeUndefined();
    expect(extensionDialogCancelValue("input")).toBeUndefined();
  });
});

describe("effectiveExtensionDialogTimeoutMs", () => {
  it("picks the sooner of the extension timeout and the daemon default", () => {
    expect(effectiveExtensionDialogTimeoutMs(1_000, 300_000)).toBe(1_000);
    expect(effectiveExtensionDialogTimeoutMs(600_000, 300_000)).toBe(300_000);
  });

  it("treats an absent or unusable extension timeout as the daemon default alone", () => {
    expect(effectiveExtensionDialogTimeoutMs(undefined, 300_000)).toBe(300_000);
    expect(effectiveExtensionDialogTimeoutMs(Number.NaN, 300_000)).toBe(300_000);
    expect(effectiveExtensionDialogTimeoutMs(-5, 300_000)).toBe(300_000);
  });

  it("treats a zero daemon default as waiting forever", () => {
    expect(effectiveExtensionDialogTimeoutMs(undefined, 0)).toBeUndefined();
    expect(effectiveExtensionDialogTimeoutMs(1_000, 0)).toBe(1_000);
  });
});

describe("ExtensionDialogWaiters", () => {
  it("resolves a settled wait with the user's answer", async () => {
    const waiters = new ExtensionDialogWaiters();
    const parked = waiters.park(dialog());

    expect(waiters.settleWithAnswer("dialog-1", true)).toBe(true);

    await expect(parked).resolves.toBe(true);
  });

  it("resolves a close without an answer with the dialog kind's cancel value", async () => {
    const waiters = new ExtensionDialogWaiters();
    const confirm = waiters.park(dialog({ dialogId: "dialog-1", kind: "confirm" }));
    const select = waiters.park(dialog({ dialogId: "dialog-2", kind: "select", options: ["a"] }));

    waiters.settleWithCancelValue("dialog-1");
    waiters.settleWithCancelValue("dialog-2");

    await expect(confirm).resolves.toBe(false);
    await expect(select).resolves.toBeUndefined();
  });

  it("reports an unknown dialog instead of settling anything", () => {
    const waiters = new ExtensionDialogWaiters();

    expect(waiters.settleWithAnswer("nobody", true)).toBe(false);
    expect(waiters.settleWithCancelValue("nobody")).toBe(false);
  });

  it("fires the cancel trigger when the extension aborts its signal", () => {
    const waiters = new ExtensionDialogWaiters();
    const controller = new AbortController();
    const triggers: string[] = [];
    void waiters.park(dialog(), { signal: controller.signal, onTrigger: (reason) => { triggers.push(reason); } });

    controller.abort();

    expect(triggers).toEqual(["cancelled"]);
  });

  it("unsubscribes the signal on settle, so a later abort cannot trigger a settled wait", () => {
    const waiters = new ExtensionDialogWaiters();
    const controller = new AbortController();
    const triggers: string[] = [];
    void waiters.park(dialog(), { signal: controller.signal, onTrigger: (reason) => { triggers.push(reason); } });

    waiters.settleWithCancelValue("dialog-1");
    controller.abort();

    expect(triggers).toEqual([]);
  });

  it("settles each parked wait exactly once even when settle is repeated", async () => {
    const waiters = new ExtensionDialogWaiters();
    const parked = waiters.park(dialog());

    expect(waiters.settleWithAnswer("dialog-1", true)).toBe(true);
    expect(waiters.settleWithAnswer("dialog-1", false)).toBe(false);

    await expect(parked).resolves.toBe(true);
  });
});

describe("ExtensionDialogWaiters timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the timeout trigger when the armed delay elapses", async () => {
    vi.useFakeTimers();
    const waiters = new ExtensionDialogWaiters();
    const triggers: string[] = [];
    const parked = waiters.park(dialog(), { timeoutMs: 5_000, onTrigger: (reason) => { triggers.push(reason); } });

    vi.advanceTimersByTime(5_000);

    expect(triggers).toEqual(["timeout"]);
    await expect(settledValue(parked)).resolves.toEqual({ settled: false });
  });

  it("arms no timer when the dialog waits forever", () => {
    vi.useFakeTimers();
    const waiters = new ExtensionDialogWaiters();

    void waiters.park(dialog());

    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the timer when the wait settles, so the timeout cannot fire afterwards", async () => {
    vi.useFakeTimers();
    const waiters = new ExtensionDialogWaiters();
    const triggers: string[] = [];
    const parked = waiters.park(dialog(), { timeoutMs: 5_000, onTrigger: (reason) => { triggers.push(reason); } });

    waiters.settleWithAnswer("dialog-1", true);
    vi.advanceTimersByTime(10_000);

    expect(triggers).toEqual([]);
    await expect(parked).resolves.toBe(true);
  });
});
