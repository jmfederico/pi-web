import type { PiWebComponentStatus, PiWebDeprecatedAgentInput, PiWebInstallationInfo, PiWebRuntimeComponent, PiWebRuntimeResponse, PiWebVersionResponse } from "./apiTypes.js";
import { parseActiveAgentProfileDescriptor } from "./activeAgentProfile.js";
import { parseKnownPiWebCapabilities } from "./capabilities.js";

export function parsePiWebVersionResponse(value: unknown): PiWebVersionResponse | undefined {
  if (!isRecord(value)) return undefined;
  const packageName = value["packageName"];
  const generatedAt = value["generatedAt"];
  const components = value["components"];
  if (typeof packageName !== "string" || packageName === "" || typeof generatedAt !== "string" || generatedAt === "" || !isRecord(components)) return undefined;
  const web = parsePiWebComponentStatus(components["web"]);
  const sessiond = parsePiWebComponentStatus(components["sessiond"]);
  if (web === undefined || sessiond === undefined) return undefined;
  return { packageName, generatedAt, components: { web, sessiond } };
}

export function parsePiWebRuntimeResponse(value: unknown): PiWebRuntimeResponse | undefined {
  if (!isRecord(value)) return undefined;
  const packageName = value["packageName"];
  const generatedAt = value["generatedAt"];
  const components = value["components"];
  const capabilities = parseKnownPiWebCapabilities(value["capabilities"]);
  if (typeof packageName !== "string" || packageName === "" || typeof generatedAt !== "string" || generatedAt === "" || !isRecord(components) || capabilities === undefined) return undefined;
  const web = parsePiWebRuntimeComponent(components["web"]);
  const sessiond = parsePiWebRuntimeComponent(components["sessiond"]);
  if (web === undefined || sessiond === undefined) return undefined;
  return { packageName, generatedAt, components: { web, sessiond }, capabilities };
}

export function parsePiWebRuntimeComponent(value: unknown): PiWebRuntimeComponent | undefined {
  if (!isRecord(value)) return undefined;
  const component = value["component"];
  const label = value["label"];
  const runtimeVersion = value["runtimeVersion"];
  const piVersion = value["piVersion"];
  const available = value["available"];
  const capabilities = parseKnownPiWebCapabilities(value["capabilities"]);
  const activeAgentProfileValue = value["activeAgentProfile"];
  const activeAgentProfile = activeAgentProfileValue === undefined ? undefined : parseActiveAgentProfileDescriptor(activeAgentProfileValue);
  const deprecatedAgentInputs = parseDeprecatedAgentInputs(value["deprecatedAgentInputs"]);
  const error = value["error"];
  if (component !== "web" && component !== "sessiond") return undefined;
  if (typeof label !== "string" || label === "" || typeof available !== "boolean" || capabilities === undefined) return undefined;
  if (activeAgentProfileValue !== undefined && (component !== "sessiond" || activeAgentProfile === undefined)) return undefined;
  return {
    component,
    label,
    ...(typeof runtimeVersion === "string" ? { runtimeVersion } : {}),
    ...(typeof piVersion === "string" ? { piVersion } : {}),
    available,
    capabilities,
    ...(activeAgentProfile === undefined ? {} : { activeAgentProfile }),
    ...(deprecatedAgentInputs === undefined ? {} : { deprecatedAgentInputs }),
    ...(typeof error === "string" ? { error } : {}),
  };
}

/**
 * Parse deprecated agent-configuration inputs reported by another component or
 * machine. The payload only feeds an advisory warning banner, so malformed
 * entries are dropped rather than failing the whole runtime snapshot: a
 * cross-version peer must never blank a machine's runtime over a warning.
 * Returns undefined when the field itself is absent or not an array.
 */
export function parseDeprecatedAgentInputs(value: unknown): PiWebDeprecatedAgentInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const inputs: PiWebDeprecatedAgentInput[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const source = entry["source"];
    const name = entry["name"];
    const replacement = entry["replacement"];
    if (source !== "environment" && source !== "config") continue;
    if (typeof name !== "string" || name === "") continue;
    if (replacement !== undefined && (typeof replacement !== "string" || replacement === "")) continue;
    inputs.push({ source, name, ...(replacement === undefined ? {} : { replacement }) });
  }
  return inputs;
}

export function parsePiWebComponentStatus(value: unknown): PiWebComponentStatus | undefined {
  if (!isRecord(value)) return undefined;
  const component = value["component"];
  const label = value["label"];
  const runtimeVersion = value["runtimeVersion"];
  const installedVersion = value["installedVersion"];
  const piVersion = value["piVersion"];
  const stale = value["stale"];
  const available = value["available"];
  const error = value["error"];
  const installation = parsePiWebInstallationInfo(value["installation"]);
  if (component !== "web" && component !== "sessiond") return undefined;
  if (typeof label !== "string" || label === "" || typeof stale !== "boolean" || typeof available !== "boolean") return undefined;
  return {
    component,
    label,
    ...(typeof runtimeVersion === "string" ? { runtimeVersion } : {}),
    ...(typeof installedVersion === "string" ? { installedVersion } : {}),
    ...(typeof piVersion === "string" ? { piVersion } : {}),
    stale,
    available,
    ...(installation === undefined ? {} : { installation }),
    ...(typeof error === "string" ? { error } : {}),
  };
}

export function parsePiWebInstallationInfo(value: unknown): PiWebInstallationInfo | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value["kind"];
  const path = value["path"];
  const source = value["source"];
  const scope = value["scope"];
  const npmRoot = value["npmRoot"];
  const dockerMode = value["dockerMode"];
  if (kind !== "pi-package" && kind !== "npm-global" && kind !== "local" && kind !== "docker" && kind !== "unknown") return undefined;
  return {
    kind,
    ...(typeof path === "string" ? { path } : {}),
    ...(typeof source === "string" ? { source } : {}),
    ...(scope === "user" || scope === "project" ? { scope } : {}),
    ...(typeof npmRoot === "string" ? { npmRoot } : {}),
    ...(dockerMode === "runtime" || dockerMode === "dev" ? { dockerMode } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
