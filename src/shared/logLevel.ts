const logLevels = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
export type PiWebLogLevel = typeof logLevels[number];

export function requireLogLevel(value: unknown, source: string): PiWebLogLevel {
  const level = logLevels.find((candidate) => candidate === value);
  if (level === undefined) throw new Error(`PI WEB config logLevel must be one of ${logLevels.join(", ")}: ${source}`);
  return level;
}
