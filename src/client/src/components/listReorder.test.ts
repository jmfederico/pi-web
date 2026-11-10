import { describe, expect, it } from "vitest";
import { autoscrollStep, dropTarget, insertionSlot } from "./listReorder";

const rows = [
  { top: 0, bottom: 50 },
  { top: 50, bottom: 100 },
  { top: 100, bottom: 150 },
];

describe("insertionSlot", () => {
  it.each([
    [0, 0],
    [24, 0],
    [26, 1],
    [74, 1],
    [76, 2],
    [124, 2],
    [126, 3],
    [400, 3],
  ])("places y=%i in slot %i", (y, slot) => {
    expect(insertionSlot(rows, y)).toBe(slot);
  });

  it("returns 0 for an empty list", () => {
    expect(insertionSlot([], 40)).toBe(0);
  });
});

describe("dropTarget", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("treats both slots around the dragged row as no move", () => {
    expect(dropTarget(items, 1, 1)).toBeUndefined();
    expect(dropTarget(items, 1, 2)).toBeUndefined();
  });

  it("drops before the first row when the pointer is above it", () => {
    expect(dropTarget(items, 2, 0)).toEqual({ neighborId: "a", position: "before" });
  });

  it("drops after the last row when the pointer is below it", () => {
    expect(dropTarget(items, 0, 3)).toEqual({ neighborId: "c", position: "after" });
  });

  it("drops against the previous row for interior slots", () => {
    expect(dropTarget(items, 2, 1)).toEqual({ neighborId: "a", position: "after" });
    expect(dropTarget(items, 0, 2)).toEqual({ neighborId: "b", position: "after" });
  });

  it("ignores indices outside the list", () => {
    expect(dropTarget(items, -1, 1)).toBeUndefined();
    expect(dropTarget(items, 3, 1)).toBeUndefined();
    expect(dropTarget([], 0, 1)).toBeUndefined();
  });
});

describe("autoscrollStep", () => {
  const bounds = { top: 100, bottom: 300 };

  it("stays at rest inside the dead zone", () => {
    expect(autoscrollStep(200, bounds, 36, 14)).toBe(0);
    expect(autoscrollStep(137, bounds, 36, 14)).toBe(0);
    expect(autoscrollStep(263, bounds, 36, 14)).toBe(0);
  });

  it("scrolls up near the top edge and down near the bottom edge", () => {
    expect(autoscrollStep(100, bounds, 36, 14)).toBeLessThan(0);
    expect(autoscrollStep(300, bounds, 36, 14)).toBeGreaterThan(0);
  });

  it("scales with proximity and caps at the maximum", () => {
    expect(autoscrollStep(128, bounds, 36, 14)).toBe(-4);
    expect(autoscrollStep(272, bounds, 36, 14)).toBe(4);
    expect(autoscrollStep(-500, bounds, 36, 14)).toBe(-14);
    expect(autoscrollStep(9999, bounds, 36, 14)).toBe(14);
  });
});
