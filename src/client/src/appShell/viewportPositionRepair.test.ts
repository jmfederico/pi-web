import { describe, expect, it } from "vitest";
import { VIEWPORT_POSITION_REPAIR_DELAY_MS, ViewportPositionRepairer, type ViewportPositionRepairScheduler } from "./viewportPositionRepair";

class FakeViewportScheduler implements ViewportPositionRepairScheduler {
  viewportScale = 1;
  documentElement = { scrollTop: 12 };
  body = { scrollTop: 34 };
  scrollCalls: [number, number][] = [];
  animationFrames = new Map<number, () => void>();
  timers = new Map<number, { callback: () => void; delayMs: number }>();
  canceledAnimationFrames: number[] = [];
  clearedTimers: number[] = [];
  private nextId = 1;

  requestAnimationFrame(callback: () => void): number {
    const id = this.nextId;
    this.nextId += 1;
    this.animationFrames.set(id, callback);
    return id;
  }

  cancelAnimationFrame(id: number): void {
    this.canceledAnimationFrames.push(id);
    this.animationFrames.delete(id);
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(id: number): void {
    this.clearedTimers.push(id);
    this.timers.delete(id);
  }

  scrollTo(x: number, y: number): void {
    this.scrollCalls.push([x, y]);
  }

  runAnimationFrame(id: number): void {
    const callback = this.animationFrames.get(id);
    if (callback === undefined) throw new Error(`Animation frame ${String(id)} not scheduled`);
    this.animationFrames.delete(id);
    callback();
  }

  runTimer(id: number): void {
    const timer = this.timers.get(id);
    if (timer === undefined) throw new Error(`Timer ${String(id)} not scheduled`);
    this.timers.delete(id);
    timer.callback();
  }
}

function firstMapKey<K, V>(map: Map<K, V>): K {
  const key = map.keys().next().value;
  if (key === undefined) throw new Error("Expected map to have a key");
  return key;
}

function firstMapEntry<K, V>(map: Map<K, V>): [K, V] {
  const entry = map.entries().next().value;
  if (entry === undefined) throw new Error("Expected map to have an entry");
  return entry;
}

describe("ViewportPositionRepairer", () => {
  it("resets viewport position immediately, across two animation frames, and on a delayed timer", () => {
    const scheduler = new FakeViewportScheduler();
    const repairer = new ViewportPositionRepairer(scheduler);

    repairer.repair(true);

    expect(scheduler.scrollCalls).toEqual([[0, 0]]);
    expect(scheduler.documentElement.scrollTop).toBe(0);
    expect(scheduler.body.scrollTop).toBe(0);
    const firstFrame = firstMapKey(scheduler.animationFrames);
    const timer = firstMapEntry(scheduler.timers);
    expect(timer[1].delayMs).toBe(VIEWPORT_POSITION_REPAIR_DELAY_MS);

    scheduler.documentElement.scrollTop = 56;
    scheduler.body.scrollTop = 78;
    scheduler.runAnimationFrame(firstFrame);
    expect(scheduler.scrollCalls).toEqual([[0, 0], [0, 0]]);
    expect(scheduler.documentElement.scrollTop).toBe(0);
    expect(scheduler.body.scrollTop).toBe(0);
    const secondFrame = firstMapKey(scheduler.animationFrames);

    scheduler.documentElement.scrollTop = 90;
    scheduler.body.scrollTop = 123;
    scheduler.runAnimationFrame(secondFrame);
    expect(scheduler.scrollCalls).toEqual([[0, 0], [0, 0], [0, 0]]);
    expect(scheduler.documentElement.scrollTop).toBe(0);
    expect(scheduler.body.scrollTop).toBe(0);

    scheduler.documentElement.scrollTop = 34;
    scheduler.body.scrollTop = 12;
    scheduler.runTimer(timer[0]);
    expect(scheduler.scrollCalls).toEqual([[0, 0], [0, 0], [0, 0], [0, 0]]);
    expect(scheduler.documentElement.scrollTop).toBe(0);
    expect(scheduler.body.scrollTop).toBe(0);
  });

  it("does not fight pinch zoom even when resume retries are pending", () => {
    const scheduler = new FakeViewportScheduler();
    const repairer = new ViewportPositionRepairer(scheduler);
    repairer.repair(true);
    scheduler.viewportScale = 2;
    scheduler.runAnimationFrame(firstMapKey(scheduler.animationFrames));
    scheduler.runAnimationFrame(firstMapKey(scheduler.animationFrames));
    scheduler.runTimer(firstMapKey(scheduler.timers));
    repairer.repairNow();
    expect(scheduler.scrollCalls).toEqual([[0, 0]]);
    scheduler.viewportScale = 1;
    repairer.repairNow();
    expect(scheduler.scrollCalls).toEqual([[0, 0], [0, 0]]);
  });

  it("replaces pending scheduled repairs", () => {
    const scheduler = new FakeViewportScheduler();
    const repairer = new ViewportPositionRepairer(scheduler);

    repairer.repair(true);
    const firstFrame = firstMapKey(scheduler.animationFrames);
    const firstTimer = firstMapKey(scheduler.timers);
    repairer.repair(true);

    expect(scheduler.canceledAnimationFrames).toEqual([firstFrame]);
    expect(scheduler.clearedTimers).toEqual([firstTimer]);
    expect(scheduler.animationFrames.has(firstFrame)).toBe(false);
    expect(scheduler.timers.has(firstTimer)).toBe(false);
    expect(scheduler.animationFrames.size).toBe(1);
    expect(scheduler.timers.size).toBe(1);
  });

  it("clears pending work when repair is no longer needed", () => {
    const scheduler = new FakeViewportScheduler();
    const repairer = new ViewportPositionRepairer(scheduler);

    repairer.repair(true);
    const firstFrame = firstMapKey(scheduler.animationFrames);
    const firstTimer = firstMapKey(scheduler.timers);
    repairer.repair(false);

    expect(scheduler.canceledAnimationFrames).toEqual([firstFrame]);
    expect(scheduler.clearedTimers).toEqual([firstTimer]);
    expect(scheduler.animationFrames.size).toBe(0);
    expect(scheduler.timers.size).toBe(0);
  });
});
