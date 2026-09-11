import { describe, expect, it } from "vitest";
import { formatFileSize, formatTokensPerSecond } from "./format";

describe("formatTokensPerSecond", () => {
  it("keeps fractional precision for lower response rates", () => {
    expect(formatTokensPerSecond(3.14)).toBe("3.1 tok/s");
    expect(formatTokensPerSecond(12.6)).toBe("13 tok/s");
  });
});

describe("formatFileSize", () => {
  it("keeps small sizes in whole bytes", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1023)).toBe("1023 B");
  });

  it("scales to binary units with one decimal below ten and whole numbers above", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1024 * 12)).toBe("12 KB");
    expect(formatFileSize(1024 * 1024 * 3.5)).toBe("3.5 MB");
    expect(formatFileSize(1024 * 1024 * 1024 * 2)).toBe("2.0 GB");
  });

  it("falls back to zero for unusable sizes", () => {
    expect(formatFileSize(-1)).toBe("0 B");
    expect(formatFileSize(Number.NaN)).toBe("0 B");
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});
