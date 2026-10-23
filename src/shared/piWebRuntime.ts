import type { PiWebRuntimeIdentity } from "./pluginApiTypes.js";
export type { PiWebRuntimeIdentity } from "./pluginApiTypes.js";

/** Process facts only: PI_WEB_RUNTIME is a launcher preference, not identity. */
export function piWebRuntimeIdentity(versions: { node: string; bun?: string } = process.versions): PiWebRuntimeIdentity {
  return versions.bun === undefined
    ? { name: "node", version: versions.node }
    : { name: "bun", version: versions.bun };
}

/** Optional additive metadata must not invalidate reports from older peers. */
export function parsePiWebRuntimeIdentity(value: unknown): PiWebRuntimeIdentity | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const name: unknown = Reflect.get(value, "name");
  const version: unknown = Reflect.get(value, "version");
  if ((name !== "node" && name !== "bun") || typeof version !== "string" || version === "") return undefined;
  return { name, version };
}
