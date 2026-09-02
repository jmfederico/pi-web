import { describe, expect, it } from "vitest";
import { formatAnchorLabel, formatLineRange, normalizedRange } from "./reviewCoordinates";
import type { ReviewAnchor } from "./reviewTypes";

function anchor(filePath: string, side: "new" | "old", start: number, end: number): ReviewAnchor {
  return { filePath, range: { side, start, end } };
}

describe("reviewCoordinates", () => {
  it("normalizes reversed ranges", () => {
    expect(normalizedRange({ side: "new", start: 15, end: 12 })).toEqual({ start: 12, end: 15 });
  });

  it("formats a single new-side line", () => {
    expect(formatLineRange({ side: "new", start: 12, end: 12 })).toBe("12");
  });

  it("formats a new-side range", () => {
    expect(formatLineRange({ side: "new", start: 12, end: 15 })).toBe("12-15");
  });

  it("marks old-side (deleted) ranges", () => {
    expect(formatLineRange({ side: "old", start: 8, end: 9 })).toBe("8-9 (deleted)");
    expect(formatLineRange({ side: "old", start: 8, end: 8 })).toBe("8 (deleted)");
  });

  it("builds a full anchor label", () => {
    expect(formatAnchorLabel(anchor("src/app.ts", "new", 12, 15))).toBe("src/app.ts:12-15");
    expect(formatAnchorLabel(anchor("src/app.ts", "old", 8, 9))).toBe("src/app.ts:8-9 (deleted)");
  });
});
