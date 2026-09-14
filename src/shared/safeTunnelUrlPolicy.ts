/**
 * Plaintext Control API and public-ingress endpoints are development-only
 * exceptions. Restrict them to URL-parser-normalized literal loopback addresses
 * so DNS or hosts-file changes cannot redirect credentials or public traffic.
 */
export function isSafeTunnelLoopbackHostname(hostname: string): boolean {
  if (hostname === "[::1]") return true;
  const ipv4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  return ipv4?.slice(1).every((octet) => Number(octet) <= 255) ?? false;
}

/**
 * Browser request-provenance checks (Host/Origin trust) may additionally treat
 * RFC 6761 localhost names as loopback development endpoints: browsers resolve
 * `localhost` and its subdomains to loopback themselves and mark them
 * trustworthy, and the local tunnel development edge serves plaintext HTTP on
 * such names. This widening applies only to request provenance; never use it
 * to validate Control API endpoints, registered public URLs, or other
 * credential-bearing/provider-owned values, where plaintext stays restricted
 * to literal loopback addresses. Accepts `normalizeUrlHostname`-style output
 * (unbracketed IPv6, lowercased, no root dot).
 */
export function isSafeTunnelLoopbackDevelopmentHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  return isSafeTunnelLoopbackHostname(hostname === "::1" ? "[::1]" : hostname);
}

export function hasExplicitSafeTunnelHttpPort(value: string): boolean {
  return /^http:\/\/(?:\[[^\]]+\]|[^:/?#]+):\d+(?:[/?#]|$)/iu.test(value);
}

export function isSafeTunnelControlApiTransportAllowed(url: URL): boolean {
  return isSafeTunnelProtectedTransportAllowed(url);
}

export function isSafeTunnelPublicIngressTransportAllowed(url: URL): boolean {
  return isSafeTunnelProtectedTransportAllowed(url);
}

function isSafeTunnelProtectedTransportAllowed(url: URL): boolean {
  return url.protocol === "https:"
    || (url.protocol === "http:" && isSafeTunnelLoopbackHostname(url.hostname));
}
