import { describe, expect, it } from "vitest";
import { doesNotFillViewport, isNearTop, shouldRequestEarlierMessages } from "./chatHistoryLoading";

describe("chat history loading decisions", () => {
  const base = {
    hasMore: true,
    loadingMore: false,
    canRequest: true,
    scrollTop: 200,
    scrollHeight: 1000,
    clientHeight: 500,
  };

  it("requests earlier messages near the top", () => {
    expect(shouldRequestEarlierMessages({ ...base, scrollTop: 20 })).toBe(true);
  });

  it("requests earlier messages when loaded content does not fill the viewport", () => {
    expect(shouldRequestEarlierMessages({ ...base, scrollHeight: 500, clientHeight: 500 })).toBe(true);
  });

  it("does not request while loading", () => {
    expect(shouldRequestEarlierMessages({ ...base, loadingMore: true, scrollTop: 0 })).toBe(false);
  });

  it("does not request when there is no earlier history", () => {
    expect(shouldRequestEarlierMessages({ ...base, hasMore: false, scrollTop: 0 })).toBe(false);
  });

  it("does not request when no callback is available", () => {
    expect(shouldRequestEarlierMessages({ ...base, canRequest: false, scrollTop: 0 })).toBe(false);
  });

  it("uses a small tolerance for underfilled viewports", () => {
    expect(doesNotFillViewport({ scrollHeight: 501, clientHeight: 500 })).toBe(true);
    expect(doesNotFillViewport({ scrollHeight: 502, clientHeight: 500 })).toBe(false);
  });

  it("allows a custom top threshold", () => {
    expect(isNearTop({ scrollTop: 80, topThreshold: 100 })).toBe(true);
    expect(isNearTop({ scrollTop: 100, topThreshold: 100 })).toBe(false);
  });
});
