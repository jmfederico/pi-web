import type { PiWebConfigValues, PiWebHostValidationMode } from "./apiTypes.js";

/** Missing overrides inherit an undecided, non-enforcing policy on every installation. */
export const DEFAULT_HOST_VALIDATION: PiWebHostValidationMode = "pending";

export function requireHostValidation(value: unknown, source = "PI WEB config hostValidation"): PiWebHostValidationMode {
  if (value === "pending" || value === "enabled" || value === "disabled") return value;
  throw new Error(`${source} must be pending, enabled, or disabled`);
}

export function validateHostValidationPolicy(config: Pick<PiWebConfigValues, "hostValidation" | "allowedHosts">): void {
  if (config.hostValidation === "enabled" && config.allowedHosts === true) {
    throw new Error("PI WEB config hostValidation enabled requires an allowedHosts list, not true; choose hostValidation disabled to allow every host");
  }
}
