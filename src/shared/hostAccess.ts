import type { PiWebConfigValues, PiWebHostAccess } from "./apiTypes.js";

/** Validate an atomic policy and detach it from the caller's mutable input. */
export function requireHostAccess(value: unknown, source = "PI WEB config hostAccess"): PiWebHostAccess {
  if (!isRecord(value)) {
    throw new Error(`${source} must be a host access policy object`);
  }
  const record = value;
  if (record["mode"] === "any" && Object.keys(record).every((key) => key === "mode")) return { mode: "any" };
  if (record["mode"] === "restricted" && Object.keys(record).every((key) => key === "mode" || key === "hosts")) {
    const hosts = record["hosts"];
    if (Array.isArray(hosts) && hosts.every((host: unknown): host is string => typeof host === "string" && host.trim() !== "")) {
      return { mode: "restricted", hosts: [...hosts] };
    }
  }
  throw new Error(`${source} must be { mode: "any" } or { mode: "restricted", hosts: [non-empty strings] }, with no extra keys`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Vite retains its legacy defaults until an explicit shared policy is supplied. */
export function developmentAllowedHosts(config: Pick<PiWebConfigValues, "hostAccess" | "allowedHosts">): string[] | true | undefined {
  if (config.hostAccess === undefined) return config.allowedHosts;
  const policy = requireHostAccess(config.hostAccess);
  // Match the API's hostname normalization, without changing legacy Vite
  // fallback behavior or rewriting the user's saved policy.
  return policy.mode === "any" ? true : policy.hosts.map((host) => host.toLowerCase().replace(/\.$/u, ""));
}
