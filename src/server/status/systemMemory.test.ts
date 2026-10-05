import { describe, expect, it } from "vitest";
import { memoryFromProc } from "./systemMemory.js";

describe("system RAM sampling", () => {
  it("uses reclaimable MemAvailable rather than treating disk cache as used RAM", () => {
    expect(memoryFromProc("MemTotal: 1000 kB\nMemFree: 10 kB\nMemAvailable: 700 kB\nCached: 690 kB\n")).toEqual({ totalBytes: 1_024_000, availableBytes: 716_800, availability: "available" });
  });
  it("rejects missing, nonfinite and impossible samples rather than displaying healthy zero", () => {
    for (const input of ["", "MemTotal: 0 kB\nMemAvailable: 0 kB", "MemTotal: 10 kB\nMemAvailable: 20 kB", "MemTotal: NaN kB\nMemAvailable: 1 kB"]) expect(memoryFromProc(input)).toBeUndefined();
  });
});
