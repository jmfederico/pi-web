import type { PiWebConfigValues } from "./apiTypes.js";

export function requireDefaultStreamingBehavior(value: unknown, source: string): NonNullable<PiWebConfigValues["defaultStreamingBehavior"]> {
  if (value !== "steer" && value !== "followUp") {
    throw new Error(`PI WEB config defaultStreamingBehavior must be steer or followUp: ${source}`);
  }
  return value;
}
