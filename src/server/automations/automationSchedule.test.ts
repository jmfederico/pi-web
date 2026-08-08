import { describe, expect, it } from "vitest";
import {
  advanceAutomationNextRunAt,
  initialAutomationNextRunAt,
  validateAutomationTimeoutMs,
  validateAutomationTrigger,
} from "./automationSchedule.js";

const now = new Date("2026-07-24T12:00:00.000Z");

describe("automation schedules", () => {
  it("supports manual, one-shot, interval, and timezone-aware cron triggers", () => {
    expect(initialAutomationNextRunAt(validateAutomationTrigger({ type: "manual" }, now), now)).toBeUndefined();
    expect(initialAutomationNextRunAt(validateAutomationTrigger({ type: "once", at: "2026-07-24T13:00:00Z" }, now), now)).toBe("2026-07-24T13:00:00.000Z");
    expect(initialAutomationNextRunAt(validateAutomationTrigger({ type: "interval", intervalMs: 300_000 }, now), now)).toBe("2026-07-24T12:05:00.000Z");
    expect(initialAutomationNextRunAt(validateAutomationTrigger({ type: "cron", expression: "0 0 * * * *", timeZone: "UTC" }, now), now)).toBe("2026-07-24T13:00:00.000Z");
  });

  it("rejects runaway schedules and invalid timezones", () => {
    expect(() => validateAutomationTrigger({ type: "interval", intervalMs: 59_999 }, now)).toThrow("at least 60 seconds");
    expect(() => validateAutomationTrigger({ type: "cron", expression: "* * * * * *", timeZone: "UTC" }, now)).toThrow("no more than once per minute");
    expect(() => validateAutomationTrigger({ type: "cron", expression: "0 0 * * * *", timeZone: "Nowhere/Invalid" }, now)).toThrow("Invalid IANA timezone");
  });

  it("coalesces missed interval occurrences rather than replaying a backlog", () => {
    expect(advanceAutomationNextRunAt(
      { type: "interval", intervalMs: 300_000 },
      "2026-07-24T12:00:00.000Z",
      new Date("2026-07-24T12:16:00.000Z"),
    )).toBe("2026-07-24T12:20:00.000Z");
  });

  it("enforces the one-minute to 24-hour timeout boundary", () => {
    expect(validateAutomationTimeoutMs(undefined)).toBe(3_600_000);
    expect(validateAutomationTimeoutMs(60_000)).toBe(60_000);
    expect(() => validateAutomationTimeoutMs(59_999)).toThrow("Timeout must be between");
    expect(() => validateAutomationTimeoutMs(86_400_001)).toThrow("Timeout must be between");
  });
});
