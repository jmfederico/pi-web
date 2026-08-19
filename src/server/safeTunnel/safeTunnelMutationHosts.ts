import { isIP } from "node:net";
import { isSafeTunnelPublicIngressTransportAllowed } from "../../shared/safeTunnelUrlPolicy.js";

export interface SafeTunnelMutationHostConfig {
  /** The operator-selected web listener host. */
  readonly listenerHost?: string;
  /** Exact configured hostnames; `true` deliberately does not trust arbitrary DNS names. */
  readonly allowedHosts?: readonly string[] | true;
}

export interface SafeTunnelMutationHostHeaders {
  readonly host?: string | readonly string[] | undefined;
  readonly origin?: string | readonly string[] | undefined;
}

export interface SafeTunnelMutationHostBoundary {
  allowsRead(
    headers: SafeTunnelMutationHostHeaders,
    registeredPublicOrigin: () => Promise<string | undefined>,
  ): Promise<boolean>;
  allowsMutation(
    headers: SafeTunnelMutationHostHeaders,
    registeredPublicOrigin: () => Promise<string | undefined>,
  ): Promise<boolean>;
}

interface NormalizedOrigin {
  readonly hostname: string;
  readonly origin: string;
}

/**
 * Builds the feature-local Host/Origin boundary for Safe Tunnel API requests.
 * DNS names become trusted only through startup configuration or a persisted
 * registration; equality between request-controlled Host and Origin is never
 * itself evidence of trust.
 */
export function createSafeTunnelMutationHostBoundary(
  config: SafeTunnelMutationHostConfig = {},
): SafeTunnelMutationHostBoundary {
  const allowedHosts = config.allowedHosts === undefined
    || config.allowedHosts === true
    ? []
    : config.allowedHosts;
  const configuredHostnames = new Set(
    [config.listenerHost, ...allowedHosts].flatMap((value) => {
      const hostname = normalizeConfiguredHostname(value);
      return hostname === undefined ? [] : [hostname];
    }),
  );
  const isConfiguredOrIntrinsic = (hostname: string): boolean => (
    isIntrinsicallyTrustedHostname(hostname) || configuredHostnames.has(hostname)
  );

  return {
    allowsRead: async (headers, registeredPublicOrigin) => {
      const host = requestAuthorityHostname(headers.host);
      if (host === undefined) return false;
      if (isConfiguredOrIntrinsic(host)) return true;

      const registered = normalizeRegisteredPublicOrigin(
        await registeredPublicOrigin(),
      );
      return registered?.hostname === host;
    },
    allowsMutation: async (headers, registeredPublicOrigin) => {
      const host = requestAuthorityHostname(headers.host);
      if (host === undefined) return false;

      const origin = headers.origin === undefined
        ? undefined
        : requestOrigin(headers.origin);
      if (origin === undefined) return false;

      const hostIsConfigured = isConfiguredOrIntrinsic(host);
      const originIsConfigured = isConfiguredOrIntrinsic(origin.hostname);
      if (hostIsConfigured && originIsConfigured) return true;

      const registered = normalizeRegisteredPublicOrigin(
        await registeredPublicOrigin(),
      );
      if (registered === undefined) return false;

      const hostIsTrusted = hostIsConfigured || host === registered.hostname;
      return hostIsTrusted && origin.origin === registered.origin;
    },
  };
}

function requestAuthorityHostname(
  value: string | readonly string[] | undefined,
): string | undefined {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    return undefined;
  }
  return authorityHostname(value, true);
}

function requestOrigin(
  value: string | readonly string[],
): NormalizedOrigin | undefined {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    return undefined;
  }

  try {
    const origin = new URL(value);
    const hostname = normalizeUrlHostname(origin.hostname);
    if ((origin.protocol !== "http:" && origin.protocol !== "https:")
      || origin.username !== ""
      || origin.password !== ""
      || origin.pathname !== "/"
      || origin.search !== ""
      || origin.hash !== ""
      || hostname === undefined) {
      return undefined;
    }
    return { hostname, origin: origin.origin };
  } catch {
    return undefined;
  }
}

function normalizeRegisteredPublicOrigin(
  value: string | undefined,
): NormalizedOrigin | undefined {
  if (value === undefined || value === "" || value !== value.trim()) return undefined;

  try {
    const origin = new URL(value);
    const hostname = normalizeUrlHostname(origin.hostname);
    if (!isSafeTunnelPublicIngressTransportAllowed(origin)
      || origin.username !== ""
      || origin.password !== ""
      || origin.pathname !== "/"
      || origin.search !== ""
      || origin.hash !== ""
      || hostname === undefined) {
      return undefined;
    }
    return { hostname, origin: origin.origin };
  } catch {
    return undefined;
  }
}

function normalizeConfiguredHostname(value: string | undefined): string | undefined {
  if (value === undefined || value === "" || value !== value.trim()) return undefined;
  // Vite supports leading-dot subdomain patterns, but Safe Tunnel requests
  // require an exact operator-selected DNS name.
  if (value.startsWith(".")) return undefined;

  if (isIP(value) === 6) return authorityHostname(`[${value}]`, false);
  return authorityHostname(value, false);
}

function authorityHostname(value: string, allowPort: boolean): string | undefined {
  if (/[\\/?#@]/u.test(value)) return undefined;

  try {
    const authority = new URL(`http://${value}`);
    if (authority.username !== ""
      || authority.password !== ""
      || authority.pathname !== "/"
      || authority.search !== ""
      || authority.hash !== ""
      || (!allowPort && authority.port !== "")) {
      return undefined;
    }
    return normalizeUrlHostname(authority.hostname);
  } catch {
    return undefined;
  }
}

function normalizeUrlHostname(value: string): string | undefined {
  const unbracketed = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  const withoutRootDot = unbracketed.endsWith(".")
    ? unbracketed.slice(0, -1)
    : unbracketed;
  if (withoutRootDot === "" || withoutRootDot.endsWith(".")) return undefined;
  return withoutRootDot.toLowerCase();
}

function isIntrinsicallyTrustedHostname(hostname: string): boolean {
  // Literal IP origins cannot retain a DNS name while rebinding elsewhere.
  return hostname === "localhost" || isIP(hostname) !== 0;
}
