import type { JsonObject, SessionUiMetadata } from "@jmfederico/pi-web/plugin-api";

/** Relay owns this schema; core treats it as opaque browser-public JSON. */
export const RELAY_METADATA_NAMESPACE = "@jmfederico/pi-relay";

export interface RelayIdentity extends JsonObject {
  version: 1;
  /** Normalized workspace-relative packet directory, also the exact panel selection. */
  packetPath: string;
  relayName: string;
  leg: string;
}

export function relayIdentityFromMetadata(metadata: SessionUiMetadata | undefined): RelayIdentity | undefined {
  const value = metadata?.[RELAY_METADATA_NAMESPACE];
  if (value?.["version"] !== 1) return undefined;
  const packetPath = value["packetPath"];
  const relayName = value["relayName"];
  const leg = value["leg"];
  if (typeof packetPath !== "string" || !isRelayPacketPath(packetPath)
    || typeof relayName !== "string" || relayName !== packetPath.split("/").at(-1)
    || typeof leg !== "string" || !isRelayLeg(leg)) return undefined;
  return { version: 1, packetPath, relayName, leg };
}

export function isRelayPacketPath(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- packet paths must not contain control characters.
  return value.length > 0 && value.length <= 4096 && !/[\\\u0000-\u001f\u007f]/u.test(value)
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && segment === segment.trim());
}

export function isRelayLeg(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/u.test(value);
}

export function requireRelayLeg(value: unknown): string {
  if (typeof value !== "string" || !isRelayLeg(value)) {
    throw new Error("Relay leg must be a string of 1–32 letters, digits, dots, underscores or hyphens, starting with a letter or digit");
  }
  return value;
}

/** Keep the leg first so host and sidebar truncation only shorten the Relay name. */
export function relaySessionName(identity: RelayIdentity): string {
  const prefix = `Leg ${identity.leg} – Relay `;
  const room = 60 - prefix.length;
  const name = identity.relayName.slice(0, room).replace(/[\s._-]+$/u, "") || identity.relayName.slice(0, room);
  return `${prefix}${name}`;
}
