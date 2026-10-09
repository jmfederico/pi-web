import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SessionUiMetadata } from "@jmfederico/pi-web/plugin-api";
import { isRelayPacketPath, RELAY_METADATA_NAMESPACE, relaySessionName, requireRelayLeg, type RelayIdentity } from "./relayIdentity.js";

const MAX_PACKET_DOCUMENT_BYTES = 256 * 1024;
const PACKET_DOCUMENTS = ["charter.md", "status.md", "log.md"] as const;

export interface RelayDispatchRequest {
  packet: string;
  leg: string;
  cwd?: string;
}

export interface PreparedRelayDispatch {
  cwd: string;
  prompt: string;
  name: string;
  metadata: SessionUiMetadata;
  identity: RelayIdentity;
}

/** Validate the durable packet on disk, not handover prose authored by the caller. */
export async function prepareRelayDispatch(spawningCwd: string, request: RelayDispatchRequest): Promise<PreparedRelayDispatch> {
  const leg = requireRelayLeg(request.leg);
  const cwd = await realpath(resolve(spawningCwd, request.cwd ?? "."));
  if (typeof request.packet !== "string" || request.packet.trim() === "") throw new Error("A saved Relay packet directory is required");
  const packet = await realpath(resolve(cwd, request.packet));
  const packetPath = relative(cwd, packet).split(sep).join("/");
  if (!isRelayPacketPath(packetPath)) throw new Error("Relay packet must be a directory inside the target workspace");
  for (const document of PACKET_DOCUMENTS) await validateDocument(packet, document);
  const identity: RelayIdentity = { version: 1, packetPath, relayName: basename(packet), leg };
  return {
    cwd,
    identity,
    name: relaySessionName(identity),
    metadata: { [RELAY_METADATA_NAMESPACE]: identity },
    prompt: relayHandoverInstructions(cwd, packet, identity),
  };
}

function relayHandoverInstructions(cwd: string, packet: string, identity: RelayIdentity): string {
  return [
    `Continue Relay ${JSON.stringify(identity.relayName)}, leg ${identity.leg}, in ${JSON.stringify(cwd)}.`,
    "Load the `relay` and `relay-runner` skills.",
    `Read ${JSON.stringify(join(packet, "charter.md"))} and ${JSON.stringify(join(packet, "status.md"))}.`,
    "The charter is the agreed goal and status.md is the actual baton. Consult the saved history and supporting documents only as needed; do not substitute dispatch prose for the packet.",
    "Check the finish line against the current work and choose the next useful slice.",
    "Make progress and the record durable, then hand off once, complete, or signal that you need help.",
  ].join("\n");
}

async function validateDocument(packet: string, document: string): Promise<void> {
  const path = await realpath(join(packet, document));
  const inside = relative(packet, path);
  if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) throw new Error(`Relay ${document} must stay inside the packet`);
  const info = await stat(path);
  if (!info.isFile() || info.size === 0 || info.size > MAX_PACKET_DOCUMENT_BYTES) {
    throw new Error(`Relay ${document} must be a non-empty regular file of at most ${String(MAX_PACKET_DOCUMENT_BYTES)} bytes`);
  }
  const file = await open(path, "r");
  try {
    // Bound reads even if another process grows the document after stat.
    const buffer = Buffer.alloc(MAX_PACKET_DOCUMENT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_PACKET_DOCUMENT_BYTES) throw new Error(`Relay ${document} exceeds the document size limit`);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)); }
    catch { throw new Error(`Relay ${document} must be UTF-8 text`); }
    if (text.trim() === "" || text.includes("\0")) throw new Error(`Relay ${document} must contain saved text`);
  } finally {
    await file.close();
  }
}
