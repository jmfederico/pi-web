import { describe, expect, it } from "vitest";
import { ResponseTokenRateTracker, responseTokensPerSecond } from "./responseTokenRate.js";

describe("responseTokensPerSecond", () => {
  it("calculates generated output token throughput", () => {
    expect(responseTokensPerSecond(
      { outputTokens: 100, at: new Date("2026-01-01T00:00:00.000Z") },
      { outputTokens: 160, at: new Date("2026-01-01T00:02:00.000Z") },
    )).toBe(0.5);
  });

  it("omits rates without positive output and elapsed time", () => {
    const start = { outputTokens: 100, at: new Date("2026-01-01T00:00:00.000Z") };
    expect(responseTokensPerSecond(start, { outputTokens: 100, at: new Date("2026-01-01T00:01:00.000Z") })).toBeUndefined();
    expect(responseTokensPerSecond(start, { outputTokens: 110, at: start.at })).toBeUndefined();
  });
});

describe("ResponseTokenRateTracker", () => {
  it("retains the most recent valid rate for a live session", () => {
    const session = {};
    const tracker = new ResponseTokenRateTracker<object>();
    tracker.begin(session, 20);
    tracker.startTiming(session, new Date("2026-01-01T00:00:00.000Z"));
    tracker.sample(session, { outputTokens: 50, at: new Date("2026-01-01T00:03:00.000Z") });

    expect(tracker.rate(session)).toBeCloseTo(1 / 6);
  });
});
