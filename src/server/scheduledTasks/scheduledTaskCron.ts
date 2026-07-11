import { CronExpressionParser } from "cron-parser";

/**
 * Computes the next fire time for a cron expression in a given timezone.
 * Returns `undefined` for an expression that cannot be parsed (callers treat
 * that as "unschedulable" rather than throwing during read paths like
 * listing tasks, where a bad expression shouldn't break the whole response).
 */
export function nextCronFireAt(cron: string, timezone: string, from: Date = new Date()): Date | undefined {
  try {
    return CronExpressionParser.parse(cron, { currentDate: from, tz: timezone }).next().toDate();
  } catch {
    return undefined;
  }
}

/** Throws a descriptive error when the cron expression or timezone is invalid — used on create/update, where failing loudly is correct. */
export function assertValidSchedule(cron: string, timezone: string): void {
  try {
    // cron-parser only validates the tz once a concrete date is computed —
    // parse() alone accepts a bogus IANA zone name silently.
    CronExpressionParser.parse(cron, { tz: timezone }).next();
  } catch (error) {
    throw new Error(`Invalid cron expression "${cron}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
