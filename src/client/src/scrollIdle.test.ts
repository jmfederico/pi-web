import { describe, expect, it } from "vitest";
import { ScrollIdleTracker } from "./scrollIdle";

class FakeScheduler {
  private current = 0;
  private nextId = 1;
  private timers: { id: number; at: number; callback: () => void }[] = [];

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.push({ id, at: this.current + delayMs, callback });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  }

  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.current = due.at;
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      due.callback();
    }
    this.current = target;
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function observe(promise: Promise<void>): { resolved: () => boolean } {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  return { resolved: () => done };
}

describe("ScrollIdleTracker", () => {
  it("resolves immediately when the scroll is already idle", async () => {
    const scheduler = new FakeScheduler();
    const tracker = new ScrollIdleTracker(scheduler, 160);
    const waiter = observe(tracker.whenIdle());
    await flushMicrotasks();
    expect(waiter.resolved()).toBe(true);
  });

  it("waits for recent scroll activity to settle", async () => {
    const scheduler = new FakeScheduler();
    const tracker = new ScrollIdleTracker(scheduler, 160);
    scheduler.advance(1000);
    tracker.noteScrollActivity();
    const waiter = observe(tracker.whenIdle());
    await flushMicrotasks();
    expect(waiter.resolved()).toBe(false);

    scheduler.advance(159);
    await flushMicrotasks();
    expect(waiter.resolved()).toBe(false);

    scheduler.advance(1);
    await flushMicrotasks();
    expect(waiter.resolved()).toBe(true);
  });

  it("extends the wait while scroll events keep arriving", async () => {
    const scheduler = new FakeScheduler();
    const tracker = new ScrollIdleTracker(scheduler, 160);
    scheduler.advance(1000);
    tracker.noteScrollActivity();
    const waiter = observe(tracker.whenIdle());

    scheduler.advance(100);
    tracker.noteScrollActivity();
    scheduler.advance(100);
    await flushMicrotasks();
    expect(waiter.resolved()).toBe(false);

    scheduler.advance(60);
    await flushMicrotasks();
    expect(waiter.resolved()).toBe(true);
  });

  it("waits for the touch gesture to end, then for momentum to settle", async () => {
    const scheduler = new FakeScheduler();
    const tracker = new ScrollIdleTracker(scheduler, 160);
    scheduler.advance(1000);
    tracker.noteTouchStart();
    const waiter = observe(tracker.whenIdle());
    scheduler.advance(1000);
    await flushMicrotasks();
    expect(waiter.resolved()).toBe(false);

    tracker.noteScrollActivity();
    tracker.noteTouchEnd();
    scheduler.advance(159);
    await flushMicrotasks();
    expect(waiter.resolved()).toBe(false);
    scheduler.advance(1);
    await flushMicrotasks();
    expect(waiter.resolved()).toBe(true);
  });

  it("resolves at the max wait even while the scroll is still active", async () => {
    const scheduler = new FakeScheduler();
    const tracker = new ScrollIdleTracker(scheduler, 160);
    scheduler.advance(1000);
    tracker.noteTouchStart();
    const waiter = observe(tracker.whenIdle(500));
    scheduler.advance(500);
    await flushMicrotasks();
    expect(waiter.resolved()).toBe(true);
  });

  it("reports isIdle from touch and scroll activity", () => {
    const scheduler = new FakeScheduler();
    const tracker = new ScrollIdleTracker(scheduler, 160);
    expect(tracker.isIdle).toBe(true);

    scheduler.advance(1000);
    tracker.noteScrollActivity();
    expect(tracker.isIdle).toBe(false);
    scheduler.advance(160);
    expect(tracker.isIdle).toBe(true);

    tracker.noteTouchStart();
    expect(tracker.isIdle).toBe(false);
    scheduler.advance(1000);
    expect(tracker.isIdle).toBe(false);
    tracker.noteTouchEnd();
    expect(tracker.isIdle).toBe(true);
  });

  it("flushWaiters resolves pending waiters without resetting activity", async () => {
    const scheduler = new FakeScheduler();
    const tracker = new ScrollIdleTracker(scheduler, 160);
    scheduler.advance(1000);
    tracker.noteTouchStart();
    const waiter = observe(tracker.whenIdle());
    tracker.flushWaiters();
    await flushMicrotasks();
    expect(waiter.resolved()).toBe(true);

    const next = observe(tracker.whenIdle());
    await flushMicrotasks();
    expect(next.resolved()).toBe(false);
  });
});
