import { Cron } from "croner";
import type { AutomationTrigger } from "../../shared/apiTypes.js";

export const MIN_AUTOMATION_INTERVAL_MS = 60_000;
export const DEFAULT_AUTOMATION_TIMEOUT_MS = 60 * 60_000;
export const MIN_AUTOMATION_TIMEOUT_MS = 60_000;
export const MAX_AUTOMATION_TIMEOUT_MS = 24 * 60 * 60_000;
export const DEFAULT_AUTOMATION_ABORT_GRACE_MS = 15_000;

export function validateAutomationTrigger(trigger: AutomationTrigger, now = new Date()): AutomationTrigger {
  switch (trigger.type) {
    case "manual":
      return trigger;
    case "once": {
      const timestamp = Date.parse(trigger.at);
      if (!Number.isFinite(timestamp)) throw new Error("One-shot time must be a valid ISO timestamp");
      if (timestamp <= now.getTime()) throw new Error("One-shot time must be in the future");
      return { type: "once", at: new Date(timestamp).toISOString() };
    }
    case "interval":
      if (!Number.isSafeInteger(trigger.intervalMs) || trigger.intervalMs < MIN_AUTOMATION_INTERVAL_MS) {
        throw new Error(`Interval must be at least ${String(MIN_AUTOMATION_INTERVAL_MS / 1000)} seconds`);
      }
      return trigger;
    case "cron": {
      const expression = trigger.expression.trim();
      if (expression.split(/\s+/u).length !== 6) throw new Error("Cron expression must contain six fields, including seconds");
      requireTimeZone(trigger.timeZone);
      const cron = cronFor(expression, trigger.timeZone);
      const first = cron.nextRun(now);
      const second = first === null ? null : cron.nextRun(first);
      if (first === null) throw new Error("Cron expression has no future occurrence");
      if (second !== null && second.getTime() - first.getTime() < MIN_AUTOMATION_INTERVAL_MS) {
        throw new Error("Cron schedules must run no more than once per minute");
      }
      return { type: "cron", expression, timeZone: trigger.timeZone };
    }
  }
}

export function initialAutomationNextRunAt(trigger: AutomationTrigger, now = new Date()): string | undefined {
  switch (trigger.type) {
    case "manual":
      return undefined;
    case "once":
      return new Date(trigger.at).toISOString();
    case "interval":
      return new Date(now.getTime() + trigger.intervalMs).toISOString();
    case "cron": {
      const next = cronFor(trigger.expression, trigger.timeZone).nextRun(now);
      return next === null ? undefined : next.toISOString();
    }
  }
}

/** Advance from a persisted occurrence and coalesce downtime into at most one subsequent occurrence. */
export function advanceAutomationNextRunAt(trigger: AutomationTrigger, scheduledFor: string, now = new Date()): string | undefined {
  switch (trigger.type) {
    case "manual":
    case "once":
      return undefined;
    case "interval": {
      const scheduledMs = Date.parse(scheduledFor);
      const nextMs = scheduledMs + Math.max(1, Math.floor((now.getTime() - scheduledMs) / trigger.intervalMs) + 1) * trigger.intervalMs;
      return new Date(nextMs).toISOString();
    }
    case "cron": {
      const next = cronFor(trigger.expression, trigger.timeZone).nextRun(now);
      return next === null ? undefined : next.toISOString();
    }
  }
}

export function validateAutomationTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_AUTOMATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_AUTOMATION_TIMEOUT_MS || timeoutMs > MAX_AUTOMATION_TIMEOUT_MS) {
    throw new Error(`Timeout must be between ${String(MIN_AUTOMATION_TIMEOUT_MS / 60_000)} minute and ${String(MAX_AUTOMATION_TIMEOUT_MS / 3_600_000)} hours`);
  }
  return timeoutMs;
}

function cronFor(expression: string, timeZone: string): Cron {
  try {
    return new Cron(expression, { paused: true, timezone: timeZone });
  } catch (error) {
    throw new Error(`Invalid cron schedule: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function requireTimeZone(value: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
  } catch {
    throw new Error(`Invalid IANA timezone: ${value}`);
  }
}
