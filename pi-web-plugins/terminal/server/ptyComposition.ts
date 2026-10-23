import { createBunPtyProvider, inspectBunPtyCapability } from "./bunPtyProvider.js";
import { createNodePtyProvider, inspectNodePtyCapability } from "./nodePtyProvider.js";
import type { PtyProvider } from "./ptyProvider.js";

/** Startup prerequisite probe using the selected provider's APIs/loaders. Never activates the service or allocates a PTY. */
export function inspectPtyProvider(): { kind: "node" | "bun"; supported: boolean; reason?: string } {
  if (process.versions["bun"] === undefined) return { kind: "node", ...inspectNodePtyCapability() };
  return { kind: "bun", ...inspectBunPtyCapability() };
}

export function createDefaultPtyProvider(): PtyProvider {
  return process.versions["bun"] === undefined ? createNodePtyProvider() : createBunPtyProvider();
}
