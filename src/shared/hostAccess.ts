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

/** Match an actual hostname, not a URL or authority; callers own input validation. */
export function hostnameAllowedByPolicy(hostname: string, policy: PiWebHostAccess | undefined): boolean {
  if (policy === undefined || policy.mode === "any") return true;
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host.endsWith(".localhost") || isIpLiteral(host)) return true;
  return policy.hosts.some((value) => {
    const entry = normalizeHostname(value);
    return entry === host || (entry.startsWith(".") && (host === entry.slice(1) || host.endsWith(entry)));
  });
}

export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/u, "");
}

function isIpLiteral(hostname: string): boolean {
  if (!hostname.includes(":")) {
    const octets = hostname.split(".");
    // URL accepts shortened, octal and numeric IPv4 aliases; only canonical
    // decimal octets have the same meaning as node:net's isIP here.
    return octets.length === 4 && octets.every((octet) => {
      const value = Number(octet);
      return Number.isInteger(value) && value >= 0 && value <= 255 && String(value) === octet;
    });
  }
  const address = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  // Constrain the URL input to an IPv6 literal, never repaired URL syntax.
  if (/[^0-9a-f:.]/u.test(address)) return false;
  try {
    return new URL(`http://[${address}]`).hostname.startsWith("[");
  } catch {
    return false;
  }
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
  return policy.mode === "any" ? true : policy.hosts.map(normalizeHostname);
}
