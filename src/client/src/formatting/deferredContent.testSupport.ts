import { afterEach, beforeEach, vi } from "vitest";
import type { ReactiveElement } from "lit";

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

/** Drive browser scheduling explicitly; happy-dom cannot establish viewport geometry. */
export function useDeferredContent(): void {
  beforeEach(() => {
    frames.clear();
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  });
  afterEach(() => {
    document.body.replaceChildren();
    frames.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}

export async function advanceContentFrame(element?: ReactiveElement): Promise<void> {
  await element?.updateComplete;
  const batch = [...frames.values()];
  frames.clear();
  for (const callback of batch) callback(performance.now());
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise((resolve) => setTimeout(resolve, 0));
  await element?.updateComplete;
}

export async function settleDeferredContent(element?: ReactiveElement): Promise<void> {
  await element?.updateComplete;
  for (let turn = 0; frames.size > 0; turn += 1) {
    if (turn > 200) throw new Error("Content enhancements did not settle");
    await advanceContentFrame(element);
  }
}
