import { describe, expect, it } from "vitest";
import { assertValidSchedule, nextCronFireAt } from "./scheduledTaskCron.js";

describe("nextCronFireAt", () => {
  it("computes the next occurrence from a given moment", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const next = nextCronFireAt("0 6 * * *", "UTC", from);
    expect(next?.toISOString()).toBe("2026-01-01T06:00:00.000Z");
  });

  it("respects the given timezone", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const next = nextCronFireAt("0 6 * * *", "Asia/Jakarta", from);
    // 06:00 WIB (UTC+7) on 2026-01-01 is 2025-12-31T23:00:00Z, already past `from`,
    // so the next occurrence is the following day.
    expect(next?.toISOString()).toBe("2026-01-01T23:00:00.000Z");
  });

  it("returns undefined for an unparsable expression", () => {
    expect(nextCronFireAt("not a cron expression", "UTC")).toBeUndefined();
  });
});

describe("assertValidSchedule", () => {
  it("does not throw for a valid cron expression", () => {
    expect(() => { assertValidSchedule("0 6 * * *", "UTC"); }).not.toThrow();
  });

  it("throws for an invalid cron expression", () => {
    expect(() => { assertValidSchedule("nope", "UTC"); }).toThrow(/Invalid cron expression/);
  });

  it("throws for an invalid timezone", () => {
    expect(() => { assertValidSchedule("0 6 * * *", "Not/AZone"); }).toThrow(/Invalid cron expression/);
  });
});
