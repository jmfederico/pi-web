import { randomUUID } from "node:crypto";
import { hostname as operatingSystemHostname } from "node:os";
import type { AddressInfo } from "node:net";

export const defaultSafeTunnelControlApiBaseUrl = "https://api.tunnels.pi-web.dev";

const maximumMachineNameLength = 80;
const maximumMachineSlugLength = 63;
const machineSlugSuffixLength = 8;

export interface SafeTunnelEnableDefaults {
  readonly controlApiBaseUrl: string;
  readonly localPiWebUrl: string;
  readonly machineName: string;
  readonly machineSlug: string;
}

export interface SafeTunnelEnableDefaultOverrides {
  readonly localPiWebUrl?: string;
}

export type SafeTunnelEnableDefaultsProvider = (
  overrides?: SafeTunnelEnableDefaultOverrides,
) => SafeTunnelEnableDefaults;

export type SafeTunnelServerAddress = AddressInfo | string | null;

export interface NodeSafeTunnelEnableDefaultsOptions {
  readonly serverAddress: () => SafeTunnelServerAddress;
  readonly hostname?: () => string;
  readonly uniqueId?: () => string;
}

/**
 * Resolves ordinary enablement inputs at the server boundary. The browser never
 * chooses a listener target or machine identity unless an advanced override is
 * explicitly supplied.
 */
export function createNodeSafeTunnelEnableDefaultsProvider(
  options: NodeSafeTunnelEnableDefaultsOptions,
): SafeTunnelEnableDefaultsProvider {
  const hostname = options.hostname ?? operatingSystemHostname;
  const uniqueId = options.uniqueId ?? randomUUID;
  return (overrides = {}) => {
    const machineName = normalizeMachineName(hostname());
    return {
      controlApiBaseUrl: defaultSafeTunnelControlApiBaseUrl,
      localPiWebUrl: overrides.localPiWebUrl
        ?? safeTunnelLocalPiWebUrlFromServerAddress(options.serverAddress()),
      machineName,
      machineSlug: collisionResistantMachineSlug(machineName, uniqueId()),
    };
  };
}

export function safeTunnelLocalPiWebUrlFromServerAddress(
  address: SafeTunnelServerAddress,
): string {
  if (address === null) {
    throw new Error("PI WEB must be listening before Safe Tunnel can infer its local target.");
  }
  if (typeof address === "string") {
    throw new Error("Safe Tunnel requires an advanced local target when PI WEB uses a socket listener.");
  }

  const host = localTargetHost(address.address, address.family);
  return `http://${host}:${address.port.toString()}`;
}

export function collisionResistantMachineSlug(
  machineName: string,
  uniqueId: string,
): string {
  const suffix = uniqueId.toLowerCase().replace(/[^a-z0-9]/gu, "").slice(0, machineSlugSuffixLength);
  if (suffix.length !== machineSlugSuffixLength) {
    throw new Error("Unable to infer a collision-resistant Safe Tunnel machine identity.");
  }

  const base = machineSlugBase(machineName);
  const maximumBaseLength = maximumMachineSlugLength - suffix.length - 1;
  const boundedBase = base.slice(0, maximumBaseLength).replace(/-+$/gu, "") || "pi-web";
  return `${boundedBase}-${suffix}`;
}

function normalizeMachineName(value: string): string {
  const normalized = value.trim() || "PI WEB";
  return normalized.slice(0, maximumMachineNameLength);
}

function machineSlugBase(value: string): string {
  const normalized = value.trim().toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || "pi-web";
}

function localTargetHost(address: string, family: string): string {
  if (address === "0.0.0.0") return "127.0.0.1";
  if (address === "::") return "[::1]";
  if (address.includes("%")) {
    throw new Error("Safe Tunnel requires an advanced local target for a scoped IPv6 listener.");
  }
  if (family === "IPv6" || address.includes(":")) return `[${address}]`;
  return address;
}
