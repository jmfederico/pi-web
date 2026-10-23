import { describe, expect, it, vi } from "vitest";
import { TrailingRefreshCoordinator } from "./trailingRefreshCoordinator";

describe("TrailingRefreshCoordinator completion boundary", () => {
  it("does not lose a request between the final trailing check and promise settlement", async () => {
    const coordinator = new TrailingRefreshCoordinator<string>();
    const refresh = vi.fn(() => Promise.resolve());
    const first = coordinator.request("session", refresh);
    // Reach the microtask after the resolved refresh's final trailing check,
    // before a separate promise.finally cleanup would have retired the key.
    await Promise.resolve();
    await Promise.resolve();
    const next = coordinator.request("session", refresh);
    await Promise.all([first, next]);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
