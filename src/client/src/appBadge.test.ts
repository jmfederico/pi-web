import { describe, expect, it, vi } from "vitest";
import { clearAppBadge } from "./appBadge";

describe("clearAppBadge", () => {
  it("does nothing when the Badging API is unsupported", () => {
    expect(() => { clearAppBadge({}); }).not.toThrow();
  });

  it("calls navigator.clearAppBadge when available", () => {
    const clearAppBadgeMock = vi.fn().mockResolvedValue(undefined);
    clearAppBadge({ clearAppBadge: clearAppBadgeMock });
    expect(clearAppBadgeMock).toHaveBeenCalled();
  });

  it("swallows rejections from clearAppBadge", async () => {
    const clearAppBadgeMock = vi.fn().mockRejectedValue(new Error("nope"));
    expect(() => { clearAppBadge({ clearAppBadge: clearAppBadgeMock }); }).not.toThrow();
    await Promise.resolve();
  });
});
