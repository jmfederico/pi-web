import type { Machine } from "./api";
import { resolveAppUrl } from "./appUrl";

/**
 * The machine's brand icon: the local machine shares this app's deployment
 * identity (the server serves dev-colored assets in place), while remote
 * machines are fetched from their own public URL so a remote dev deployment
 * shows its own purple icon. Remote base URLs carry a canonical trailing
 * slash, defended here for hand-edited registries.
 */
export function machineIconUrl(machine: Pick<Machine, "kind" | "baseUrl">): string {
  if (machine.kind === "local" || machine.baseUrl === undefined) return resolveAppUrl("favicon.svg");
  return new URL("favicon.svg", machine.baseUrl.endsWith("/") ? machine.baseUrl : `${machine.baseUrl}/`).toString();
}

/** `host` plus any non-root deployment path, e.g. `pi.example.com` or `example.com/pi-web`. */
export function gatewayDisplayUrl(appBaseUrl: string): string {
  const url = new URL(appBaseUrl);
  return `${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** The serving gateway's display URL, derived from this app's own base URL. */
export function browserGatewayDisplayUrl(): string {
  return gatewayDisplayUrl(resolveAppUrl(""));
}
