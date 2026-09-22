import type { ProxyOptions } from "vite";
import { isViteHostHeaderAllowed } from "./safeTunnelManagedHosts.js";

/** Blocks untrusted `/api` WebSocket upgrades before Vite proxies them. */
export function createViteProxyHostBypass(
  allowedHosts: readonly string[] | true,
): NonNullable<ProxyOptions["bypass"]> {
  return (request) => (
    isViteHostHeaderAllowed(request.headers.host, allowedHosts)
      ? undefined
      : false
  );
}
