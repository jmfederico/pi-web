import type { AddressInfo } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";

/** Browser-ready addresses for the listener, not a guarantee of firewall or proxy access. */
export function startupUrlLines(
  bound: AddressInfo,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string[] {
  const line = (label: string, address: string) => {
    const host = address.includes(":") ? `[${address}]` : address;
    return `  ${label}: http://${host}:${String(bound.port)}`;
  };
  const wildcardV4 = bound.address === "0.0.0.0";
  const wildcardV6 = bound.address === "::";
  if (!wildcardV4 && !wildcardV6) {
    const local = bound.address.startsWith("127.") || bound.address === "::1";
    return [line(local ? "Local" : "Open", bound.address)];
  }

  const lines = [line("Local", wildcardV4 ? "127.0.0.1" : "::1")];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.internal || (wildcardV4 && address.family !== "IPv4")) continue;
      // Browsers do not support IPv6 zone identifiers required by scoped addresses.
      if (address.family === "IPv6" && (address.scopeid !== 0 || address.address.includes("%"))) continue;
      lines.push(line(name, address.address));
    }
  }
  return lines;
}
