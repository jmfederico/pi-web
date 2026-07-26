import { describe, expect, it } from "vitest";
import { restorePrependScrollAnchor, scrollDeltaForMarker, scrollTopForBottomDistance, selectPrependMarker, type PrependScrollMarkerElement, type PrependScrollViewport } from "./chatScrollAnchoring";

describe("chat scroll anchoring", () => {
  it("selects the nearest marker at or above the viewport top", () => {
    expect(selectPrependMarker([
      { id: "below", offset: 20 },
      { id: "above-far", offset: -50 },
      { id: "above-near", offset: -2 },
    ])).toEqual({ id: "above-near", offset: -2 });
  });

  it("falls back to the nearest marker below the viewport top", () => {
    expect(selectPrependMarker([
      { id: "below-far", offset: 80 },
      { id: "below-near", offset: 12 },
    ])).toEqual({ id: "below-near", offset: 12 });
  });

  it("returns undefined when there are no markers", () => {
    expect(selectPrependMarker([])).toBeUndefined();
  });

  it("computes the scroll delta needed to keep a marker at the same offset", () => {
    expect(scrollDeltaForMarker(150, 40)).toBe(110);
  });

  it("computes fallback scrollTop from bottom distance", () => {
    expect(scrollTopForBottomDistance(1000, 250)).toBe(750);
    expect(scrollTopForBottomDistance(100, 250)).toBe(0);
  });
});

describe("restorePrependScrollAnchor", () => {
  // Programmatic scrollTop writes cancel in-flight touch/momentum scrolling,
  // so the restore must skip writes when the anchor has not drifted.
  function fakeScroller(scrollTop: number, scrollHeight: number): PrependScrollViewport {
    return {
      scrollTop,
      scrollHeight,
      getBoundingClientRect: () => ({ top: 0 }),
    };
  }

  function fakeMarker(top: number): PrependScrollMarkerElement {
    return { getBoundingClientRect: () => ({ top }) };
  }

  it("does not write scrollTop when the marker is still at its captured offset", () => {
    const scroller = fakeScroller(500, 2000);
    restorePrependScrollAnchor(scroller, { distanceFromBottom: 1500, markerId: "m:1", markerOffset: 40 }, fakeMarker(40));
    expect(scroller.scrollTop).toBe(500);
  });

  it("writes scrollTop only by the marker drift", () => {
    const scroller = fakeScroller(500, 2000);
    restorePrependScrollAnchor(scroller, { distanceFromBottom: 1500, markerId: "m:1", markerOffset: 40 }, fakeMarker(52));
    expect(scroller.scrollTop).toBe(512);
  });

  it("does not write scrollTop in the fallback path when the bottom distance is unchanged", () => {
    const scroller = fakeScroller(750, 1000);
    restorePrependScrollAnchor(scroller, { distanceFromBottom: 250 }, undefined);
    expect(scroller.scrollTop).toBe(750);
  });

  it("writes scrollTop in the fallback path when the bottom distance drifted", () => {
    const scroller = fakeScroller(750, 1400);
    restorePrependScrollAnchor(scroller, { distanceFromBottom: 250 }, undefined);
    expect(scroller.scrollTop).toBe(1150);
  });
});
