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
