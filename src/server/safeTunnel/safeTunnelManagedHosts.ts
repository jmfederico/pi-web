import { isIP } from "node:net";
import type {
  PiWebManagedAllowedHost,
} from "../../shared/apiTypes.js";
import {
  normalizeSafeTunnelPublicUrl,
  readSafeTunnelRegisteredPublicOrigin,
} from "./safeTunnelState.js";

export type ViteAllowedHosts = readonly string[] | true | undefined;

/**
 * Projects the private Safe Tunnel registration into the one exact hostname
 * that the local browser entrypoint may trust. Request headers never
 * participate in this decision.
 */
export function safeTunnelManagedAllowedHosts(
  publicUrl: string | undefined,
): readonly PiWebManagedAllowedHost[] {
  if (publicUrl === undefined) return [];

  try {
    const normalized = normalizeSafeTunnelPublicUrl(publicUrl);
    const hostname = unbracketHostname(new URL(normalized).hostname);
    // Vite interprets a leading dot as a subdomain wildcard. A managed host is
    // always exact, even if a permissive URL parser accepted such a hostname.
    return hostname === "" || hostname.startsWith(".")
      ? []
      : [{ source: "safe-tunnel", hostname }];
  } catch {
    return [];
  }
}

/** Reads the private state through a redacted, fail-closed projection for Vite. */
export async function loadSafeTunnelManagedAllowedHosts(
  statePath: string,
): Promise<readonly PiWebManagedAllowedHost[]> {
  try {
    return safeTunnelManagedAllowedHosts(
      await readSafeTunnelRegisteredPublicOrigin(statePath),
    );
  } catch {
    // A missing or invalid registration cannot establish browser host trust.
    // Do not surface state parser details because the same file holds secrets.
    return [];
  }
}

export function mergeViteAllowedHosts(
  configured: ViteAllowedHosts,
  managed: readonly PiWebManagedAllowedHost[],
): string[] | true {
  if (configured === true) return true;
  return [...new Set([
    ...(configured ?? []),
    ...managed.map(({ hostname }) => hostname),
  ])];
}

/**
 * Mirrors Vite's allowed-host matching for the `/api` WebSocket proxy, whose
 * upgrade listener does not pass through Vite's ordinary HTTP host middleware.
 */
export function isViteHostHeaderAllowed(
  hostHeader: string | undefined,
  allowedHosts: readonly string[] | true,
): boolean {
  if (allowedHosts === true) return true;
  if (hostHeader === undefined) return false;

  const extracted = extractViteHostname(hostHeader);
  if (extracted === undefined) return false;
  if (extracted.type === "ip") return true;

  const hostname = extracted.hostname;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  return allowedHosts.some((allowedHost) => (
    allowedHost === hostname
    || (allowedHost.startsWith(".")
      && (allowedHost.slice(1) === hostname || hostname.endsWith(allowedHost)))
  ));
}

export function managedAllowedHostnames(
  hosts: readonly PiWebManagedAllowedHost[],
): readonly string[] {
  return hosts.map(({ hostname }) => hostname).sort();
}

function extractViteHostname(
  hostHeader: string,
): { readonly type: "ip" } | { readonly type: "hostname"; readonly hostname: string } | undefined {
  const trimmed = hostHeader.trim();
  if (trimmed === "") return undefined;
  if (trimmed.startsWith("[")) {
    const bracket = trimmed.indexOf("]");
    if (bracket < 0 || isIP(trimmed.slice(1, bracket)) !== 6) return undefined;
    return { type: "ip" };
  }

  const colon = trimmed.indexOf(":");
  const hostname = colon < 0 ? trimmed : trimmed.slice(0, colon);
  if (isIP(hostname) === 4) return { type: "ip" };
  return hostname === "" ? undefined : { type: "hostname", hostname };
}

function unbracketHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}
